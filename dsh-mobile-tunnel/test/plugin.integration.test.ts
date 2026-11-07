import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { buildApp } from '../../server/src/app.js';
import { createPool } from '../../server/src/db/pool.js';
import { defaultMigrationsDir, runMigrations } from '../../server/src/db/migrate.js';
import { TunnelRegistry } from '../../server/src/tunnel/registry.js';
import { createTempDatabase } from '../../server/test/helpers/db.js';
import { makeTestAuthConfig } from '../../server/test/helpers/auth.js';
import { TunnelAgent } from '../src/agent.js';
import { MemoryCredentialStore } from '../src/storage.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(intervalMs);
  }
  throw new Error('条件等待超时');
}

interface BrowserSession {
  accessToken: string;
  email: string;
}

describe('桌面插件 dsh-mobile-tunnel（T08）', () => {
  let db: Awaited<ReturnType<typeof createTempDatabase>>;
  let pool: ReturnType<typeof createPool>;
  let app: ReturnType<typeof buildApp>;
  let registry: TunnelRegistry;
  let serverUrl: string;
  let dshServer: Server;
  let dshWss: WebSocketServer;
  let dshBaseUrl: string;
  let browser: BrowserSession;
  let store: MemoryCredentialStore;
  let agent: TunnelAgent;

  before(async () => {
    db = await createTempDatabase();
    pool = createPool({ databaseUrl: db.url });
    await runMigrations(pool);
    registry = new TunnelRegistry({
      pool,
      jwtSecret: makeTestAuthConfig().jwtSecret,
      heartbeatSec: 2,
      offlineSec: 10,
    });
    app = buildApp({
      pool,
      migrationsDir: defaultMigrationsDir(),
      authConfig: makeTestAuthConfig(),
      tunnelRegistry: registry,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    serverUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    // 模拟本机 DSH：/connect 换 Cookie、/api 需要 Cookie、/api/remote.mux 为 WS 回声
    dshServer = createServer((request, response) => {
      const url = request.url ?? '/';
      if (url.startsWith('/connect')) {
        response.writeHead(302, { location: '/', 'set-cookie': 'dsh-auth-test=ok; Path=/; HttpOnly' });
        response.end();
        return;
      }
      const cookie = request.headers.cookie ?? '';
      if (!cookie.includes('dsh-auth-test=ok')) {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('unauthorized');
        return;
      }
      if (url.startsWith('/api/session/list')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"sessions":[]}');
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });
    dshWss = new WebSocketServer({ server: dshServer });
    dshWss.on('connection', (socket) => {
      socket.on('message', (data) => socket.send(data));
    });
    await new Promise<void>((resolve) => dshServer.listen(0, '127.0.0.1', () => resolve()));
    dshBaseUrl = `http://127.0.0.1:${(dshServer.address() as AddressInfo).port}`;

    // 浏览器侧：注册 + 登录（插件登录时由测试代替用户确认设备码）
    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'plugin@example.com', password: 'Str0ng-Passw0rd-2026' },
    });
    assert.equal(register.statusCode, 201);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'plugin@example.com',
        password: 'Str0ng-Passw0rd-2026',
        clientType: 'mobile',
        device: { name: '浏览器', platform: 'ios', signPublicKey: 's', ecdhPublicKey: 'e' },
      },
    });
    browser = { accessToken: (login.json() as { accessToken: string }).accessToken, email: 'plugin@example.com' };

    store = new MemoryCredentialStore();
    let pendingUserCode = '';
    agent = new TunnelAgent(
      {
        serverBaseUrl: serverUrl,
        dshBaseUrl,
        deviceName: '插件测试PC',
        platform: 'win32',
        credentialPath: 'unused',
        panelSessionPath: 'unused-panel-session.json',
        launchToken: async () => 'launch-token-test',
      },
      {
        store,
        backoffBaseMs: 50,
        authOptions: {
          onUserCode: (info) => {
            pendingUserCode = info.userCode;
          },
          openBrowser: async () => {
            const approved = await app.inject({
              method: 'POST',
              url: '/v1/auth/device-code/approve',
              headers: { authorization: `Bearer ${browser.accessToken}` },
              payload: { userCode: pendingUserCode, decision: 'approve' },
            });
            assert.equal(approved.statusCode, 200);
          },
        },
      },
    );
  });

  after(async () => {
    agent?.stop();
    await app.close();
    await new Promise<void>((resolve) => dshWss.close(() => resolve()));
    await new Promise<void>((resolve) => dshServer.close(() => resolve()));
    await pool.end().catch(() => undefined);
    await db.drop();
  });

  test('设备码登录：注册设备并建立隧道（online）', async () => {
    const state = await agent.login();
    assert.equal(state.status === 'online' || state.status === 'offline', true, JSON.stringify(state));
    await waitUntil(() => agent.getState().status === 'online');

    const credentials = await store.load();
    assert.ok(credentials);
    assert.ok(credentials.deviceId);
    assert.ok(credentials.signPublicKey.length > 20);
    assert.ok(credentials.signPrivateKeyPem.includes('PRIVATE KEY'));

    const devices = await app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${browser.accessToken}` },
    });
    const list = devices.json() as { devices: Array<{ id: string; kind: string; name: string; online: boolean }> };
    const device = list.devices.find((item) => item.id === credentials.deviceId);
    assert.ok(device);
    assert.equal(device.kind, 'desktop');
    assert.equal(device.name, '插件测试PC');
    assert.equal(device.online, true);
  });

  test('代理 /t/<id>/api/* 转发到本机 DSH 并注入 Cookie（200 而非 401）', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    const response = await fetch(`${serverUrl}/t/${credentials.deviceId}/api/session/list`, {
      headers: { cookie: `dsh_access=${encodeURIComponent(browser.accessToken)}` },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"sessions":[]}');
  });

  test('WebSocket 代理经插件转发到本机 DSH', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    const socket = new WebSocket(
      `${serverUrl.replace(/^http/, 'ws')}/t/${credentials.deviceId}/api/remote.mux?token=${encodeURIComponent(browser.accessToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const received = new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
    socket.send('hello-plugin');
    assert.equal(await received, 'hello-plugin');
    socket.close(1000, 'done');
  });

  test('大消息经 wsdata 分片双向完整传输（超过原 2 MiB 帧上限）', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    const socket = new WebSocket(
      `${serverUrl.replace(/^http/, 'ws')}/t/${credentials.deviceId}/api/remote.mux?token=${encodeURIComponent(browser.accessToken)}`,
      { maxPayload: 16 * 1024 * 1024 },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const payload = Buffer.alloc(3 * 1024 * 1024);
      for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 29 + 3) % 256;
      const received = new Promise<Buffer>((resolve) => {
        socket.once('message', (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
      });
      socket.send(payload);
      const echoed = await received;
      assert.equal(echoed.length, payload.length);
      assert.ok(echoed.equals(payload), '3 MiB 消息应完整回显');
    } finally {
      socket.close(1000, 'done');
    }
  });

  test('并发大消息经分片重组后互不串扰', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    const socket = new WebSocket(
      `${serverUrl.replace(/^http/, 'ws')}/t/${credentials.deviceId}/api/remote.mux?token=${encodeURIComponent(browser.accessToken)}`,
      { maxPayload: 16 * 1024 * 1024 },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const first = Buffer.alloc(2 * 1024 * 1024, 0x61);
      const second = Buffer.alloc(1536 * 1024, 0x62);
      const received: Buffer[] = [];
      socket.on('message', (data) => {
        received.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
      socket.send(first);
      socket.send(second);

      await waitUntil(() => received.length >= 2, 15_000);
      assert.equal(received.length, 2);
      assert.deepEqual(
        received.map((buffer) => buffer.length).sort((a, b) => a - b),
        [first.length, second.length].sort((a, b) => a - b),
      );
      for (const buffer of received) {
        const expected = buffer.length === first.length ? first : second;
        assert.ok(buffer.equals(expected), '两条并发消息内容应各自完整');
      }
    } finally {
      socket.close(1000, 'done');
    }
  });

  test('断线后自动重连（退避 ≤ 30 秒）并恢复 online', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    registry.close(); // 模拟服务端/网络侧断开（非替换/撤销）
    await waitUntil(() => agent.getState().status !== 'online', 3000);
    await waitUntil(() => agent.getState().status === 'online', 8000);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${browser.accessToken}` },
    });
    const device = (after.json() as { devices: Array<{ id: string; online: boolean }> }).devices.find(
      (item) => item.id === credentials.deviceId,
    );
    assert.equal(device?.online, true);
  });

  test('登出后设备离线且本地令牌被清除', async () => {
    const credentials = await store.load();
    assert.ok(credentials);
    await agent.logout();
    assert.equal(await store.load(), null);
    await sleep(500);
    const devices = await app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${browser.accessToken}` },
    });
    const list = (devices.json() as { devices: Array<{ id: string; online: boolean }> }).devices;
    const device = list.find((item) => item.id === credentials.deviceId);
    assert.equal(device?.online, false);
  });

  test('冷启动：有本地凭据则静默恢复上线', async () => {
    // 重新登录一次，然后用同一 store 新建 agent 模拟重启
    await agent.login();
    await waitUntil(() => agent.getState().status === 'online');
    agent.stop();

    const restored = new TunnelAgent(
      {
        serverBaseUrl: serverUrl,
        dshBaseUrl,
        deviceName: '插件测试PC',
        platform: 'win32',
        credentialPath: 'unused',
        panelSessionPath: 'unused-panel-session.json',
        launchToken: async () => 'launch-token-test',
      },
      { store, backoffBaseMs: 50 },
    );
    try {
      await restored.autostart();
      await waitUntil(() => restored.getState().status === 'online');
      assert.equal(restored.getState().status, 'online');
    } finally {
      restored.stop();
    }
  });
});
