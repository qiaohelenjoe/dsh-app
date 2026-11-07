import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import type { StoredCredentials } from './storage.js';

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokens {
  account: { id: string; email: string; displayName: string | null };
  device: { id: string; name: string; kind: string; platform: string };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface DeviceKeys {
  signPublicKey: string;
  ecdhPublicKey: string;
  signPrivateKeyPem: string;
  ecdhPrivateKeyPem: string;
}

export interface DeviceAuthOptions {
  serverBaseUrl: string;
  deviceName: string;
  platform: 'win32' | 'darwin' | 'linux';
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void> | void;
  onUserCode?: (info: { userCode: string; verificationUrl: string }) => void;
  maxWaitMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function apiUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function requestDeviceCode(options: DeviceAuthOptions): Promise<DeviceCodeResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await postJson(fetchImpl, apiUrl(options.serverBaseUrl, '/v1/auth/device-code'), {
    deviceName: options.deviceName,
    platform: options.platform,
  });
  if (response.status !== 200) {
    throw new Error(`申请设备码失败（HTTP ${response.status}）：${await response.text()}`);
  }
  return (await response.json()) as DeviceCodeResponse;
}

/** 轮询设备码直到用户确认/拒绝/过期。 */
export async function pollDeviceToken(
  options: DeviceAuthOptions & { deviceCode: string; interval?: number },
): Promise<DeviceTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + (options.maxWaitMs ?? 10 * 60 * 1000);
  let intervalMs = Math.max(200, (options.interval ?? 2) * 1000);

  while (Date.now() < deadline) {
    const response = await postJson(fetchImpl, apiUrl(options.serverBaseUrl, '/v1/auth/device-token'), {
      deviceCode: options.deviceCode,
    });
    if (response.status === 200) return (await response.json()) as DeviceTokens;

    const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    const code = payload.error?.code;
    if (response.status === 202 || code === 'auth.device_code_pending') {
      await sleep(intervalMs);
      continue;
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      await sleep(Math.max(intervalMs, retryAfter * 1000));
      continue;
    }
    if (response.status === 403 || code === 'auth.device_code_denied') {
      throw new Error('用户拒绝了本次授权');
    }
    if (response.status === 410 || code === 'auth.device_code_expired') {
      throw new Error('设备码已过期，请重新登录');
    }
    throw new Error(`轮询设备码失败（HTTP ${response.status}）：${JSON.stringify(payload)}`);
  }
  throw new Error('等待设备码授权超时');
}

export function generateDeviceKeys(): DeviceKeys {
  const sign = generateKeyPairSync('ed25519');
  const ecdh = generateKeyPairSync('x25519');
  return {
    signPublicKey: sign.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    ecdhPublicKey: ecdh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    signPrivateKeyPem: sign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ecdhPrivateKeyPem: ecdh.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export async function registerDevice(
  options: {
    serverBaseUrl: string;
    accessToken: string;
    deviceName: string;
    platform: string;
    appVersion?: string;
    keys: DeviceKeys;
    fetchImpl?: typeof fetch;
  },
): Promise<{ id: string; name: string; kind: string; platform: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await postJson(
    fetchImpl,
    apiUrl(options.serverBaseUrl, '/v1/devices'),
    {
      name: options.deviceName,
      platform: options.platform,
      appVersion: options.appVersion ?? '0.1.0',
      signPublicKey: options.keys.signPublicKey,
      ecdhPublicKey: options.keys.ecdhPublicKey,
    },
    options.accessToken,
  );
  if (response.status === 409) {
    // 设备已存在（例如登出后重新登录）：复用同账号同平台同名设备
    const listResponse = await fetchImpl(apiUrl(options.serverBaseUrl, '/v1/devices'), {
      headers: { authorization: `Bearer ${options.accessToken}` },
    });
    if (listResponse.status === 200) {
      const list = (await listResponse.json()) as {
        devices: Array<{ id: string; name: string; kind: string; platform: string }>;
      };
      const existing = list.devices.find(
        (device) => device.name === options.deviceName && device.platform === options.platform,
      );
      if (existing) return existing;
    }
    throw new Error(`登记设备失败：同名设备已存在（HTTP 409）`);
  }
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`登记设备失败（HTTP ${response.status}）：${await response.text()}`);
  }
  const body = (await response.json()) as { device: { id: string; name: string; kind: string; platform: string } };
  return body.device;
}

export async function refreshTokens(
  serverBaseUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await postJson(fetchImpl, apiUrl(serverBaseUrl, '/v1/auth/refresh'), { refreshToken });
  if (response.status !== 200) throw new Error(`刷新令牌失败（HTTP ${response.status}）`);
  return (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
}

/**
 * 申请一次性隧道票据（规格 §11 / R06）：票据绑定账号+会话+设备，默认 60 秒有效、消费即失效。
 * 建链前用当前 access token 换取，重连时重新申请。
 */
export async function requestTunnelTicket(
  serverBaseUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await postJson(fetchImpl, apiUrl(serverBaseUrl, '/v1/tunnel/ticket'), {}, accessToken);
  if (response.status !== 200) {
    throw new Error(`申请隧道票据失败（HTTP ${response.status}）：${await response.text()}`);
  }
  const body = (await response.json()) as { ticket?: string };
  if (!body.ticket) throw new Error('申请隧道票据失败：响应缺少 ticket');
  return body.ticket;
}

/** 完整设备码登录：申请 → 打开浏览器 → 轮询 → 生成密钥 → 登记设备。 */

/** 默认浏览器打开确认页（未注入 openBrowser 时使用；失败不阻断登录）。 */
function openUrlInBrowser(url: string): void {
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // 由调用方提示用户手动打开 verificationUrl
  }
}
export async function loginWithDeviceCode(options: DeviceAuthOptions): Promise<StoredCredentials> {
  const code = await requestDeviceCode(options);
  options.onUserCode?.({ userCode: code.userCode, verificationUrl: code.verificationUrl });
  if (options.openBrowser) await options.openBrowser(code.verificationUrl);
  else openUrlInBrowser(code.verificationUrl);

  const tokens = await pollDeviceToken({ ...options, deviceCode: code.deviceCode, interval: code.interval });
  const keys = generateDeviceKeys();
  const device = await registerDevice({
    serverBaseUrl: options.serverBaseUrl,
    accessToken: tokens.accessToken,
    deviceName: options.deviceName,
    platform: options.platform,
    keys,
    fetchImpl: options.fetchImpl,
  });

  return {
    deviceId: device.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accountEmail: tokens.account.email,
    ...keys,
  };
}
