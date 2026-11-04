import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function debugLog(message) {
    if (process.env.DSH_MOBILE_TUNNEL_DEBUG !== '1')
        return;
    try {
        appendFileSync(join(tmpdir(), 'dsh-mobile-tunnel-debug.log'), `${new Date().toISOString()} ${message}\n`);
    }
    catch {
        // 调试日志失败不影响主流程
    }
}
const FORWARD_DROP_HEADERS = new Set([
    'host',
    'cookie',
    'authorization',
    'connection',
    'upgrade',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'accept-encoding',
]);
/**
 * 用 DSH 启动令牌完成一次 `/connect?token=…&interactions=none` 交换，换取浏览器 Cookie。
 * 与第三方插件同原理，但由本项目实现（spec §8）。
 */
export class LaunchTokenCookieProvider {
    options;
    cookie = null;
    inflight = null;
    constructor(options) {
        this.options = options;
    }
    async getCookie() {
        if (this.cookie)
            return this.cookie;
        if (this.inflight)
            return this.inflight;
        this.inflight = this.exchange();
        try {
            this.cookie = await this.inflight;
            return this.cookie;
        }
        finally {
            this.inflight = null;
        }
    }
    invalidate() {
        this.cookie = null;
    }
    async exchange() {
        const token = await this.options.launchToken();
        if (!token) {
            debugLog('exchange: launchToken 为空，无法换 Cookie');
            return null;
        }
        const fetchImpl = this.options.fetchImpl ?? fetch;
        const baseUrl = typeof this.options.dshBaseUrl === 'function' ? this.options.dshBaseUrl() : this.options.dshBaseUrl;
        const base = baseUrl.replace(/\/$/, '');
        // 注意：/connect 返回的是 v2（API operator）Cookie，DSH 首页/API 的浏览器会话需要
        // 由 `GET /?token=` 直接铸造的 v1 Cookie；先用 v1，失败再回退 /connect。
        let response;
        try {
            response = await fetchImpl(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
            const firstCookies = typeof response.headers.getSetCookie === 'function'
                ? response.headers.getSetCookie()
                : [response.headers.get('set-cookie') ?? ''].filter(Boolean);
            if (firstCookies.length === 0) {
                response = await fetchImpl(`${base}/connect?token=${encodeURIComponent(token)}&interactions=none`, { redirect: 'manual' });
            }
        }
        catch (error) {
            debugLog(`exchange: 请求失败 base=${base} err=${error.message} cause=${String(error.cause ?? '')}`);
            throw error;
        }
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie') ?? ''].filter(Boolean);
        const authCookies = setCookies
            .map((line) => line.split(';')[0]?.trim() ?? '')
            .filter((pair) => pair.startsWith('dsh-auth-'));
        debugLog(`exchange: status=${response.status} base=${base} cookies=${authCookies.length}`);
        if (authCookies.length === 0)
            return null;
        return authCookies.join('; ');
    }
}
/** 把隧道的 `req` 帧转发到本机 DSH：注入 Cookie、改写 Host/Origin、保留响应结构。 */
export function createLocalDshForwarder(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const resolveBase = () => (typeof options.dshBaseUrl === 'function' ? options.dshBaseUrl() : options.dshBaseUrl).replace(/\/$/, '');
    const send = async (input, cookie) => {
        const base = resolveBase();
        const origin = new URL(base).origin;
        const headers = {};
        for (const [name, value] of Object.entries(input.headers ?? {})) {
            if (!FORWARD_DROP_HEADERS.has(name.toLowerCase()))
                headers[name] = value;
        }
        // DSH 的 browser-trust 围栏要求 Origin/Host 与本机 authority 一致
        headers.origin = origin;
        headers.accept = headers.accept ?? 'application/json';
        if (cookie)
            headers.cookie = cookie;
        const response = await fetchImpl(`${base}${input.path}`, {
            method: input.method,
            headers,
            body: input.body && input.body.length > 0 ? input.body : undefined,
            redirect: 'manual',
        });
        try {
            const cookieName = (cookie ?? '').split('=')[0] ?? '';
            debugLog(`forward: base=${base} path=${input.path} status=${response.status} cookieName=${cookieName}`);
        }
        catch {
            // 忽略
        }
        return response;
    };
    return async (input) => {
        let cookie = await options.cookieProvider.getCookie();
        let response = await send(input, cookie);
        if (response.status === 401) {
            // 凭据可能失效：重新交换一次 Cookie 后重试
            options.cookieProvider.invalidate();
            cookie = await options.cookieProvider.getCookie();
            response = await send(input, cookie);
        }
        const headers = {};
        for (const [name, value] of response.headers.entries())
            headers[name] = value;
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, headers, body };
    };
}
//# sourceMappingURL=dsh-credentials.js.map