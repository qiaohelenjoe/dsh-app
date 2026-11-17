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

describe('刷新令牌单飞', () => {
  test('并发刷新只发一次请求，两个调用拿到同一新令牌', async () => {
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

    let refreshCalls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/refresh')) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(
          JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 900 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const agent = new TunnelAgent(config, { store, fetchImpl });
    // 直接把凭据装进实例（绕开 autostart 的隧道连接）
    (agent as unknown as { credentials: unknown }).credentials = await store.load();
    const refresh = (agent as unknown as { refreshCredentials(): Promise<string | null> })
      .refreshCredentials.bind(agent);
    try {
      const [first, second] = await Promise.all([refresh(), refresh()]);
      assert.equal(refreshCalls, 1, '并发刷新应只发一次请求');
      assert.equal(first, 'new-access');
      assert.equal(second, 'new-access');
      const saved = await store.load();
      assert.equal(saved?.refreshToken, 'new-refresh');
    } finally {
      agent.stop();
    }
  });
});
