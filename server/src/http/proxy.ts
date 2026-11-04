import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../auth/repositories/audit.js';
import { findAccountById } from '../auth/repositories/accounts.js';
import { findSessionById } from '../auth/repositories/sessions.js';
import type { DbPool } from '../db/pool.js';
import { AccessTokenExpiredError, verifyAccessToken } from '../security/tokens.js';
import type { TunnelHttpResponse } from '../tunnel/protocol.js';
import type { TunnelRegistry } from '../tunnel/registry.js';
import { findDeviceForTunnel } from '../tunnel/repository.js';
import { apiErrorBody } from './errors.js';
import { buildLoginRedirect, wantsJson } from './login-redirect.js';

const OFFLINE_HTML = readFileSync(new URL('../../public/device-offline.html', import.meta.url), 'utf8');
const COOKIE_NAME = 'dsh_access';

const PASS_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'range',
  'if-none-match',
  'if-modified-since',
  'cache-control',
];

const PASS_RESPONSE_HEADERS = [
  'content-type',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'content-disposition',
  'vary',
  'accept-ranges',
  'content-range',
  'x-content-type-options',
];

export interface ProxyDeps {
  pool: DbPool;
  jwtSecret: string;
  registry: TunnelRegistry;
}

interface Identity {
  accountId: string;
  sessionId: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

async function authenticate(deps: ProxyDeps, request: FastifyRequest): Promise<Identity | null> {
  const header = request.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const cookies = parseCookies(request.headers.cookie);
  const query = new URL(request.raw.url ?? '/', 'http://localhost').searchParams.get('token');
  const token = bearer || cookies[COOKIE_NAME] || query;
  if (!token) return null;

  let claims;
  try {
    claims = await verifyAccessToken(token, deps.jwtSecret);
  } catch (error) {
    if (error instanceof AccessTokenExpiredError) return null;
    return null;
  }
  const session = await findSessionById(deps.pool, claims.sessionId);
  if (!session || session.account_id !== claims.accountId || session.revoked_at !== null) return null;
  const account = await findAccountById(deps.pool, claims.accountId);
  if (!account || account.status !== 'active') return null;
  return { accountId: claims.accountId, sessionId: claims.sessionId };
}

/** 去掉 token 查询参数（只用于本地鉴权，不转发）。 */
function stripTokenParam(rawPathAndQuery: string): { path: string; search: string } {
  const index = rawPathAndQuery.indexOf('?');
  if (index < 0) return { path: rawPathAndQuery, search: '' };
  const path = rawPathAndQuery.slice(0, index);
  // 必须原样保留查询串：DSH 的插件 URL 形如 `plugins/??@scope/pkg/client.js&rev=...`，
  // 查询串本身以 `?` 开头；用 URLSearchParams 重新编码会把该 `?` 吃掉导致模块 404。
  const search = rawPathAndQuery
    .slice(index + 1)
    .split('&')
    .filter((part) => !/^token=/.test(part))
    .join('&');
  return { path, search };
}

/** 拒绝 `..`、编码绕过、反斜杠与 NUL。 */
function assertSafePath(rawPath: string, requestId: string): void {
  // query 属于上游语义（例如 ?path=G:\repo\docs\a.png），不参与路径检查。
  // 先按原始串切掉 query，再解码：否则 Windows 反斜杠路径会被误判为“非法字符”而 400，
  // 这正是手机端所有文件/文档预览请求失败的根因。
  const rawPathOnly = rawPath.split('?')[0] ?? '';
  let decoded = rawPathOnly;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw Object.assign(new Error('路径编码非法'), { statusCode: 400, proxyRequestId: requestId });
    }
    // 解码后可能还原出 %3F，再切一次，保持 .. 检查对编码绕过的严格性
    const pathOnly = decoded.split('?')[0] ?? '';
    const segments = pathOnly.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
      throw Object.assign(new Error('路径包含非法片段'), { statusCode: 400, proxyRequestId: requestId });
    }
    if (pathOnly.includes('\0') || pathOnly.includes('\\')) {
      throw Object.assign(new Error('路径包含非法字符'), { statusCode: 400, proxyRequestId: requestId });
    }
  }
}

function buildRequestBody(request: FastifyRequest): Buffer | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;
  const body = request.body;
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  // JSON 已被 Fastify 解析为对象：重新序列化后转发（语义等价）
  return Buffer.from(JSON.stringify(body));
}

const NETWORK_PROBE = '<script>(function(){' +
  'if(window.__dshNetLog){return;}var log=window.__dshNetLog=[];' +
  'function add(o){o.t=Date.now();log.push(o);if(log.length>200){log.shift();}}' +
  'var of=window.fetch;if(of){window.fetch=function(input,init){var u=typeof input==="string"?input:(input&&input.url)||"";var s=Date.now();var p=of.apply(this,arguments);p.then(function(r){add({kind:"fetch",url:String(u).slice(0,200),status:r.status,ms:Date.now()-s});},function(e){add({kind:"fetch",url:String(u).slice(0,200),status:0,ms:Date.now()-s,err:String(e).slice(0,120)});});return p;};}' +
  'var xo=XMLHttpRequest.prototype.open;var xs=XMLHttpRequest.prototype.send;' +
  'XMLHttpRequest.prototype.open=function(m,u){this.__dshNet={kind:"xhr",url:String(u).slice(0,200)};return xo.apply(this,arguments);};' +
  'XMLHttpRequest.prototype.send=function(){var x=this;var s=Date.now();this.addEventListener("loadend",function(){var o=x.__dshNet||{kind:"xhr"};o.status=x.status;o.ms=Date.now()-s;add(o);});return xs.apply(this,arguments);};' +
  'var W=window.WebSocket;if(W){window.WebSocket=function(u,p){var ws=p?new W(u,p):new W(u);var rec={kind:"ws",url:String(u).slice(0,200)};add(Object.assign({},rec,{event:"open"}));ws.addEventListener("close",function(e){add(Object.assign({},rec,{event:"close",code:e.code,reason:String(e.reason||"").slice(0,80)}));});return ws;};window.WebSocket.prototype=W.prototype;window.WebSocket.OPEN=W.OPEN;window.WebSocket.CLOSED=W.CLOSED;}' +
  '})();<\/script>';

const WEBVIEW_POLYFILL = '<script>(function(){' +
  'if(typeof Promise.withResolvers!=="function"){Promise.withResolvers=function(){var resolve,reject;var promise=new Promise(function(res,rej){resolve=res;reject=rej;});return {promise:promise,resolve:resolve,reject:reject};};}' +
  'if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.any!=="function"){AbortSignal.any=function(signals){var c=new AbortController();var list=Array.prototype.slice.call(signals);var abort=function(){var r;for(var i=0;i<list.length;i++){if(list[i].aborted){r=list[i].reason;break;}}c.abort(r);};for(var i=0;i<list.length;i++){if(list[i].aborted){abort();return c.signal;}list[i].addEventListener("abort",abort,{once:true});}return c.signal;};}' +
  'if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.timeout!=="function"){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException("TimeoutError","TimeoutError"));},ms);return c.signal;};}' +
  'if(!Array.prototype.findLast){Object.defineProperty(Array.prototype,"findLast",{value:function(fn,thisArg){for(var i=this.length-1;i>=0;i--){if(fn.call(thisArg,this[i],i,this)){return this[i];}}return undefined;},configurable:true,writable:true});}' +
  'if(!Array.prototype.findLastIndex){Object.defineProperty(Array.prototype,"findLastIndex",{value:function(fn,thisArg){for(var i=this.length-1;i>=0;i--){if(fn.call(thisArg,this[i],i,this)){return i;}}return -1;},configurable:true,writable:true});}' +
  '})();<\/script>';

/**
 * DSH 的 Remote 通道用 `document.baseURI` 解析 `/api/remote.mux`
 * （见 DSH 客户端 lib/types/stream-protocol.js 的 remoteStreamUrl）。
 * 代理为了让 DSH 前端按根路径工作，会把 `<base href>` 改写成 `/`；于是该地址落到域名根，
 * 浏览器不会带上 Path=/t/<deviceId> 的 Cookie，服务端既取不到设备也取不到令牌，
 * 文件资源（workspaceFiles）、文档预览等依赖 Remote 的功能会全部报“服务不可用”。
 *
 * DSH 官方扩展点 `__DSH_TRANSPORT__.streamBaseUrl` 专门用于指定 Gateway 的 WebSocket 基址
 * （HTTP 传输独立选择，不受影响）。这里把它固定到当前挂载前缀。
 */
function transportBootstrap(prefix: string): string {
  const basePath = prefix === '' || prefix === '/' ? '/' : `${prefix.replace(/\/$/, '')}/`;
  return (
    '<script>(function(){var t=window.__DSH_TRANSPORT__||{};' +
    // 必须是绝对 URL：DSH 用 new URL('api/remote.mux', streamBaseUrl) 解析，
    // 相对路径会抛 TypeError: Invalid URL，前端连重试都不会发出请求。
    `t.streamBaseUrl=location.origin+${JSON.stringify(basePath)};` +
    'window.__DSH_TRANSPORT__=t;})();<\/script>'
  );
}

export function rewriteHtml(text: string, prefix: string): string {
  const withPolyfill = text.replace(
    /<head([^>]*)>/i,
    '<head$1>' + WEBVIEW_POLYFILL + transportBootstrap(prefix),
  );
  return withPolyfill
    // DSH 前端用 location.pathname 拼 API/WebSocket；base 必须保持 "/"
    .replace(/<base\s+href=(["'])[^"']*\1\s*\/?>/i, '<base href="__DSH_BASE__">')
    // 先处理根绝对路径，再处理相对路径，避免二次加前缀
    .replace(/\b(href|src)=(["'])\/(?!\/)/g, `$1=$2${prefix}/`)
    .replace(/\b(href|src)=(["'])\.\//g, `$1=$2${prefix}/`)
    // 裸相对路径：<link rel=preload href="plugins/...">
    .replace(/\b(href|src)=(["'])plugins\//g, `$1=$2${prefix}/plugins/`)
    .replace(/"url":"plugins\//g, `"url":"${prefix}/plugins/`)
    .replace(/url\((["']?)\/(?!\/)/g, `url($1${prefix}/`)
    .replace('__DSH_BASE__', '/');
}
function rewriteCss(text: string, prefix: string): string {
  return text.replace(/url\((["']?)\/(?!\/)/g, `url($1${prefix}/`);
}

function rewriteJavaScript(text: string, prefix: string): string {
  // 仅改写常见的根绝对字符串字面量，避免破坏其它字符串
  return text.replace(/(["'])\/(api|assets|favicon|manifest)/g, `$1${prefix}/$2`);
}

function rewriteResponseBody(body: Buffer, contentType: string, prefix: string): Buffer {
  const type = contentType.toLowerCase();
  if (type.includes('text/html')) return Buffer.from(rewriteHtml(body.toString('utf8'), prefix));
  if (type.includes('text/css')) return Buffer.from(rewriteCss(body.toString('utf8'), prefix));
  if (type.includes('javascript') || type.includes('ecmascript')) {
    return Buffer.from(rewriteJavaScript(body.toString('utf8'), prefix));
  }
  return body;
}

function rewriteLocation(location: string, prefix: string): string {
  if (!location.startsWith('/') || location.startsWith('//')) return location;
  return `${prefix}${location}`;
}

function rewriteSetCookies(value: string, prefix: string): string {
  return value
    .split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
    .map((cookie) => {
      if (/;\s*path=/i.test(cookie)) return cookie.replace(/;\s*path=[^;]*/i, `; Path=${prefix}`);
      return `${cookie}; Path=${prefix}`;
    })
    .join(', ');
}

function sendOffline(request: FastifyRequest, reply: FastifyReply, requestId: string): FastifyReply {
  if (wantsJson(request.headers)) {
    return reply.code(503).send(apiErrorBody('tunnel.device_offline', '设备不在线，请确认电脑上的 DSH 已启动', requestId));
  }
  return reply.code(503).type('text/html; charset=utf-8').send(OFFLINE_HTML);
}

type ProxyDeniedReason = 'unauthenticated' | 'unknown_device' | 'cross_account' | 'path_denied' | 'tunnel_offline';

/**
 * 代理拒绝审计（规格 §11）：只记录 method 与不含查询串的路径，
 * 绝不记录令牌、Cookie 或请求体。审计写入失败只记日志，不改变原有响应。
 */
async function auditProxyDenied(
  deps: ProxyDeps,
  request: FastifyRequest,
  input: { reason: ProxyDeniedReason; accountId: string | null; deviceId: string | null },
): Promise<void> {
  const pathname = new URL(request.raw.url ?? '/', 'http://localhost').pathname;
  try {
    await writeAudit(deps.pool, {
      accountId: input.accountId,
      deviceId: input.deviceId,
      action: 'proxy.denied',
      result: 'denied',
      detail: { reason: input.reason, method: request.method, path: pathname },
    });
  } catch (error) {
    request.log.warn({ err: error }, '[proxy] 写 proxy.denied 审计失败');
  }
}

async function handleProxy(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  deviceId: string,
  rawPathAndQuery: string,
  mountPrefix?: string,
): Promise<FastifyReply> {
  const identity = await authenticate(deps, request);
  if (!identity) {
    await auditProxyDenied(deps, request, { reason: 'unauthenticated', accountId: null, deviceId: null });
    if (wantsJson(request.headers)) {
      return reply.code(401).send(apiErrorBody('auth.token_invalid', '未登录或登录已过期', request.id));
    }
    return reply.code(302).header('location', buildLoginRedirect(request.raw.url ?? '/')).send();
  }

  // 用 ?token= 打开设备页时（App/首次访问），补写浏览器 Cookie，
  // 否则页面后续的静态资源/API 请求没有凭据会 401。
  const rawUrl = request.raw.url ?? '';
  const queryToken = new URL(rawUrl, 'http://localhost').searchParams.get('token');
  if (queryToken && !request.headers.cookie?.includes(`${COOKIE_NAME}=`)) {
    reply.header('set-cookie', `${COOKIE_NAME}=${queryToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`);
  }
  const device = await findDeviceForTunnel(deps.pool, deviceId);
  if (!device || device.revoked_at !== null) {
    await auditProxyDenied(deps, request, {
      reason: 'unknown_device',
      accountId: identity.accountId,
      deviceId: null,
    });
    if (wantsJson(request.headers)) return reply.code(404).send(apiErrorBody('not_found.device', '设备不存在', request.id));
    return reply.code(404).type('text/plain; charset=utf-8').send('设备不存在');
  }
  if (device.account_id !== identity.accountId) {
    await auditProxyDenied(deps, request, {
      reason: 'cross_account',
      accountId: identity.accountId,
      deviceId: device.id,
    });
    if (wantsJson(request.headers)) return reply.code(403).send(apiErrorBody('authz.forbidden', '无权访问该设备', request.id));
    return reply.code(403).type('text/plain; charset=utf-8').send('无权访问该设备');
  }
  if (!deps.registry.isOnline(deviceId)) {
    await auditProxyDenied(deps, request, {
      reason: 'tunnel_offline',
      accountId: identity.accountId,
      deviceId: device.id,
    });
    return sendOffline(request, reply, request.id);
  }

  const { path, search } = stripTokenParam(rawPathAndQuery);
  const forwardedPath = `${path || '/'}${search ? `?${search}` : ''}`;
  try {
    assertSafePath(forwardedPath, request.id);
  } catch (error) {
    await auditProxyDenied(deps, request, {
      reason: 'path_denied',
      accountId: identity.accountId,
      deviceId: device.id,
    });
    return reply
      .code(400)
      .send(apiErrorBody('request.invalid', (error as Error).message, request.id));
  }

  const headers: Record<string, string> = {};
  for (const name of PASS_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }

  let upstream: TunnelHttpResponse;
  try {
    upstream = await deps.registry.request(deviceId, {
      method: request.method,
      path: forwardedPath,
      headers,
      body: buildRequestBody(request),
    });
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 502;
    const code = (error as { code?: string }).code ?? 'tunnel.error';
    if (status === 503) {
      await auditProxyDenied(deps, request, {
        reason: 'tunnel_offline',
        accountId: identity.accountId,
        deviceId: device.id,
      });
      return sendOffline(request, reply, request.id);
    }
    if (code === 'tunnel.path_denied') {
      await auditProxyDenied(deps, request, {
        reason: 'path_denied',
        accountId: identity.accountId,
        deviceId: device.id,
      });
    }
    return reply.code(status).send(apiErrorBody(code, (error as Error).message, request.id));
  }

  const prefix = mountPrefix ?? `/t/${deviceId}`;
  const upstreamType = upstream.headers['content-type'] ?? 'application/octet-stream';
  const body = rewriteResponseBody(upstream.body, upstreamType, prefix);

  reply.code(upstream.status);
  for (const name of PASS_RESPONSE_HEADERS) {
    const value = upstream.headers[name];
    if (value === undefined) continue;
    reply.header(name, name === 'content-type' ? upstreamType : value);
  }
  // HTML 与 JS 都会经代理改写（polyfill / __DSH_TRANSPORT__ 注入、路径前缀重写）。
  // 若被 WebView 缓存，客户端会长期拿不到新版本，修复就"发不出去"。
  const lowerType = upstreamType.toLowerCase();
  if (
    lowerType.includes('text/html') ||
    lowerType.includes('javascript') ||
    lowerType.includes('ecmascript')
  ) {
    reply.header('cache-control', 'no-store');
  }
  const location = upstream.headers['location'];
  if (location) reply.header('location', rewriteLocation(location, prefix));
  const setCookie = upstream.headers['set-cookie'];
  if (setCookie) reply.header('set-cookie', rewriteSetCookies(setCookie, prefix));

  return reply.send(body);
}

/**
 * `/t/:deviceId/*` 设备 UI 代理（浏览器会话走 cookie `dsh_access` 或 Bearer）。
 * 路径穿越检查放在 onRequest：Fastify 路由会在匹配前归一化 `..`，必须在原始 URL 上拦截。
 */
export function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  app.addHook('onRequest', async (request, reply) => {
    const raw = request.raw.url ?? '';
    if (!raw.startsWith('/t/')) return;
    const pathOnly = raw.split('?')[0] ?? '';
    try {
      assertSafePath(pathOnly, request.id);
    } catch (error) {
      return reply.code(400).send(apiErrorBody('request.invalid', (error as Error).message, request.id));
    }
  });
  app.all('/t/:deviceId', async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const search = new URL(request.raw.url ?? '/', 'http://localhost').search;
    return reply.code(302).header('location', `/t/${deviceId}/${search}`).send();
  });


  // 根路径模式：DSH 前端只支持根路径，用 dsh_device cookie 选择设备
  const rootProxy = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const raw = request.raw.url ?? '/';
    if (/^\/(v1|login|healthz|download|t)(\/|$)/.test(raw)) {
      return reply.code(404).send(apiErrorBody('not_found.route', '接口不存在', request.id));
    }
    const deviceId = parseCookies(request.headers.cookie)['dsh_device'];
    if (!deviceId) {
      return reply.code(404).type('text/plain; charset=utf-8').send('设备未选择');
    }
    return handleProxy(request, reply, deps, deviceId, raw, '');
  };
  app.all('/', rootProxy);
  for (const route of [
    '/api/*',
    '/assets/*',
    '/plugins/*',
    '/dsh-whale/*',
    '/dsh-market/*',
    '/open-in-app/*',
    '/bsk-observation/*',
    '/mcp-connector/*',
    '/favicon.ico',
    '/favicon.svg',
    '/favicon-dark.svg',
    '/manifest.webmanifest',
  ]) {
    app.all(route, rootProxy);
  }

  app.all('/t/:deviceId/*', async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const raw = request.raw.url ?? `/t/${deviceId}/`;
    const rawPathAndQuery = raw.slice(`/t/${deviceId}`.length) || '/';
    return handleProxy(request, reply, deps, deviceId, rawPathAndQuery);
  });
}
