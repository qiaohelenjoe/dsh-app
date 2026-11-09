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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('面板登录后登记本机设备', () => {
  test('没有本机设备时创建设备并保存凭据', async () => {
    const store = new MemoryCredentialStore();
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/devices') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ devices: [] });
      }
      if (url.endsWith('/v1/devices') && init?.method === 'POST') {
        return jsonResponse(
          { device: { id: 'device-new', name: 'PC-A', kind: 'desktop', platform: 'win32' } },
          201,
        );
      }
      if (url.endsWith('/session') && init?.method === 'POST') {
        return jsonResponse({ accessToken: 'dev-access', refreshToken: 'dev-refresh', deviceId: 'device-new', expiresIn: 900 });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const agent = new TunnelAgent(config, { store, fetchImpl });
    try {
      const result = await agent.adoptPanelSession({
        accessToken: 'access',
        refreshToken: 'refresh',
        email: 'a@example.com',
      });
      assert.equal(result.deviceId, 'device-new');
      assert.equal(result.reused, false);
      const saved = await store.load();
      assert.equal(saved?.deviceId, 'device-new');
      assert.equal(saved?.accountEmail, 'a@example.com');
      assert.ok(saved?.signPrivateKeyPem.includes('PRIVATE KEY'));
      assert.ok(calls.some((call) => call === 'POST http://127.0.0.1:9/v1/devices'));
    } finally {
      agent.stop();
    }
  });

  test('已有本机设备时复用，不重复登记', async () => {
    const store = new MemoryCredentialStore();
    await store.save({
      deviceId: 'device-existing',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      signPublicKey: 'pub',
      ecdhPublicKey: 'ecdh',
      signPrivateKeyPem: 'private',
      ecdhPrivateKeyPem: 'ecdh-private',
      accountEmail: 'a@example.com',
    });
    let postCount = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input).endsWith('/v1/devices') && init?.method === 'POST') {
        postCount += 1;
        return jsonResponse({ device: { id: 'should-not-happen' } }, 201);
      }
      if (String(input).endsWith('/session') && init?.method === 'POST') {
        return jsonResponse({ accessToken: 'dev-access', refreshToken: 'dev-refresh', deviceId: 'device-existing', expiresIn: 900 });
      }
      return jsonResponse({ devices: [] });
    }) as typeof fetch;

    const agent = new TunnelAgent(config, { store, fetchImpl });
    try {
      const result = await agent.adoptPanelSession({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        email: 'a@example.com',
      });
      assert.equal(result.deviceId, 'device-existing');
      assert.equal(result.reused, true);
      assert.equal(postCount, 0, '复用已有设备时不应再 POST /v1/devices');
      const saved = await store.load();
      // 复用已有设备后换到新的设备会话（不再是面板网页会话）
      assert.equal(saved?.accessToken, 'dev-access');
      assert.equal(saved?.deviceId, 'device-existing');
    } finally {
      agent.stop();
    }
  });

  test('配额不足时抛出服务端错误信息', async () => {
    const store = new MemoryCredentialStore();
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.endsWith('/v1/devices') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ devices: [] });
      }
      return jsonResponse({ error: { code: 'authz.device_quota_exceeded', message: '设备数量已达上限（2 台）' } }, 403);
    }) as typeof fetch;

    const agent = new TunnelAgent(config, { store, fetchImpl });
    try {
      await assert.rejects(
        () =>
          agent.adoptPanelSession({ accessToken: 'a', refreshToken: 'r', email: 'a@example.com' }),
        /设备数量已达上限/,
      );
    } finally {
      agent.stop();
    }
  });
});
