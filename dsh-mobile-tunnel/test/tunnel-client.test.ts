import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { TunnelClient, type TunnelStatus } from '../src/tunnel.js';

interface Harness {
  server: WebSocketServer;
  port: number;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function startServer(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    server,
    port: address.port,
    sockets,
    async close(): Promise<void> {
      for (const socket of sockets) {
        try {
          socket.terminate();
        } catch {
          // 忽略
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function makeClient(
  port: number,
  options: {
    connectTimeoutMs?: number;
    keepaliveMs?: number;
    deadAfterMs?: number;
    networkWatchMs?: number;
    listNetworkAddresses?: () => string[];
    onStatus?: (status: TunnelStatus, detail?: string) => void;
  } = {},
): { client: TunnelClient; logs: string[] } {
  const logs: string[] = [];
  const client = new TunnelClient({
    serverBaseUrl: `http://127.0.0.1:${port}`,
    deviceId: 'device-1',
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => 'token',
    getTunnelTicket: async () => 'ticket',
    forwardLocalRequest: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
    openLocalWebSocket: async () => ({
      send(): void {},
      close(): void {},
    }),
    connectTimeoutMs: options.connectTimeoutMs ?? 300,
    keepaliveMs: options.keepaliveMs ?? 40,
    deadAfterMs: options.deadAfterMs ?? 150,
    networkWatchMs: options.networkWatchMs ?? 40,
    ...(options.listNetworkAddresses ? { listNetworkAddresses: options.listNetworkAddresses } : {}),
    log: (message) => logs.push(message),
    ...(options.onStatus ? { onStatusChange: options.onStatus } : {}),
  });
  return { client, logs };
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('条件等待超时'));
      }
    }, 10);
  });
}

describe('TunnelClient 连接可靠性', () => {
  test('握手一直不完成时按 connectTimeout 强制重建', async () => {
    const harness = await startServer();
    // 接受连接但永不发送 registered，模拟弱网/NAT 黑洞
    const { client, logs } = makeClient(harness.port, { connectTimeoutMs: 80 });
    try {
      client.start();
      await waitFor(() => logs.some((line) => line.includes('connect-timeout')), 2000);
      assert.ok(logs.some((line) => line.includes('连接超时')), '应记录连接超时');
      const diagnostics = client.getDiagnostics();
      assert.equal(diagnostics.online, false);
      assert.equal(diagnostics.lastError, 'connect-timeout');
      assert.equal(diagnostics.connectTimeoutMs, 80);
    } finally {
      client.stop();
      await harness.close();
    }
  });

  test('注册成功后上线；长时间无入站帧触发 keepalive 重建', async () => {
    const harness = await startServer();
    harness.server.on('connection', (socket) => {
      socket.send(JSON.stringify({ t: 'registered', deviceId: 'device-1', heartbeatSec: 25, protocol: 2 }));
      // 之后保持沉默：客户端必须靠自身看门狗发现死连接
    });
    const { client, logs } = makeClient(harness.port, { keepaliveMs: 40, deadAfterMs: 120 });
    try {
      client.start();
      await waitFor(() => client.getDiagnostics().online, 2000);
      assert.equal(client.getDiagnostics().status, 'online');
      await waitFor(
        () => client.getDiagnostics().lastError === 'keepalive-timeout' || logs.some((line) => line.includes('判定连接已死')),
        3000,
      );
      assert.equal(client.getDiagnostics().lastError, 'keepalive-timeout');
      assert.equal(client.getDiagnostics().online, false);
    } finally {
      client.stop();
      await harness.close();
    }
  });

  test('检测到网卡地址变化时立即重连', async () => {
    const harness = await startServer();
    let addresses = ['eth0:192.168.1.2'];
    harness.server.on('connection', (socket) => {
      socket.send(JSON.stringify({ t: 'registered', deviceId: 'device-1', heartbeatSec: 25, protocol: 2 }));
    });
    const { client, logs } = makeClient(harness.port, {
      networkWatchMs: 30,
      keepaliveMs: 10_000,
      deadAfterMs: 20_000,
      listNetworkAddresses: () => addresses,
    });
    try {
      client.start();
      await waitFor(() => client.getDiagnostics().online, 2000);
      addresses = ['wlan0:192.168.1.9'];
      await waitFor(() => logs.some((line) => line.includes('network-changed')), 3000);
      assert.equal(client.getDiagnostics().lastError, 'network-changed');
    } finally {
      client.stop();
      await harness.close();
    }
  });
});
