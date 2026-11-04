import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.js';
import { TunnelRegistry } from '../src/tunnel/registry.js';
import { DEFAULT_MAX_FRAME_BYTES, type WsDataFrame } from '../src/tunnel/protocol.js';
import { WsFragmentReassembler, fragmentWsData } from '../src/tunnel/ws-fragment.js';
import { createTempDatabase, type TempDatabase } from './helpers/db.js';
import { loginAccount, makeTestAuthConfig, registerAccount, type AccountSession } from './helpers/auth.js';
import { issueTunnelTicket, tunnelSocketUrl } from './helpers/tunnel.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 10000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(intervalMs);
  }
  throw new Error('条件等待超时');
}

/** 模拟桌面端本机的 DSH WS 服务（回声）。 */
class UpstreamServer {
  readonly wss: WebSocketServer;
  readonly connections: Array<{ path: string; socket: WebSocket; closeCode: number | null; messages: string[] }> = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('error', (error) => console.error('[test] upstream server error:', error.message));
    this.wss.on('connection', (socket, request) => {
      const record = { path: request.url ?? '', socket, closeCode: null as number | null, messages: [] as string[] };
      this.connections.push(record);
      socket.on('message', (data) => {
        record.messages.push(data.toString());
        socket.send(data);
      });
      socket.on('close', (code) => {
        record.closeCode = code;
      });
    });
  }

  async ready(): Promise<void> {
    if (this.port !== 0) return;
    await new Promise<void>((resolve) => this.wss.once('listening', () => resolve()));
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0;
  }

  get last(): { path: string; socket: WebSocket; closeCode: number | null; messages: string[] } | undefined {
    return this.connections[this.connections.length - 1];
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

interface Frame {
  t: string;
  [key: string]: unknown;
}

/** 假隧道客户端：处理 registered/ping/req，并把 wsopen 落到真实 UpstreamServer。 */
class FakeTunnel {
  readonly frames: Frame[] = [];
  private readonly waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  readonly channels = new Map<string, WebSocket>();
  readonly receivedCloseFrames: Array<{ id: string; code: number }> = [];
  closeCode: number | null = null;
  /** 收到的（服务端→插件）分片帧数。 */
  inboundFragmentFrames = 0;
  /** 发出的（插件→服务端）分片帧数。 */
  outboundFragmentFrames = 0;
  private readonly reassembler = new WsFragmentReassembler();
  private messageCounter = 0;

  constructor(
    readonly socket: WebSocket,
    private readonly upstream: UpstreamServer,
    private readonly chunkBytes = 256 * 1024,
  ) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (!this.dispatch(frame)) {
        this.frames.push(frame);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    });
    socket.on('close', (code) => {
      this.closeCode = code;
      this.reassembler.reset();
      for (const channel of this.channels.values()) channel.terminate();
      this.channels.clear();
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame));
  }

  private dispatch(frame: Frame): boolean {
    if (frame.t === 'ping') {
      this.send({ t: 'pong' });
      return true;
    }
    if (frame.t === 'req') {
      this.send({ t: 'res', id: frame['id'], status: 200, body: Buffer.from('ok').toString('base64'), more: false });
      return true;
    }
    if (frame.t === 'wsopen') {
      void this.openChannel(frame);
      return true;
    }
    if (frame.t === 'wsdata') {
      const id = frame['id'] as string;
      const channel = this.channels.get(id);
      if (!channel) return true;
      if (frame['mid'] !== undefined) this.inboundFragmentFrames += 1;
      const result = this.reassembler.accept(id, frame as unknown as WsDataFrame);
      if (result.status === 'complete') {
        channel.send(result.data, { binary: result.binary });
      } else if (result.status === 'rejected') {
        channel.close(1009, 'wsdata rejected');
        this.channels.delete(id);
      }
      return true;
    }
    if (frame.t === 'wsclose') {
      const id = frame['id'] as string;
      const code = (frame['code'] as number) ?? 1000;
      this.receivedCloseFrames.push({ id, code });
      const channel = this.channels.get(id);
      if (channel) channel.close(code === 1006 || code === 1005 ? 1000 : code, (frame['reason'] as string) ?? '');
      this.channels.delete(id);
      return true;
    }
    return false;
  }

  private async openChannel(frame: Frame): Promise<void> {
    const id = frame['id'] as string;
    const path = frame['path'] as string;
    const channel = new WebSocket(`ws://127.0.0.1:${this.upstream.port}${path}`);
    channel.on('open', () => {
      this.channels.set(id, channel);
      this.send({ t: 'wsopen', id, ok: true });
    });
    channel.on('message', (data, isBinary) => {
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const messageId = `fm_${++this.messageCounter}`;
      for (const fragment of fragmentWsData({ channelId: id, messageId, data: payload, binary: isBinary, chunkBytes: this.chunkBytes })) {
        if (fragment.mid !== undefined) this.outboundFragmentFrames += 1;
        this.send(fragment as unknown as Record<string, unknown>);
      }
    });
    channel.on('close', (code, reason) => {
      this.channels.delete(id);
      this.send({ t: 'wsclose', id, code, reason: reason.toString() });
    });
    channel.on('error', (error) => {
      // CI 上曾出现 UpstreamServer 连不上导致整组超时，留下原因便于定位
      console.error('[test] upstream ws error:', (error as Error).message);
      this.send({ t: 'wsopen', id, ok: false, status: 502, reason: 'upstream error' });
    });
  }

  nextFrame(predicate: (frame: Frame) => boolean, timeoutMs = 10000): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing) {
      this.frames.splice(this.frames.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          this.frames.splice(this.frames.indexOf(frame), 1);
          resolve(frame);
        },
      });
    });
  }
}

interface WsTestContext {
  db: TempDatabase;
  pool: ReturnType<typeof createPool>;
  app: ReturnType<typeof buildApp>;
  registry: TunnelRegistry;
  upstream: UpstreamServer;
  session: AccountSession;
  tunnel: FakeTunnel;
  port: number;
  close(): Promise<void>;
}

interface WsContextOptions {
  maxInflight?: number;
  maxWsPerDevice?: number;
  withTunnel?: boolean;
  wsChunkBytes?: number;
  wsMaxMessageBytes?: number;
  wsReassemblyTimeoutMs?: number;
}

async function createWsContext(options: WsContextOptions = {}): Promise<WsTestContext> {
  const db = await createTempDatabase();
  const pool = createPool({ databaseUrl: db.url });
  await runMigrations(pool);
  const upstream = new UpstreamServer();
  await upstream.ready();

  const registry = new TunnelRegistry({
    pool,
    jwtSecret: makeTestAuthConfig().jwtSecret,
    heartbeatSec: 1,
    offlineSec: 30,
    maxInflight: options.maxInflight ?? 32,
    ...(options.maxWsPerDevice !== undefined ? { maxWsPerDevice: options.maxWsPerDevice } : {}),
    ...(options.wsChunkBytes !== undefined ? { wsChunkBytes: options.wsChunkBytes } : {}),
    ...(options.wsMaxMessageBytes !== undefined ? { wsMaxMessageBytes: options.wsMaxMessageBytes } : {}),
    ...(options.wsReassemblyTimeoutMs !== undefined ? { wsReassemblyTimeoutMs: options.wsReassemblyTimeoutMs } : {}),
  });
  const app = buildApp({
    pool,
    migrationsDir: defaultMigrationsDir(),
    authConfig: makeTestAuthConfig(),
    tunnelRegistry: registry,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  const holder = { app };
  await registerAccount(holder);
  const session = await loginAccount(holder);

  let tunnel!: FakeTunnel;
  if (options.withTunnel !== false) {
    const ticket = await issueTunnelTicket(app, session);
    const socket = new WebSocket(tunnelSocketUrl(port, ticket));
    tunnel = new FakeTunnel(socket, upstream, options.wsChunkBytes ?? 256 * 1024);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    // 协议 v2：服务端据此启用 wsdata 分片。
    tunnel.send({ t: 'register', deviceId: session.deviceId, protocol: 2 });
    await tunnel.nextFrame((frame) => frame.t === 'registered');
  }

  return {
    db,
    pool,
    app,
    registry,
    upstream,
    session,
    tunnel,
    port,
    async close(): Promise<void> {
      await app.close();
      await upstream.close();
      await pool.end().catch(() => undefined);
      await db.drop();
    },
  };
}

function clientUrl(ctx: WsTestContext, path = '/api/remote.mux', token = ctx.session.accessToken): string {
  const separator = path.includes('?') ? '&' : '?';
  return `ws://127.0.0.1:${ctx.port}/t/${ctx.session.deviceId}${path}${separator}token=${encodeURIComponent(token)}`;
}

function connectClient(
  ctx: WsTestContext,
  path = '/api/remote.mux',
): { socket: WebSocket; opened: Promise<void>; closeInfo: Promise<{ code: number; reason: string }> } {
  const socket = new WebSocket(clientUrl(ctx, path));
  const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) =>
      reject(new Error(`升级被拒绝: ${response.statusCode}`)),
    );
  });
  return { socket, opened, closeInfo };
}

describe('隧道 WebSocket 代理（T06）', () => {
  test('客户端升级成功（101），路径与查询串正确转发到桌面端', async () => {
    const ctx = await createWsContext();
    try {
      const client = connectClient(ctx, '/api/remote.mux?x=1');
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);
      assert.equal(ctx.upstream.last?.path, '/api/remote.mux?x=1');
      client.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('双向各 20 条消息，顺序与内容一致', async () => {
    const ctx = await createWsContext();
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      const received: string[] = [];
      client.socket.on('message', (data) => received.push(data.toString()));

      const fromClient = Array.from({ length: 20 }, (_, index) => `c-${index}`);
      for (const message of fromClient) client.socket.send(message);
      await waitUntil(() => received.length >= 20);
      assert.deepEqual(received.slice(0, 20), fromClient);

      const upstreamSocket = ctx.upstream.last?.socket;
      assert.ok(upstreamSocket);
      const fromUpstream = Array.from({ length: 20 }, (_, index) => `u-${index}`);
      for (const message of fromUpstream) upstreamSocket.send(message);
      await waitUntil(() => received.length >= 40);
      assert.deepEqual(received.slice(20, 40), fromUpstream);

      client.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('客户端关闭（1000）传播到桌面端；桌面端关闭反向传播', async () => {
    const ctx = await createWsContext();
    try {
      const first = connectClient(ctx);
      await first.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);
      first.socket.close(1000, 'bye');
      const firstClose = await first.closeInfo;
      assert.equal(firstClose.code, 1000);
      await waitUntil(() => ctx.upstream.connections[0]?.closeCode !== null);
      assert.equal(ctx.upstream.connections[0]?.closeCode, 1000);

      const second = connectClient(ctx);
      await second.opened;
      await waitUntil(() => ctx.upstream.connections.length === 2);
      const upstreamSocket = ctx.upstream.last?.socket;
      assert.ok(upstreamSocket);
      upstreamSocket.close(4001, 'upstream-bye');
      const secondClose = await second.closeInfo;
      assert.equal(secondClose.code, 4001);
    } finally {
      await ctx.close();
    }
  });

  test('异常断开（1006）两端都被记录，且通道被清理', async () => {
    const ctx = await createWsContext();
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);
      const upstreamRecord = ctx.upstream.connections[0];
      assert.ok(upstreamRecord);

      client.socket.terminate();
      await waitUntil(() => ctx.tunnel.receivedCloseFrames.length > 0);
      assert.equal(ctx.tunnel.receivedCloseFrames[0]?.code, 1006);
      await waitUntil(() => ctx.registry.wsChannelCount(ctx.session.deviceId) === 0);
      // 桌面端侧连接已被关闭（收到 1006 后 fake tunnel 以 1000 正常关闭本地上游）
      await waitUntil(() => upstreamRecord.closeCode !== null);
    } finally {
      await ctx.close();
    }
  });

  test('WS 通道不计入 HTTP 并发窗口；单设备 WS 上限生效', async () => {
    const ctx = await createWsContext({ maxInflight: 1, maxWsPerDevice: 2 });
    try {
      const first = connectClient(ctx);
      await first.opened;
      const second = connectClient(ctx);
      await second.opened;
      await waitUntil(() => ctx.upstream.connections.length === 2);

      // HTTP 并发窗口为 1，但 2 条 WS 打开时仍可发 HTTP 请求
      const response = await ctx.registry.request(ctx.session.deviceId, {
        method: 'GET',
        path: '/api/session/list',
        headers: {},
        body: null,
      });
      assert.equal(response.status, 200);

      const third = connectClient(ctx);
      const error = await third.opened.then(
        () => null,
        (reason: unknown) => reason as Error,
      );
      assert.ok(error, '第三条 WS 应被拒绝');
      assert.match(error.message, /503/);

      first.socket.close(1000, 'done');
      second.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('未注册/离线设备升级返回 503；无 token 返回 401', async () => {
    const ctx = await createWsContext({ withTunnel: false });
    try {
      const offline = connectClient(ctx);
      const offlineError = await offline.opened.then(
        () => null,
        (reason: unknown) => reason as Error,
      );
      assert.ok(offlineError);
      assert.match(offlineError.message, /503/);

      const noToken = new WebSocket(`ws://127.0.0.1:${ctx.port}/t/${ctx.session.deviceId}/api/remote.mux`);
      const status = await new Promise<number>((resolve, reject) => {
        noToken.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
        noToken.on('error', reject);
      });
      assert.equal(status, 401);
    } finally {
      await ctx.close();
    }
  });

  test('客户端帧超限时断开并审计', async () => {
    const ctx = await createWsContext();
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      client.socket.send('x'.repeat(DEFAULT_MAX_FRAME_BYTES + 64 * 1024));
      const close = await client.closeInfo;
      assert.equal(close.code, 1009);

      await waitUntil(() => ctx.registry.wsChannelCount(ctx.session.deviceId) === 0);
      let audits: Array<{ count: string }> = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await ctx.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'tunnel.frame_too_large'`,
        );
        audits = result.rows;
        if (audits[0]?.count === '1') break;
        await sleep(40);
      }
      assert.equal(audits[0]?.count, '1');
    } finally {
      await ctx.close();
    }
  });

  test('大消息双向分片传输：浏览器→设备→浏览器内容完整', async () => {
    const ctx = await createWsContext({ wsChunkBytes: 16 * 1024 });
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      const payload = Buffer.alloc(300 * 1024);
      for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 13 + 7) % 256;

      const echoed = new Promise<Buffer>((resolve) => {
        client.socket.once('message', (data) =>
          resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)),
        );
      });
      client.socket.send(payload);
      const received = await echoed;

      assert.equal(received.length, payload.length);
      assert.ok(received.equals(payload), '回程内容应与发送内容一致');
      // 两个方向都应实际发生分片（300 KiB / 16 KiB > 1 片）。
      assert.ok(ctx.tunnel.inboundFragmentFrames > 1, '服务端→设备方向应分片');
      assert.ok(ctx.tunnel.outboundFragmentFrames > 1, '设备→服务端方向应分片');
      client.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('同一通道并发大消息按 mid 区分且全部完整返回', async () => {
    const ctx = await createWsContext({ wsChunkBytes: 8 * 1024 });
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      const first = Buffer.alloc(120 * 1024, 0x41);
      const second = Buffer.alloc(90 * 1024, 0x42);
      const received: Buffer[] = [];
      client.socket.on('message', (data) => {
        received.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      client.socket.send(first);
      client.socket.send(second);

      await waitUntil(() => received.length >= 2, 5000);
      assert.equal(received.length, 2);
      assert.deepEqual(
        received.map((buffer) => buffer.length).sort((a, b) => a - b),
        [second.length, first.length].sort((a, b) => a - b),
      );
      for (const buffer of received) {
        const expected = buffer.length === first.length ? first : second;
        assert.ok(buffer.equals(expected));
      }
      client.socket.close(1000, 'done');
    } finally {
      await ctx.close();
    }
  });

  test('设备→浏览器半成品超时后关闭通道、清理并审计', async () => {
    const ctx = await createWsContext({ wsChunkBytes: 8 * 1024, wsReassemblyTimeoutMs: 120 });
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      const channelId = [...ctx.tunnel.channels.keys()][0];
      assert.ok(channelId, '应已建立桌面端本地 WS 通道');
      const payload = Buffer.alloc(32 * 1024, 0x43);
      const [firstFragment] = [
        ...fragmentWsData({
          channelId,
          messageId: 'm_lost',
          data: payload,
          binary: false,
          chunkBytes: 8 * 1024,
        }),
      ];
      assert.ok(firstFragment);
      ctx.tunnel.send(firstFragment as unknown as Record<string, unknown>);

      const close = await client.closeInfo;
      assert.equal(close.code, 1009);
      await waitUntil(() => ctx.registry.wsChannelCount(ctx.session.deviceId) === 0);
      await waitUntil(() => ctx.tunnel.receivedCloseFrames.length > 0);
      assert.equal(ctx.tunnel.receivedCloseFrames[0]?.code, 1009);

      let audits: Array<{ count: string }> = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await ctx.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'tunnel.ws_fragment_timeout'`,
        );
        audits = result.rows;
        if (audits[0]?.count === '1') break;
        await sleep(40);
      }
      assert.equal(audits[0]?.count, '1');
    } finally {
      await ctx.close();
    }
  });

  test('浏览器消息超过单条上限时拒绝并关闭通道', async () => {
    const ctx = await createWsContext({ wsChunkBytes: 8 * 1024, wsMaxMessageBytes: 64 * 1024 });
    try {
      const client = connectClient(ctx);
      await client.opened;
      await waitUntil(() => ctx.upstream.connections.length === 1);

      client.socket.send(Buffer.alloc(128 * 1024, 0x44));
      const close = await client.closeInfo;
      assert.equal(close.code, 1009);
      await waitUntil(() => ctx.tunnel.receivedCloseFrames.length > 0);
      assert.equal(ctx.tunnel.receivedCloseFrames[0]?.code, 1009);
      await waitUntil(() => ctx.registry.wsChannelCount(ctx.session.deviceId) === 0);
    } finally {
      await ctx.close();
    }
  });
});
