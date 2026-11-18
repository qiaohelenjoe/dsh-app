import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TunnelAgent } from '../src/agent.js';
import { MemoryCredentialStore } from '../src/storage.js';

const config = {
  serverBaseUrl: 'http://127.0.0.1:9',
  dshBaseUrl: 'http://127.0.0.1:8',
  deviceName: 'PC-A',
  platform: 'win32' as const,
  credentialPath: '/tmp/never-used.json',
  panelSessionPath: '/tmp/never-used-panel.json',
};

async function seededStore(): Promise<MemoryCredentialStore> {
  const store = new MemoryCredentialStore();
  await store.save({
    deviceId: 'device-1',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    signPublicKey: 'pub',
    ecdhPublicKey: 'ecdh',
    signPrivateKeyPem: 'private',
    ecdhPrivateKeyPem: 'ecdh-private',
    accountEmail: 'a@example.com',
  });
  return store;
}

describe('刷新失败的自愈与退避', () => {
  test('429 时按 Retry-After 冷却，冷却期内不再发刷新请求', async () => {
    const store = await seededStore();
    let refreshCalls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/refresh')) {
        refreshCalls += 1;
        return new Response(JSON.stringify({ error: { code: 'rate_limit.exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const agent = new TunnelAgent(config, { store, fetchImpl });
    (agent as unknown as { credentials: unknown }).credentials = await store.load();
    // 自愈路径会调用 startTunnel：测试里让它空转，避免真实 WebSocket 重连定时器占住进程
    (agent as unknown as { startTunnel(): void }).startTunnel = () => {};
    const refresh = (agent as unknown as { refreshCredentials(): Promise<string | null> })
      .refreshCredentials.bind(agent);
    try {
      assert.equal(await refresh(), null);
      assert.equal(await refresh(), null);
      assert.equal(refreshCalls, 1, '冷却期内不应再次请求刷新');
    } finally {
      agent.stop();
    }
  });

  test('刷新返回 401 时用面板会话自动重新登记设备', async () => {
    const store = await seededStore();
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/auth/refresh')) {
        return new Response(JSON.stringify({ error: { code: 'auth.token_invalid' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/devices') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ devices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/devices') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ device: { id: 'device-new', name: 'PC-A', kind: 'desktop', platform: 'win32' } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/session') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            accessToken: 'healed-access',
            refreshToken: 'healed-refresh',
            deviceId: 'device-new',
            expiresIn: 900,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const agent = new TunnelAgent(config, {
      store,
      fetchImpl,
      panelSession: async () => ({
        accessToken: 'panel-access',
        refreshToken: 'panel-refresh',
        email: 'a@example.com',
      }),
    });
    (agent as unknown as { credentials: unknown }).credentials = await store.load();
    // 自愈路径会调用 startTunnel：测试里让它空转，避免真实 WebSocket 重连定时器占住进程
    (agent as unknown as { startTunnel(): void }).startTunnel = () => {};
    const refresh = (agent as unknown as { refreshCredentials(): Promise<string | null> })
      .refreshCredentials.bind(agent);
    try {
      const healed = await refresh();
      assert.equal(healed, 'healed-access');
      const saved = await store.load();
      // 同账号已有设备：复用原设备（device-1），只换到新的设备会话
      assert.equal(saved?.deviceId, 'device-1');
      assert.equal(saved?.accessToken, 'healed-access');
      assert.ok(calls.some((call) => call.startsWith('POST') && call.includes('/v1/devices')));
    } finally {
      agent.stop();
    }
  });
});
