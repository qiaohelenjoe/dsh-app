import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeEmail, type AuthService, type RequestContext } from '../auth/service.js';
import type { RateLimiter } from '../security/rate-limit.js';
import { parseRefreshToken, signAccessToken } from '../security/tokens.js';
import { ApiError } from './errors.js';
import { loginSchema, refreshSchema } from './schemas.js';

export interface WebLoginRouteDeps {
  auth: AuthService;
  limiter: RateLimiter;
  jwtSecret: string;
}

/** 浏览器网页登录会话有效期（手机上打开 DSH 页面使用）。 */
const WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_NAME = 'dsh_access';

function requestContext(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : null };
}

function enforceLimit(limiter: RateLimiter, key: string, limit: number, windowMs: number): void {
  const decision = limiter.consume(key, limit, windowMs);
  if (!decision.allowed) {
    throw new ApiError(429, 'rate_limit.exceeded', '请求过于频繁，请稍后再试', {
      'Retry-After': String(decision.retryAfterSec),
    });
  }
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(maxAgeSeconds)}`;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>登录 · DSH</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7fb;color:#1c2330}
  .card{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:24px;box-shadow:0 18px 50px rgba(20,40,80,.12)}
  h1{font-size:18px;margin:0 0 4px}
  p.sub{font-size:12px;color:#7a8494;margin:0 0 18px}
  label{display:block;font-size:12px;color:#6b7484;margin-bottom:12px}
  input{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid #d5dae3;
    font-size:15px;outline:none;background:transparent;color:inherit}
  input:focus{border-color:#4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,.16)}
  button{width:100%;border:0;border-radius:10px;padding:12px 0;font-size:15px;font-weight:600;color:#fff;
    background:linear-gradient(135deg,#4f7cff,#7a5cff);cursor:pointer}
  button:disabled{opacity:.6}
  .error{color:#e5484d;font-size:12px;margin:10px 0 0;white-space:pre-wrap;min-height:16px}
  @media (prefers-color-scheme:dark){body{background:#12141a;color:#e8ecf4}.card{background:#1b1e26;box-shadow:none}input{border-color:#333a46}}
</style>
</head>
<body>
<main class="card">
  <h1>登录 DSH</h1>
  <p class="sub">登录后继续打开你的设备</p>
  <form id="form">
    <label>邮箱<input id="email" type="email" autocomplete="username" required></label>
    <label>密码<input id="password" type="password" autocomplete="current-password" required></label>
    <button id="submit" type="submit">登录</button>
    <p class="error" id="error"></p>
  </form>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var next = params.get('next') || '/';
  var form = document.getElementById('form');
  var email = document.getElementById('email');
  var password = document.getElementById('password');
  var submit = document.getElementById('submit');
  var error = document.getElementById('error');

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      var response = await fetch('/v1/auth/web-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: email.value.trim(),
          password: password.value,
          clientType: 'mobile',
          device: {
            name: '手机浏览器',
            platform: 'android',
            appVersion: 'web',
            signPublicKey: 'web-login-sign',
            ecdhPublicKey: 'web-login-ecdh'
          }
        })
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        var message = body && body.error && body.error.message ? body.error.message : ('登录失败（HTTP ' + response.status + '）');
        error.textContent = message;
        return;
      }
      location.replace(next);
    } catch (requestError) {
      error.textContent = '网络错误：' + requestError.message;
    } finally {
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });
})();
</script>
</body>
</html>`;

/** 手机浏览器兜底登录：代理未认证时重定向到 /login，登录后写 7 天 Cookie 再回跳。 */
export function registerWebLoginRoutes(app: FastifyInstance, deps: WebLoginRouteDeps): void {
  app.get('/login', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(LOGIN_PAGE);
  });

  app.post('/v1/auth/web-login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    enforceLimit(deps.limiter, `login:ip:${request.ip}`, 5, 60 * 1000);
    enforceLimit(deps.limiter, `login:account:${normalizeEmail(body.email)}`, 10, 60 * 60 * 1000);
    const result = await deps.auth.login(body, requestContext(request));
    const parsed = parseRefreshToken(result.refreshToken);
    if (!parsed) throw new ApiError(500, 'internal.unexpected', '会话创建失败');
    const cookie = await signAccessToken(
      { accountId: result.account.id, sessionId: parsed.sessionId },
      deps.jwtSecret,
      WEB_SESSION_TTL_SECONDS,
    );
    reply.header('set-cookie', sessionCookie(cookie, WEB_SESSION_TTL_SECONDS));
    return reply.code(200).send({
      account: result.account,
      device: result.device,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      cookie,
      cookieExpiresIn: WEB_SESSION_TTL_SECONDS,
    });
  });

  // 移动端用 refresh token 换取 7 天网页 Cookie（避免 WebView 内 15 分钟掉登录）
  app.post('/v1/auth/web-session', async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const parsed = parseRefreshToken(body.refreshToken);
    if (parsed) enforceLimit(deps.limiter, `refresh:session:${parsed.sessionId}`, 60, 60 * 60 * 1000);
    const result = await deps.auth.createWebSession(body.refreshToken, requestContext(request));
    const cookie = await signAccessToken(
      { accountId: result.accountId, sessionId: result.sessionId },
      deps.jwtSecret,
      WEB_SESSION_TTL_SECONDS,
    );
    reply.header('set-cookie', sessionCookie(cookie, WEB_SESSION_TTL_SECONDS));
    return reply.code(200).send({
      accessToken: result.accessToken,
      // 不轮换：原样返回同一个 refresh，App 手里的令牌继续有效
      refreshToken: body.refreshToken,
      expiresIn: result.expiresIn,
      cookie,
      cookieExpiresIn: WEB_SESSION_TTL_SECONDS,
    });
  });
}
