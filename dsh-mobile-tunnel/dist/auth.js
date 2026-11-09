import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function apiUrl(base, path) {
    return `${base.replace(/\/$/, '')}${path}`;
}
async function postJson(fetchImpl, url, body, token) {
    return fetchImpl(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
}
export async function requestDeviceCode(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await postJson(fetchImpl, apiUrl(options.serverBaseUrl, '/v1/auth/device-code'), {
        deviceName: options.deviceName,
        platform: options.platform,
    });
    if (response.status !== 200) {
        throw new Error(`申请设备码失败（HTTP ${response.status}）：${await response.text()}`);
    }
    return (await response.json());
}
/** 轮询设备码直到用户确认/拒绝/过期。 */
export async function pollDeviceToken(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? defaultSleep;
    const deadline = Date.now() + (options.maxWaitMs ?? 10 * 60 * 1000);
    let intervalMs = Math.max(200, (options.interval ?? 2) * 1000);
    while (Date.now() < deadline) {
        const response = await postJson(fetchImpl, apiUrl(options.serverBaseUrl, '/v1/auth/device-token'), {
            deviceCode: options.deviceCode,
        });
        if (response.status === 200)
            return (await response.json());
        const payload = (await response.json().catch(() => ({})));
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
export function generateDeviceKeys() {
    const sign = generateKeyPairSync('ed25519');
    const ecdh = generateKeyPairSync('x25519');
    return {
        signPublicKey: sign.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        ecdhPublicKey: ecdh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        signPrivateKeyPem: sign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        ecdhPrivateKeyPem: ecdh.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
}
export async function registerDevice(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await postJson(fetchImpl, apiUrl(options.serverBaseUrl, '/v1/devices'), {
        name: options.deviceName,
        platform: options.platform,
        appVersion: options.appVersion ?? '0.1.0',
        signPublicKey: options.keys.signPublicKey,
        ecdhPublicKey: options.keys.ecdhPublicKey,
    }, options.accessToken);
    if (response.status === 409) {
        // 设备已存在（例如登出后重新登录）：复用同账号同平台同名设备
        const listResponse = await fetchImpl(apiUrl(options.serverBaseUrl, '/v1/devices'), {
            headers: { authorization: `Bearer ${options.accessToken}` },
        });
        if (listResponse.status === 200) {
            const list = (await listResponse.json());
            const existing = list.devices.find((device) => device.name === options.deviceName && device.platform === options.platform);
            if (existing)
                return existing;
        }
        throw new Error(`登记设备失败：同名设备已存在（HTTP 409）`);
    }
    if (response.status !== 201 && response.status !== 200) {
        throw new Error(`登记设备失败（HTTP ${response.status}）：${await response.text()}`);
    }
    const body = (await response.json());
    return body.device;
}
export async function refreshTokens(serverBaseUrl, refreshToken, fetchImpl = fetch) {
    const response = await postJson(fetchImpl, apiUrl(serverBaseUrl, '/v1/auth/refresh'), { refreshToken });
    if (response.status !== 200)
        throw new Error(`刷新令牌失败（HTTP ${response.status}）`);
    return (await response.json());
}
/**
 * 申请一次性隧道票据（规格 §11 / R06）：票据绑定账号+会话+设备，默认 60 秒有效、消费即失效。
 * 建链前用当前 access token 换取，重连时重新申请。
 */
export async function requestTunnelTicket(serverBaseUrl, accessToken, fetchImpl = fetch, deviceId) {
    const response = await postJson(fetchImpl, apiUrl(serverBaseUrl, '/v1/tunnel/ticket'), deviceId ? { deviceId } : {}, accessToken);
    if (response.status !== 200) {
        throw new Error(`申请隧道票据失败（HTTP ${response.status}）：${await response.text()}`);
    }
    const body = (await response.json());
    if (!body.ticket)
        throw new Error('申请隧道票据失败：响应缺少 ticket');
    return body.ticket;
}
/**
 * 用账号级会话为某台设备换取**设备会话**。
 *
 * 面板登录拿到的是网页会话（无设备），不能直接申请隧道票据、刷新频率也低；
 * 登记设备后用本接口换一条绑定该设备的会话，隧道才能长期稳定重连。
 */
export async function requestDeviceSession(serverBaseUrl, accessToken, deviceId, fetchImpl = fetch) {
    const response = await postJson(fetchImpl, apiUrl(serverBaseUrl, `/v1/devices/${encodeURIComponent(deviceId)}/session`), {}, accessToken);
    if (response.status !== 200) {
        throw new Error(`换取设备会话失败（HTTP ${response.status}）：${await response.text()}`);
    }
    const body = (await response.json());
    if (!body.accessToken || !body.refreshToken || !body.deviceId) {
        throw new Error('换取设备会话失败：响应缺少令牌');
    }
    return {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        deviceId: body.deviceId,
        expiresIn: body.expiresIn ?? 0,
    };
}
/** 完整设备码登录：申请 → 打开浏览器 → 轮询 → 生成密钥 → 登记设备。 */
/** 默认浏览器打开确认页（未注入 openBrowser 时使用；失败不阻断登录）。 */
function openUrlInBrowser(url) {
    try {
        const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        const child = spawn(command, args, { detached: true, stdio: 'ignore' });
        child.unref();
    }
    catch {
        // 由调用方提示用户手动打开 verificationUrl
    }
}
export async function loginWithDeviceCode(options) {
    const code = await requestDeviceCode(options);
    options.onUserCode?.({ userCode: code.userCode, verificationUrl: code.verificationUrl });
    if (options.openBrowser)
        await options.openBrowser(code.verificationUrl);
    else
        openUrlInBrowser(code.verificationUrl);
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
//# sourceMappingURL=auth.js.map