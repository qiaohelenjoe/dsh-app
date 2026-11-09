import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TunnelControl } from '../src/devices/tunnel-hooks.js';
import {
  authHeader,
  createAuthTestContext,
  loginAccount,
  registerAccount,
  type AccountSession,
} from './helpers/auth.js';

interface DeviceView {
  id: string;
  kind: string;
  name: string;
  platform: string;
  online: boolean;
  connected?: boolean;
  lastSeenAt: string | null;
  appVersion: string | null;
  createdAt: string;
}
interface DeviceBody {
  device: DeviceView;
}
interface DevicesBody {
  devices: DeviceView[];
}
interface ErrorBody {
  error: { code: string };
}

function devicePayload(name: string, platform = 'android'): Record<string, unknown> {
  return { name, platform, appVersion: '1.0.0', signPublicKey: 'sign-key', ecdhPublicKey: 'ecdh-key' };
}

async function listDevices(
  ctx: Awaited<ReturnType<typeof createAuthTestContext>>,
  session: AccountSession,
): Promise<Awaited<ReturnType<typeof ctx.app.inject>>> {
  return ctx.app.inject({ method: 'GET', url: '/v1/devices', headers: authHeader(session) });
}

describe('设备 API（T03）', () => {
  test('列表只返回本账号设备，并含 online（90 秒判定）', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx, 'a@example.com');
      await registerAccount(ctx, 'b@example.com');
      const sessionA = await loginAccount(ctx, { email: 'a@example.com', deviceName: 'iPhone A', platform: 'ios' });
      const sessionB = await loginAccount(ctx, { email: 'b@example.com', deviceName: 'iPhone B', platform: 'ios' });

      const response = await listDevices(ctx, sessionA);
      assert.equal(response.statusCode, 200);
      const { devices } = response.json() as DevicesBody;
      assert.equal(devices.length, 1);
      assert.equal(devices[0]?.id, sessionA.deviceId);
      assert.equal(devices[0]?.online, true);
      assert.ok(devices[0]?.lastSeenAt);
      assert.ok(!devices.some((device) => device.id === sessionB.deviceId), '不应返回其他账号设备');
    } finally {
      await ctx.close();
    }
  });

  test('在线真值：活跃隧道会话覆盖数据库时间窗', async () => {
    let liveDeviceId: string | null = null;
    const tunnel: TunnelControl = {
      disconnectDevice(): void {},
      isOnline: (deviceId: string): boolean => deviceId === liveDeviceId,
    };
    const ctx = await createAuthTestContext({}, { tunnel });
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);
      // 数据库时间窗已过期：仅靠 last_seen_at 会判离线
      await ctx.pool.query("UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [
        session.deviceId,
      ]);
      liveDeviceId = session.deviceId;
      const response = await listDevices(ctx, session);
      assert.equal(response.statusCode, 200);
      const device = (response.json() as DevicesBody).devices.find((item) => item.id === session.deviceId);
      assert.equal(device?.online, true, '有活跃隧道会话时应判在线');
      assert.equal(device?.connected, true);

      // 会话消失后回落到数据库时间窗：过期即离线
      liveDeviceId = null;
      const after = await listDevices(ctx, session);
      const offlineDevice = (after.json() as DevicesBody).devices.find((item) => item.id === session.deviceId);
      assert.equal(offlineDevice?.online, false);
      assert.equal(offlineDevice?.connected, false);
    } finally {
      await ctx.close();
    }
  });

  test('登记设备 201；同平台同名 409 conflict.device_name_taken', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: devicePayload('我的电脑', 'win32'),
      });
      assert.equal(created.statusCode, 201);
      const body = created.json() as DeviceBody;
      assert.equal(body.device.kind, 'desktop');
      assert.equal(body.device.name, '我的电脑');

      const duplicate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: devicePayload('我的电脑', 'win32'),
      });
      assert.equal(duplicate.statusCode, 409);
      assert.equal((duplicate.json() as ErrorBody).error.code, 'conflict.device_name_taken');
    } finally {
      await ctx.close();
    }
  });

  test('移动端超过 2 台返回 403 authz.device_quota_exceeded', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx); // 登录自带 1 台移动设备

      for (let index = 2; index <= 2; index += 1) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/v1/devices',
          headers: authHeader(session),
          payload: devicePayload(`手机-${index}`, 'android'),
        });
        assert.equal(response.statusCode, 201, `第 ${index} 台应成功：${response.body}`);
      }

      const overflow = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: devicePayload('手机-3', 'android'),
      });
      assert.equal(overflow.statusCode, 403);
      assert.equal((overflow.json() as ErrorBody).error.code, 'authz.device_quota_exceeded');
    } finally {
      await ctx.close();
    }
  });

  test('桌面端超过 2 台返回 403 authz.device_quota_exceeded', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      for (let index = 1; index <= 2; index += 1) {
        const response = await ctx.app.inject({
          method: 'POST',
          url: '/v1/devices',
          headers: authHeader(session),
          payload: devicePayload(`PC-${index}`, 'win32'),
        });
        assert.equal(response.statusCode, 201, `第 ${index} 台应成功：${response.body}`);
      }

      const overflow = await ctx.app.inject({
        method: 'POST',
        url: '/v1/devices',
        headers: authHeader(session),
        payload: devicePayload('PC-3', 'win32'),
      });
      assert.equal(overflow.statusCode, 403);
      assert.equal((overflow.json() as ErrorBody).error.code, 'authz.device_quota_exceeded');
    } finally {
      await ctx.close();
    }
  });

  test('PATCH 改名生效；DELETE 204 且 revoked_at 生效、列表不再返回', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);
      // 另一台设备保持在线，用于在撤销首台设备后仍能列出设备
      const observer = await loginAccount(ctx, {
        deviceName: '工作站',
        platform: 'win32',
        clientType: 'desktop',
      });

      const renamed = await ctx.app.inject({
        method: 'PATCH',
        url: `/v1/devices/${session.deviceId}`,
        headers: authHeader(session),
        payload: { name: '工作站' },
      });
      assert.equal(renamed.statusCode, 200);
      assert.equal((renamed.json() as DeviceBody).device.name, '工作站');

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${session.deviceId}`,
        headers: authHeader(session),
      });
      assert.equal(removed.statusCode, 204);

      const revokedAt = await ctx.pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM devices WHERE id = $1',
        [session.deviceId],
      );
      assert.ok(revokedAt.rows[0]?.revoked_at instanceof Date);

      const listed = await listDevices(ctx, observer);
      assert.equal(listed.statusCode, 200);
      const remaining = (listed.json() as DevicesBody).devices;
      assert.ok(!remaining.some((device) => device.id === session.deviceId), '已撤销设备不应出现在列表');
      assert.equal(remaining.length, 1);

      // 被撤销设备的会话已失效
      const revokedSession = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices',
        headers: authHeader(session),
      });
      assert.equal(revokedSession.statusCode, 401);
    } finally {
      await ctx.close();
    }
  });

  test('撤销级联：该设备全部会话失效', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const first = await loginAccount(ctx);
      const second = await loginAccount(ctx); // 同设备第二次登录，产生第二个会话

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${first.deviceId}`,
        headers: authHeader(first),
      });
      assert.equal(removed.statusCode, 204);

      const otherRefresh = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: second.refreshToken },
      });
      assert.equal(otherRefresh.statusCode, 401);

      const authedAfterRevoke = await ctx.app.inject({
        method: 'GET',
        url: '/v1/devices',
        headers: authHeader(second),
      });
      assert.equal(authedAfterRevoke.statusCode, 401);
    } finally {
      await ctx.close();
    }
  });

  test('跨账号访问设备 ID 返回 403 authz.forbidden', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx, 'a@example.com');
      await registerAccount(ctx, 'b@example.com');
      const sessionA = await loginAccount(ctx, { email: 'a@example.com' });
      const sessionB = await loginAccount(ctx, { email: 'b@example.com' });

      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/v1/devices/${sessionB.deviceId}`,
        headers: authHeader(sessionA),
        payload: { name: '越权改名' },
      });
      assert.equal(patch.statusCode, 403);
      assert.equal((patch.json() as ErrorBody).error.code, 'authz.forbidden');

      const remove = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${sessionB.deviceId}`,
        headers: authHeader(sessionA),
      });
      assert.equal(remove.statusCode, 403);
      assert.equal((remove.json() as ErrorBody).error.code, 'authz.forbidden');
    } finally {
      await ctx.close();
    }
  });

  test('撤销产生一条 device.revoke 审计记录', async () => {
    const ctx = await createAuthTestContext();
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${session.deviceId}`,
        headers: authHeader(session),
      });
      assert.equal(removed.statusCode, 204);

      const audits = await ctx.pool.query<{ action: string; result: string; detail: { revokedSessions: number } }>(
        `SELECT action, result, detail FROM audit_logs
          WHERE action = 'device.revoke' AND device_id = $1`,
        [session.deviceId],
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0]?.result, 'ok');
      assert.equal(audits.rows[0]?.detail.revokedSessions, 1);
    } finally {
      await ctx.close();
    }
  });

  test('撤销时调用隧道断开钩子', async () => {
    const revokedDevices: Array<{ deviceId: string; reason: string }> = [];
    const tunnel: TunnelControl = {
      disconnectDevice(deviceId: string, reason: string): void {
        revokedDevices.push({ deviceId, reason });
      },
    };
    const ctx = await createAuthTestContext({}, { tunnel });
    try {
      await registerAccount(ctx);
      const session = await loginAccount(ctx);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${session.deviceId}`,
        headers: authHeader(session),
      });
      assert.equal(removed.statusCode, 204);
      assert.deepEqual(revokedDevices, [{ deviceId: session.deviceId, reason: 'device-revoked' }]);
    } finally {
      await ctx.close();
    }
  });
});
