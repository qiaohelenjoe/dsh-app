import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createAuthTestContext, loginAccount, registerAccount, TEST_PASSWORD } from './helpers/auth.js';

const NAME_A = 'desktop-lfjstdl';
const NAME_B = 'laptop-office';
const DEVICE_KEYS = { signPublicKey: 'sign-public-key', ecdhPublicKey: 'ecdh-public-key' };

/** 注册一台桌面设备（可带机器短码）。 */
async function registerDevice(ctx: { app: FastifyInstance }, token: string, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'PC-A',
      platform: 'win32',
      ...DEVICE_KEYS,
      ...body,
    },
  });
}

test('同一计算机名称重复注册会复用同一台设备（与名称无关、不占用名额）', async () => {
  const ctx = await createAuthTestContext();
  try {
    await registerAccount(ctx);
    const session = await loginAccount(ctx);

    const first = await registerDevice(ctx, session.accessToken, { name: '家里台式机', machineName: NAME_A });
    assert.equal(first.statusCode, 201);
    const firstId = first.json().device.id as string;

    // 换个名字、同一个码：必须复用，不能新建、不能 403
    const second = await registerDevice(ctx, session.accessToken, { name: '完全不同的名字', machineName: NAME_A });
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().device.id, firstId);
    assert.equal(second.json().device.machineName, NAME_A);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(list.statusCode, 200);
    const devices = list.json().devices as Array<{ id: string; machineName: string | null }>;
    assert.equal(devices.length, 1, '不应新建第二台设备');
    assert.equal(devices[0]?.machineName, NAME_A, '设备列表要下发机器短码');
  } finally {
    await ctx.close();
  }
});

test('历史设备补名：设备会话上报短码后再注册同码即可复用', async () => {
  const ctx = await createAuthTestContext();
  try {
    await registerAccount(ctx);
    const first = await loginAccount(ctx, { deviceName: '旧笔记本' });
    // 老设备先没有码
    const bind = await ctx.app.inject({
      method: 'POST',
      url: '/v1/devices/self/machine-code',
      headers: { authorization: `Bearer ${first.accessToken}` },
      payload: { machineName: NAME_B },
    });
    assert.equal(bind.statusCode, 200);
    assert.equal(bind.json().device.machineName, NAME_B);
    assert.equal(bind.json().device.id, first.deviceId);

    // 之后按码注册 → 复用这台
    const register = await registerDevice(ctx, first.accessToken, { name: '随便改的名字', machineName: NAME_B });
    assert.equal(register.statusCode, 201);
    assert.equal(register.json().device.id, first.deviceId);
  } finally {
    await ctx.close();
  }
});

test('一次性认领：名额已满时把无码历史设备认成当前机器，不新建、不 403', async () => {
  const ctx = await createAuthTestContext();
  try {
    await registerAccount(ctx);
    const desktopA = await loginAccount(ctx, { deviceName: '家里台式机', clientType: 'desktop' });
    const desktopB = await loginAccount(ctx, { deviceName: '单位笔记本', clientType: 'desktop', platform: 'linux' });
    assert.notEqual(desktopA.deviceId, desktopB.deviceId);

    // 面板会话（网页登录，无设备）
    const panel = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/panel-login',
      payload: { email: 'user@example.com', password: TEST_PASSWORD },
    });
    assert.equal(panel.statusCode, 200);
    const panelToken = panel.json().accessToken as string;

    // 名额已满（桌面 2/2），但认领不新建
    const claim = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${desktopA.deviceId}/claim`,
      headers: { authorization: `Bearer ${panelToken}` },
      payload: { machineName: NAME_A },
    });
    assert.equal(claim.statusCode, 200);
    assert.equal(claim.json().device.machineName, NAME_A);
    assert.equal(claim.json().device.id, desktopA.deviceId);

    // 再用同码注册 → 复用这台，不再新建、不 403
    const register = await registerDevice(ctx, panelToken, { name: '本机', machineName: NAME_A });
    assert.equal(register.statusCode, 201);
    assert.equal(register.json().device.id, desktopA.deviceId);

    // 另一台不能被同一码认领
    const conflict = await ctx.app.inject({
      method: 'POST',
      url: `/v1/devices/${desktopB.deviceId}/claim`,
      headers: { authorization: `Bearer ${panelToken}` },
      payload: { machineName: NAME_A },
    });
    assert.equal(conflict.statusCode, 409);
  } finally {
    await ctx.close();
  }
});

test('计算机名称格式非法时返回 400', async () => {
  const ctx = await createAuthTestContext();
  try {
    await registerAccount(ctx);
    const session = await loginAccount(ctx);
    const response = await registerDevice(ctx, session.accessToken, { machineName: 'bad name!' });
    assert.equal(response.statusCode, 400);
  } finally {
    await ctx.close();
  }
});
