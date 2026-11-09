/**
 * DSH 移动端账号面板（浏览器侧客户端插件）
 *
 * 在 DSH Web UI 左下角上方渲染一个手机图标，点击打开登录/注册面板：
 * - 登录：邮箱 + 密码（POST /v1/auth/login）
 * - 注册：邮箱 + 密码 + 确认密码（POST /v1/auth/register，成功后自动登录）
 * - 登录后：账号信息、配额用量、设备列表（在线状态）、刷新、登出
 * - access token 过期自动用 refresh token 续期
 *
 * 不依赖 React/DSH 内部组件，纯 DOM + 原生 fetch，避免宿主 UI API 变化影响。
 */

import { APP_DOWNLOAD_URL, APP_QR_SVG } from './app-qr.js';
import { filePanelEnabled, mountFilePanel } from './file-panel.js';

const pluginName = 'dsh-mobile-account-ui';
const pluginInject: string[] = [];

const DEFAULT_API_BASE = 'https://dsh.hbzxht.com';
const SESSION_KEY = 'dsh.mobileAccount.session';
const OVERLAY_ID = 'dsh-mobile-account-overlay';
const NAV_ENTRY_ID = 'dsh-mobile-account-nav-entry';

/**
 * 面板的服务端地址由宿主机插件配置下发（`GET panel-session` 返回 apiBase / downloadUrl），
 * 这里只是构建时的默认值：换服务器部署时不用改客户端代码。
 */
let apiBase = DEFAULT_API_BASE;
let downloadUrl = APP_DOWNLOAD_URL;

const STYLE = `
#${OVERLAY_ID}{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;background:rgba(10,14,24,.45);backdrop-filter:blur(2px);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
#${OVERLAY_ID} .dshma-card{width:min(420px,92vw);max-height:86vh;overflow:auto;border-radius:16px;background:var(--dshma-bg,#fff);color:var(--dshma-fg,#1c2330);box-shadow:0 24px 64px rgba(0,0,0,.28);padding:22px}
#${OVERLAY_ID} .dshma-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
#${OVERLAY_ID} .dshma-title{font-size:17px;font-weight:650;letter-spacing:.2px}
#${OVERLAY_ID} .dshma-sub{font-size:12px;color:#7a8494;margin:2px 0 16px}
#${OVERLAY_ID} .dshma-close{border:0;background:transparent;color:#8a93a3;font-size:20px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:8px}
#${OVERLAY_ID} .dshma-close:hover{background:rgba(120,130,150,.12)}
#${OVERLAY_ID} .dshma-tabs{display:flex;gap:6px;background:rgba(120,130,150,.12);padding:4px;border-radius:10px;margin-bottom:16px}
#${OVERLAY_ID} .dshma-tab{flex:1;border:0;background:transparent;padding:8px 0;border-radius:8px;font-size:13px;color:#6b7484;cursor:pointer}
#${OVERLAY_ID} .dshma-tab.active{background:var(--dshma-bg,#fff);color:var(--dshma-fg,#1c2330);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.12)}
#${OVERLAY_ID} label.dshma-field{display:block;font-size:12px;color:#6b7484;margin:0 0 12px}
#${OVERLAY_ID} label.dshma-field input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:10px;border:1px solid rgba(120,130,150,.30);background:transparent;color:inherit;font-size:14px;outline:none}
#${OVERLAY_ID} label.dshma-field input:focus{border-color:#4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,.16)}
#${OVERLAY_ID} .dshma-primary{width:100%;border:0;border-radius:10px;padding:11px 0;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#4f7cff,#7a5cff);cursor:pointer;margin-top:4px}
#${OVERLAY_ID} .dshma-primary:disabled{opacity:.6;cursor:default}
#${OVERLAY_ID} .dshma-error{color:#e5484d;font-size:12px;margin:10px 0 0;white-space:pre-wrap}
#${OVERLAY_ID} .dshma-muted{color:#8a93a3;font-size:12px}
#${OVERLAY_ID} .dshma-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid rgba(120,130,150,.14)}
#${OVERLAY_ID} .dshma-row:last-child{border-bottom:0}
#${OVERLAY_ID} .dshma-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px}
#${OVERLAY_ID} .dshma-actions{display:flex;gap:8px;margin-top:14px}
#${OVERLAY_ID} .dshma-ghost{flex:1;border:1px solid rgba(120,130,150,.30);background:transparent;color:inherit;border-radius:10px;padding:9px 0;font-size:13px;cursor:pointer}
#${OVERLAY_ID} .dshma-download{margin-top:16px;padding-top:14px;border-top:1px solid rgba(120,130,150,.14);text-align:center}
#${OVERLAY_ID} .dshma-download-title{font-size:13px;font-weight:600;margin-bottom:10px}
#${OVERLAY_ID} .dshma-qr{width:164px;height:164px;margin:0 auto 8px;background:#fff;border-radius:12px;padding:8px;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.08)}
#${OVERLAY_ID} .dshma-qr svg{display:block;width:100%;height:100%}
#${OVERLAY_ID} .dshma-download-link{display:inline-block;font-size:13px;font-weight:600;color:#4f7cff;text-decoration:none;padding:6px 0}
#${OVERLAY_ID} .dshma-download-link:hover{text-decoration:underline}
#dsh-mobile-account-more-entry,#dsh-mobile-account-more-panel,#dsh-mobile-account-more-panel *{-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
#dsh-mobile-account-more-panel button:active{background:rgba(120,130,150,.18)}
#dsh-mobile-account-more-entry{display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box;padding:6px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.2;text-align:left;white-space:nowrap;cursor:pointer}
#dsh-mobile-account-more-entry:hover{background:rgba(120,130,150,.14)}
#dsh-mobile-account-more-entry svg{width:16px;height:16px;flex:none}
html.dshma-mobile button[aria-label="打开侧边栏"] [data-slot="sidebar.brand.mark"] > svg{display:none!important}
html.dshma-mobile .dshwv-root,
html.dshma-mobile [class^="dshwv-"],
html.dshma-mobile [class*=" dshwv-"]{display:none!important}
.dshma-toggle-icon{display:flex;align-items:center;justify-content:center;width:22px;height:22px}.dshma-toggle-icon svg{width:18px;height:18px}
#${NAV_ENTRY_ID}{display:flex;align-items:center;gap:8px;width:100%;min-width:0;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:6px 10px;border-radius:8px;overflow:hidden;text-align:left}
#${NAV_ENTRY_ID}:hover{background:rgba(120,130,150,.14)}
#${NAV_ENTRY_ID} svg{width:16px;height:16px;flex:none}
#${NAV_ENTRY_ID} .dshma-nav-label{font-size:13px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (prefers-color-scheme:dark){#${OVERLAY_ID}{--dshma-bg:#1b1e26;--dshma-fg:#e8ecf4}}
`;

interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
}

/** 宿主机接口：会话落到插件数据文件，跨 DSH 重启有效（端口变化也不受影响）。 */
const SESSION_ROUTE = '/plugins/dsh-mobile-tunnel/panel-session';
/** 面板登录后把本机登记为受控设备（面板登录本身不登记设备）。 */
const REGISTER_DEVICE_ROUTE = '/plugins/dsh-mobile-tunnel/register-device';

let deviceRegistrationRequested = false;

/**
 * 面板登录后告知宿主：把本机登记为受控设备并启动隧道。
 * 幂等（宿主侧同名同平台复用），失败不打扰用户（面板展示形式保持不变）。
 */
async function ensureHostDeviceRegistered(): Promise<void> {
  if (deviceRegistrationRequested) return;
  deviceRegistrationRequested = true;
  try {
    const response = await fetch(REGISTER_DEVICE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) deviceRegistrationRequested = false;
  } catch {
    deviceRegistrationRequested = false;
  }
}

function normalizeSession(value: unknown): Session | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0) return null;
  if (typeof candidate.refreshToken !== 'string' || candidate.refreshToken.length === 0) return null;
  if (typeof candidate.email !== 'string' || candidate.email.length === 0) return null;
  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    email: candidate.email,
  };
}

/** 浏览器内兜底副本：宿主机接口不可用时行为与改动前完全一致。 */
function readLocalSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? normalizeSession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeLocalSession(session: Session | null): void {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // 忽略
  }
}

/** 读会话：宿主机接口优先；接口不可用（旧版插件/异常）才回落 sessionStorage。 */
async function loadSession(): Promise<Session | null> {
  try {
    const response = await fetch(SESSION_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (response.ok) {
      const body = (await response.json()) as { session?: unknown; apiBase?: unknown; downloadUrl?: unknown };
      // 宿主机下发的服务端地址/下载页地址优先（换服务器部署时无需改客户端）
      if (typeof body.apiBase === 'string' && /^https?:\/\//.test(body.apiBase)) {
        apiBase = body.apiBase.replace(/\/+$/, '');
      }
      if (typeof body.downloadUrl === 'string' && /^https?:\/\//.test(body.downloadUrl)) {
        downloadUrl = body.downloadUrl;
      }
      return normalizeSession(body?.session);
    }
  } catch {
    // 回落本地副本
  }
  return readLocalSession();
}

/** 写会话：先镜像到本地副本（保证接口异常时不丢登录），再交给宿主机持久化。 */
async function saveSession(session: Session | null): Promise<void> {
  writeLocalSession(session);
  try {
    if (session) {
      await fetch(SESSION_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session }),
      });
    } else {
      await fetch(SESSION_ROUTE, { method: 'DELETE' });
    }
  } catch {
    // 本地副本已写入，行为同改动前
  }
}

async function api(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function errorText(result: { status: number; body: any }): string {
  const code = result.body?.error?.code ?? '';
  const message = result.body?.error?.message ?? '';
  if (message) return `${message}${code ? `（${code}）` : ''}`;
  return `请求失败（HTTP ${result.status}）`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function installStyle(): void {
  if (document.getElementById('dsh-mobile-account-style')) return;
  const style = document.createElement('style');
  style.id = 'dsh-mobile-account-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

interface Controller {
  open(): void;
  close(): void;
}

function createPanel(): Controller {
  let overlay: HTMLElement | null = null;

  async function render(): Promise<void> {
    const node = overlay;
    if (!node) return;
    node.innerHTML = '';
    const card = el('div', 'dshma-card');
    node.appendChild(card);

    const head = el('div', 'dshma-head');
    head.appendChild(el('div', 'dshma-title', 'DSH 移动端账号'));
    const close = el('button', 'dshma-close', '×');
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => closePanel());
    head.appendChild(close);
    card.appendChild(head);

    // 会话读取是异步的（宿主机接口）：先给出加载态，避免闪一下登录框
    const sub = el('div', 'dshma-sub', '加载中…');
    card.appendChild(sub);

    const session = await loadSession();
    // 等待期间面板可能被关闭/重开：旧卡片的渲染结果直接丢弃
    if (!card.isConnected) return;

    sub.textContent = session ? session.email : '登录后手机可远程打开这台电脑的 DSH';
    if (session) {
      void ensureHostDeviceRegistered();
      renderAccount(card, session);
      renderDownload(card);
    } else {
      renderAuth(card);
    }
  }

  /** 登录后展示手机 App 下载入口：二维码内容与链接地址一致。 */
  function renderDownload(card: HTMLElement): void {
    const section = el('div', 'dshma-download');
    section.appendChild(el('div', 'dshma-download-title', '下载手机 App'));
    // 二维码是构建期按默认下载页离线生成的；换服务器后地址可能不同，此时只保留链接
    if (downloadUrl === APP_DOWNLOAD_URL) {
      const qr = el('div', 'dshma-qr');
      qr.innerHTML = APP_QR_SVG;
      section.appendChild(qr);
    }
    const link = el('a', 'dshma-download-link', '下载最新版本 APP');
    link.href = downloadUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    section.appendChild(link);
    section.appendChild(el('div', 'dshma-muted', '手机扫码或点上面的链接下载，用同一个账号登录后即可远程打开这台电脑'));
    card.appendChild(section);
  }

  function renderAuth(card: HTMLElement): void {
    let mode: 'login' | 'register' = 'login';
    const tabs = el('div', 'dshma-tabs');
    const loginTab = el('button', 'dshma-tab active', '登录');
    const registerTab = el('button', 'dshma-tab', '注册');
    tabs.append(loginTab, registerTab);
    card.appendChild(tabs);

    const form = el('form');
    const emailLabel = el('label', 'dshma-field', '邮箱');
    const email = el('input');
    email.type = 'email';
    email.autocomplete = 'username';
    email.required = true;
    emailLabel.appendChild(email);
    const passwordLabel = el('label', 'dshma-field', '密码');
    const password = el('input');
    password.type = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    passwordLabel.appendChild(password);
    const confirmLabel = el('label', 'dshma-field', '确认密码');
    const confirm = el('input');
    confirm.type = 'password';
    confirm.autocomplete = 'new-password';
    confirmLabel.appendChild(confirm);
    confirmLabel.style.display = 'none';
    const submit = el('button', 'dshma-primary', '登录');
    submit.type = 'submit';
    const error = el('p', 'dshma-error');
    form.append(emailLabel, passwordLabel, confirmLabel, submit, error);
    card.appendChild(form);

    function switchMode(next: 'login' | 'register'): void {
      mode = next;
      loginTab.classList.toggle('active', next === 'login');
      registerTab.classList.toggle('active', next === 'register');
      confirmLabel.style.display = next === 'register' ? 'block' : 'none';
      confirm.required = next === 'register';
      submit.textContent = next === 'register' ? '注册并登录' : '登录';
      error.textContent = '';
    }
    loginTab.addEventListener('click', () => switchMode('login'));
    registerTab.addEventListener('click', () => switchMode('register'));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const emailValue = email.value.trim();
      const passwordValue = password.value;
      if (!emailValue || !passwordValue) {
        error.textContent = '请填写邮箱和密码';
        return;
      }
      if (mode === 'register') {
        if (passwordValue.length < 10) {
          error.textContent = '密码至少 10 位，且不能是常见弱口令';
          return;
        }
        if (passwordValue !== confirm.value) {
          error.textContent = '两次输入的密码不一致';
          return;
        }
      }
      submit.disabled = true;
      submit.textContent = mode === 'register' ? '注册中…' : '登录中…';
      try {
        if (mode === 'register') {
          const registered = await api('/v1/auth/register', { method: 'POST', body: { email: emailValue, password: passwordValue } });
          if (registered.status !== 201) {
            error.textContent = errorText(registered);
            return;
          }
        }
        // 网页会话登录：不登记设备（不占设备名额、不出现在设备列表里）
        const loggedIn = await api('/v1/auth/panel-login', {
          method: 'POST',
          body: {
            email: emailValue,
            password: passwordValue,
          },
        });
        if (loggedIn.status !== 200) {
          error.textContent = errorText(loggedIn);
          return;
        }
        await saveSession({
          accessToken: loggedIn.body.accessToken,
          refreshToken: loggedIn.body.refreshToken,
          email: emailValue,
        });
        void ensureHostDeviceRegistered();
        void render();
      } catch (requestError) {
        error.textContent = `网络错误：${(requestError as Error).message}`;
      } finally {
        submit.disabled = false;
        submit.textContent = mode === 'register' ? '注册并登录' : '登录';
      }
    });
  }

  function renderAccount(card: HTMLElement, session: Session): void {
    const body = el('div');
    body.innerHTML = '<p class="dshma-muted">加载中…</p>';
    card.appendChild(body);

    const actions = el('div', 'dshma-actions');
    const refresh = el('button', 'dshma-ghost', '刷新');
    const logout = el('button', 'dshma-ghost', '退出登录');
    actions.append(refresh, logout);
    card.appendChild(actions);
    logout.addEventListener('click', () => {
      void saveSession(null).then(() => render());
    });
    refresh.addEventListener('click', () => loadAccount());

    async function ensureToken(): Promise<string | null> {
      let current = await loadSession();
      if (!current) return null;
      const account = await api('/v1/account', { token: current.accessToken });
      if (account.status !== 401) return current.accessToken;
      const refreshed = await api('/v1/auth/refresh', { method: 'POST', body: { refreshToken: current.refreshToken } });
      if (refreshed.status !== 200) {
        await saveSession(null);
        return null;
      }
      current = {
        accessToken: refreshed.body.accessToken,
        refreshToken: refreshed.body.refreshToken,
        email: current.email,
      };
      await saveSession(current);
      return current.accessToken;
    }

    async function loadAccount(): Promise<void> {
      body.innerHTML = '<p class="dshma-muted">加载中…</p>';
      try {
        const token = await ensureToken();
        if (!token) {
          void render();
          return;
        }
        const [account, devices] = await Promise.all([
          api('/v1/account', { token }),
          api('/v1/devices', { token }),
        ]);
        if (account.status !== 200) {
          body.innerHTML = '';
          body.appendChild(el('p', 'dshma-error', errorText(account)));
          return;
        }
        body.innerHTML = '';
        const info = account.body.account;
        const usage = account.body.usage ?? {};
        const quota = el('div', 'dshma-row');
        quota.appendChild(el('span', '', `桌面 ${usage.desktopDevices ?? 0}/${info.limits?.desktopDevices ?? 20} · 移动 ${usage.mobileDevices ?? 0}/${info.limits?.mobileDevices ?? 10}`));
        quota.appendChild(el('span', 'dshma-muted', '配额'));
        body.appendChild(quota);
        body.appendChild(el('div', 'dshma-row', '设备'));
        const list = Array.isArray(devices.body?.devices) ? devices.body.devices : [];
        if (list.length === 0) body.appendChild(el('p', 'dshma-muted', '暂无设备，请在电脑端安装 dsh-mobile-tunnel 插件'));
        for (const device of list) {
          const row = el('div', 'dshma-row');
          const left = el('span');
          const dot = el('span', 'dshma-dot');
          dot.style.background = device.online ? '#30a46c' : '#b0b7c3';
          left.append(dot, document.createTextNode(`${device.name}（${device.platform}）`));
          row.appendChild(left);
          row.appendChild(el('span', 'dshma-muted', device.online ? '在线' : '离线'));
          body.appendChild(row);
        }
        body.appendChild(el('p', 'dshma-muted', '登录状态约 30 天有效，期间自动续期，无需反复登录。'));
      } catch (requestError) {
        body.innerHTML = '';
        body.appendChild(el('p', 'dshma-error', `加载失败：${(requestError as Error).message}`));
      }
    }

    void loadAccount();
  }

  function openPanel(): void {
    if (overlay) return;
    installStyle();
    overlay = el('div');
    overlay.id = OVERLAY_ID;
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closePanel();
    });
    document.body.appendChild(overlay);
    void render();
  }

  function closePanel(): void {
    overlay?.remove();
    overlay = null;
  }

  return { open: openPanel, close: closePanel };
}

const PHONE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 5.2h4"/><circle cx="12" cy="18.2" r="0.9" fill="currentColor" stroke="none"/></svg>';

/** 在侧边栏里找“插件”导航项：按文字或 aria-label，兼容延迟渲染/折叠状态。 */
function findPluginsNavItem(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="menuitem"], li'),
  );
  for (const candidate of candidates) {
    if (candidate.id === NAV_ENTRY_ID) continue;
    const text = (candidate.textContent ?? '').replace(/\s+/g, '').trim();
    const label = `${candidate.getAttribute('aria-label') ?? ''}${candidate.getAttribute('title') ?? ''}`.replace(/\s+/g, '');
    const matches =
      /^插件\d{0,3}$/.test(text) ||
      text === '插件设置' ||
      /^plugins?\d{0,3}$/i.test(text) ||
      /插件/.test(label);
    if (!matches) continue;
    const rect = candidate.getBoundingClientRect();
    // 已布局但明显不在左侧区域时跳过；尚未布局（0 尺寸）时仍然接受
    if (rect.width > 0 && rect.left > 360) continue;
    if (candidate.matches('li')) {
      const inner = candidate.querySelector<HTMLElement>('button, a, [role="button"]');
      if (inner) return inner;
    }
    return candidate;
  }
  return null;
}

/** 把入口挂到“插件”下面（找不到时什么都不做，不再显示悬浮按钮）。 */
function mountNavEntry(panel: Controller): boolean {
  if (document.getElementById(NAV_ENTRY_ID)) return true;
  const target = findPluginsNavItem();
  if (!target) return false;
  const entry = el('button');
  entry.id = NAV_ENTRY_ID;
  entry.type = 'button';
  entry.title = '移动端';
  entry.setAttribute('aria-label', '移动端');
  entry.className = `${typeof target.className === 'string' ? target.className : ''} dshma-nav-entry`.trim();
  entry.innerHTML = `${PHONE_ICON}<span class="dshma-nav-label">移动端</span>`;
  entry.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    panel.open();
  });
  target.insertAdjacentElement('afterend', entry);
  return true;
}

const MORE_ENTRY_ID = 'dsh-mobile-account-more-entry';
const MORE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

/** 移动端侧栏白名单：只保留这些入口，其余统一收进“更多功能”。 */
const MOBILE_KEEP_LABELS = new Set([
  '新建会话',
  '收起侧边栏',
  '打开侧边栏',
  '搜索会话',
  '视图选项',
  '账号菜单',
  '会话',
  '自动化任务',
  '工作区',
  '设置',
]);

interface HiddenSidebarItem {
  label: string;
  element: HTMLElement;
}

const MOBILE_DISABLED_PATTERNS = [/添加工作区/, /打开文件夹/, /打开文件/, /工作区文件/, /目录选择/];

let hiddenSidebarItems: HiddenSidebarItem[] = [];

function isMobileApp(): boolean {
  if (document.documentElement?.getAttribute('data-dsh-mobile-app') === '1') return true;
  // App 标记注入失败时的兜底：手机 WebView/浏览器 UA 直接按移动端处理
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** DSH 客户端根上下文（只声明本插件用到的部分）。 */
interface ClientContext {
  get?: (name: string) => unknown;
}

interface ResourceService {
  register(provider: {
    protocol: string;
    open(address: string, opts: { signal: AbortSignal }): AsyncIterable<unknown>;
  }): () => void;
}

interface WorkspaceFilesFace {
  stat(sessionId: string, path: string, signal?: AbortSignal): Promise<unknown>;
}

interface RemoteFace {
  workspaceFiles?: WorkspaceFilesFace;
}

/** `dsh-resource://file/session/<sessionId>/<path>` → `{ sessionId, path }`（path 保留前导斜杠）。 */
function parseFileAddress(address: string): { sessionId: string; path: string } | null {
  try {
    const url = new URL(address);
    if (url.protocol !== 'dsh-resource:' || url.host !== 'file') return null;
    const segments = url.pathname.replace(/^\//, '').split('/');
    if (segments[0] !== 'session') return null;
    const sessionId = decodeURIComponent(segments[1] ?? '');
    if (!sessionId) return null;
    return {
      sessionId,
      path: segments
        .slice(2)
        .map((segment) => decodeURIComponent(segment))
        .join('/'),
    };
  } catch {
    return null;
  }
}

function fileFailure(code: string, message: string): unknown {
  return { ok: false, failure: { name: code, code, message } };
}

/**
 * 移动端「文件管家」：注册 `ctx.resources` 的 `file` 提供方。
 *
 * DSH 自带的 `@deepseek-ai/dsh-api-workspace-files` 客户端插件把 `remote.workspaceFiles`
 * 写进了 `inject`。移动端经隧道时该命名空间晚于插件初始化完成装配，导致它的 `apply`
 * 永不执行，右侧面板的文件预览因此报「文件资源服务不可用」。
 *
 * 这里反过来：不依赖初始化阶段的命名空间，先把 provider 注册上；用户真正打开文件时
 * 才调用 `stat`，此时 Remote 早已就绪。只在 App 内注册，桌面端不介入，避免和 DSH
 * 自带的提供方争同一个协议。
 */
function mountFileProvider(ctx: ClientContext | undefined): () => void {
  if (!isMobileApp() || typeof ctx?.get !== 'function') return () => undefined;
  let release: (() => void) | undefined;
  let timer = 0;
  let disposed = false;

  const tryRegister = (): boolean => {
    if (disposed || release) return true;
    const resources = ctx.get?.('resources') as ResourceService | undefined;
    if (!resources || typeof resources.register !== 'function') return false;
    try {
      release = resources.register({
        protocol: 'file',
        async *open(address: string, opts: { signal: AbortSignal }) {
          const parsed = parseFileAddress(address);
          if (!parsed) {
            yield fileFailure('workspace-file/unsupported-address', '不支持的资源地址');
            return;
          }
          const remote = ctx.get?.('remote') as RemoteFace | undefined;
          const workspaceFiles = remote?.workspaceFiles;
          if (!workspaceFiles) {
            yield fileFailure('workspace-file/unavailable', '工作区文件通道尚未就绪');
            return;
          }
          try {
            yield await workspaceFiles.stat(parsed.sessionId, parsed.path, opts.signal);
          } catch (error) {
            yield fileFailure('workspace-file/read-failed', String((error as Error)?.message ?? error));
          }
        },
      });
      console.log('[file-provider] registered');
    } catch (error) {
      // 已有其它提供方（桌面端 DSH 自带），保持原样
      console.log('[file-provider] skipped: ' + String((error as Error)?.message ?? error));
    }
    return true;
  };

  if (!tryRegister()) {
    timer = window.setInterval(() => {
      if (!tryRegister()) return;
      window.clearInterval(timer);
      timer = 0;
    }, 300);
  }

  return () => {
    disposed = true;
    if (timer) window.clearInterval(timer);
    try {
      release?.();
    } catch {
      // 忽略
    }
  };
}

/** 只把侧边栏当作作用域，避免误伤主区域的模型/安全审查等按钮。 */
function sidebarRoot(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label], a[aria-label]'));
  const anchor = all.find((element) =>
    ['自动化任务', '插件市场', '记忆系统', '插件'].includes((element.getAttribute('aria-label') ?? '').trim()),
  );
  if (!anchor) return null;
  // 从入口向上找到“最小的、至少包含 3 个入口”的容器，即侧栏本身
  let node: HTMLElement | null = anchor;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    const count = node.querySelectorAll('button[aria-label], a[aria-label]').length;
    if (count >= 3 && rect.left <= 16 && rect.width > 0 && rect.width <= 420) return node;
    node = node.parentElement;
  }
  return null;
}

function sidebarButtons(): HTMLElement[] {
  const root = sidebarRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button[aria-label], a[aria-label]')).filter(
    (element) => {
      if (element.id === NAV_ENTRY_ID || element.id === MORE_ENTRY_ID) return false;
      // 已被本插件收起的入口：尺寸为 0，但仍要参与后续轮次，否则“更多功能”会被误删
      if (element.dataset.dshMobileHidden === '1') return true;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
  );
}

function closeMorePanel(): void {
  document.getElementById('dsh-mobile-account-more-panel')?.remove();
}

/** “更多功能”底部菜单：列出被收起的侧栏入口，点击后触发原入口。 */
function openMorePanel(): void {
  closeMorePanel();
  if (hiddenSidebarItems.length === 0) return;

  const overlay = el('div');
  overlay.id = 'dsh-mobile-account-more-panel';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.35);display:flex;align-items:flex-end;';

  const sheet = el('div');
  sheet.style.cssText =
    'width:100%;max-height:70vh;overflow:auto;background:var(--dsh-bg,#fff);color:var(--dsh-fg,#111);border-radius:16px 16px 0 0;padding:16px;box-sizing:border-box;box-shadow:0 -8px 30px rgba(0,0,0,.18);';

  const title = el('div');
  title.textContent = '更多功能';
  title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:12px;';
  sheet.appendChild(title);

  for (const item of hiddenSidebarItems) {
    const row = el('button');
    row.type = 'button';
    row.textContent = item.label;
    row.style.cssText =
      'display:block;width:100%;text-align:left;padding:12px 12px;margin:2px 0;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer;';
    row.addEventListener('click', () => {
      closeMorePanel();
      item.element.click();
    });
    sheet.appendChild(row);
  }

  const cancel = el('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.style.cssText =
    'display:block;width:100%;text-align:center;padding:12px;margin-top:12px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;';
  cancel.addEventListener('click', closeMorePanel);
  sheet.appendChild(cancel);

  overlay.appendChild(sheet);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeMorePanel();
  });
  document.body.appendChild(overlay);
}

function ensureMoreEntry(anchor: HTMLElement | null, before?: HTMLElement | null): void {
  if (!anchor || hiddenSidebarItems.length === 0) {
    document.getElementById(MORE_ENTRY_ID)?.remove();
    return;
  }
  let entry = document.getElementById(MORE_ENTRY_ID) as HTMLButtonElement | null;
  if (!entry) {
    entry = el('button');
    entry.id = MORE_ENTRY_ID;
    entry.type = 'button';
    entry.title = '更多功能';
    entry.setAttribute('aria-label', '更多功能');
    entry.className = `${typeof anchor.className === 'string' ? anchor.className : ''} dshma-nav-entry`.trim();
    entry.innerHTML = `${MORE_ICON}<span class="dshma-nav-label">更多功能</span>`;
    entry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMorePanel();
    });
  }
  if (before && before.parentElement) {
    if (entry.nextElementSibling !== before) before.parentElement.insertBefore(entry, before);
  } else if (entry.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', entry);
  }
  // 收起态只显示图标，不显示“更多功能”文字
  const collapsed = !!document.querySelector('button[aria-label="打开侧边栏"]');
  const label = entry.querySelector<HTMLElement>('.dshma-nav-label');
  if (label) label.style.display = collapsed ? 'none' : '';
  entry.style.width = collapsed ? '36px' : '100%';
  entry.style.padding = collapsed ? '0' : '6px 10px';
  entry.style.borderRadius = collapsed ? '12px' : '8px';
  entry.style.justifyContent = collapsed ? 'center' : 'flex-start';
  entry.style.opacity = '1';
  entry.style.visibility = 'visible';
}

const PANEL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M9 3v18"/></svg>';

/** 收起态：展开按钮换成侧栏图标；展开态：恢复品牌 Logo（鲸鱼 + DeepSeek Harness）。 */
function applyLogoPolicy(): void {
  if (!isMobileApp()) return;
  const toggle = document.querySelector<HTMLElement>(
    'button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]',
  );
  if (!toggle) return;
  const row = toggle.parentElement;
  const collapsed = toggle.getAttribute('aria-label') === '打开侧边栏';

  row?.querySelectorAll<HTMLElement>('[class*="brand" i]').forEach((element) => {
    if (!toggle.contains(element)) element.style.display = collapsed ? 'none' : '';
  });

  if (collapsed) {
    toggle.querySelectorAll<SVGElement>('svg').forEach((svg) => {
      if (!svg.closest('.dshma-toggle-icon')) svg.style.display = 'none';
    });
    if (!toggle.querySelector('.dshma-toggle-icon')) {
      const icon = document.createElement('span');
      icon.className = 'dshma-toggle-icon';
      icon.innerHTML = PANEL_ICON;
      (toggle.querySelector<HTMLElement>('[class*="railMark" i], [data-slot="sidebar.brand.mark"]') ?? toggle).appendChild(icon);
    }
  } else {
    toggle.querySelectorAll<SVGElement>('svg').forEach((svg) => {
      svg.style.display = '';
    });
    toggle.querySelector('.dshma-toggle-icon')?.remove();
  }
}

/** 依赖电脑端原生对话框的入口：不论在侧栏哪个区域，移动端一律隐藏。 */
function hideDesktopOnlyEntries(): void {
  if (!isMobileApp()) return;
  const toggle = document.querySelector<HTMLElement>(
    'button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]',
  );
  // 只处理左侧栏列内部的入口；右侧栏（文件预览/终端）结构上不在这个容器里
  const column = toggle?.closest<HTMLElement>('[class*="sidebarCol" i], aside');
  const scope: ParentNode = column ?? document;
  scope.querySelectorAll<HTMLElement>('button, a, [role="button"]').forEach((element) => {
    if (element.id === MORE_ENTRY_ID || element.closest('#dsh-mobile-account-more-panel')) return;
    if (element.dataset.dshMobileHidden === '1') return;
    const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, '').trim();
    if (!label) return;
    if (MOBILE_DISABLED_PATTERNS.some((pattern) => pattern.test(label))) {
      element.style.display = 'none';
    }
  });
}

/** 手机 App 内：侧栏按白名单保留，其余入口收进“更多功能”。 */
function applyMobileMenuPolicy(): void {
  document.documentElement.classList.toggle('dshma-mobile', isMobileApp());
  if (!isMobileApp()) return;
  document.getElementById(NAV_ENTRY_ID)?.remove();

  hiddenSidebarItems = [];
  let anchor: HTMLElement | null = null;
  let preferredAnchor: HTMLElement | null = null;
  for (const button of sidebarButtons()) {
    const label = (button.getAttribute('aria-label') ?? '').replace(/\s+/g, '').trim();
    if (!label) continue;
    if (MOBILE_KEEP_LABELS.has(label)) {
      button.style.display = '';
      delete button.dataset.dshMobileHidden;
      anchor = button;
      if (label === '自动化任务') preferredAnchor = button;
      continue;
    }
    button.style.display = 'none';
    button.dataset.dshMobileHidden = '1';
    // 依赖电脑端原生对话框的入口：移动端直接隐藏，不放进“更多功能”
    if (MOBILE_DISABLED_PATTERNS.some((pattern) => pattern.test(label))) continue;
    hiddenSidebarItems.push({ label, element: button });
  }
  hideDesktopOnlyEntries();

  const searchButton = document.querySelector<HTMLElement>('button[aria-label="搜索会话"]');
  const searchWrap = searchButton?.parentElement;
  const collapsedRail = !!document.querySelector('button[aria-label="打开侧边栏"]');
  // 收起态：隐藏工作区区域里留白的 sectionHeader，避免下方图标被顶下去
  const railContainer = searchWrap?.parentElement;
  const sectionHeader = railContainer
    ? Array.from(railContainer.children).find((child) => /sectionHeader/i.test(String((child as HTMLElement).className)))
    : undefined;
  if (sectionHeader instanceof HTMLElement) {
    sectionHeader.style.display = collapsedRail ? 'none' : '';
  }

  if (collapsedRail && searchWrap?.parentElement) {
    // 收起态：把“更多功能”放到工作区图标组、搜索按钮之前，避免负边距裁切
    ensureMoreEntry(searchWrap, searchWrap);
  } else {
    ensureMoreEntry(preferredAnchor ?? anchor);
  }
  applyLogoPolicy();

}

/** Cordis 客户端插件入口。 */
function apply(ctx?: ClientContext): () => void {
  if (typeof document === 'undefined') return () => undefined;
  // 文件管家与界面策略相互独立：即使下面因重复挂载提前返回，也要保留它的清理函数。
  const disposeFileProvider = mountFileProvider(ctx);
  installStyle();
  if (document.getElementById(NAV_ENTRY_ID)) return disposeFileProvider;
  // 移动端：用自己的文件面板替换官方「工作区文件」入口（官方预览依赖缺失的 resources 服务）。
  const filePanel = filePanelEnabled() ? mountFilePanel() : null;

  console.log('[mobile-menu] mobile=' + isMobileApp() + ' flag=' + document.documentElement?.getAttribute('data-dsh-mobile-app') + ' ua=' + navigator.userAgent.slice(0, 70));

  const retryLogo = (): void => {
    applyLogoPolicy();
    window.setTimeout(applyLogoPolicy, 120);
    window.setTimeout(applyLogoPolicy, 400);
    window.setTimeout(applyLogoPolicy, 900);
    window.setTimeout(applyLogoPolicy, 1600);
    window.setTimeout(applyLogoPolicy, 2400);
  };
  const onToggleClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]')) retryLogo();
  };
  document.addEventListener('click', onToggleClick, true);

  // 移动端：切换会话/工作区时临时拦截输入框的自动聚焦，避免键盘闪一下
  let focusGuardTimer = 0;
  let restoreFocus: (() => void) | null = null;
  const guardComposerFocus = (): void => {
    if (restoreFocus) {
      window.clearTimeout(focusGuardTimer);
    } else {
      const original = HTMLElement.prototype.focus;
      restoreFocus = () => {
        HTMLElement.prototype.focus = original;
        restoreFocus = null;
      };
      HTMLElement.prototype.focus = function (this: HTMLElement, ...args: unknown[]) {
        if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.isContentEditable) return;
        return original.apply(this, args as []);
      };
    }
    focusGuardTimer = window.setTimeout(() => {
      restoreFocus?.();
    }, 800);
  };
  const onSidebarClick = (event: Event): void => {
    if (!isMobileApp()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (!target.closest('[class*="sidebarCol" i], aside')) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      active.blur();
    }
    guardComposerFocus();
  };
  document.addEventListener('click', onSidebarClick, true);

  const panel = createPanel();
  const syncEntry = (): void => {
    applyMobileMenuPolicy();
    // 手机 App 内不提供“移动端”入口（避免入口套入口）
    if (isMobileApp()) return;
    mountNavEntry(panel);
  };
  syncEntry();
  // 首屏 DSH 可能在插件之后才完成侧栏渲染：仅在移动端延时校正
  if (isMobileApp()) retryLogo();

  // DSH 侧边栏会随路由/折叠重渲染；App 注入标识也是异步的
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      applyMobileMenuPolicy();
      if (!isMobileApp() && !document.getElementById(NAV_ENTRY_ID)) syncEntry();
    }, 150);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-dsh-mobile-app'] });

  return () => {
    window.clearTimeout(pending);
    observer.disconnect();
    document.removeEventListener('click', onToggleClick, true);
    document.removeEventListener('click', onSidebarClick, true);
    document.getElementById(NAV_ENTRY_ID)?.remove();
    document.getElementById(MORE_ENTRY_ID)?.remove();
    closeMorePanel();
    panel.close();
    document.getElementById('dsh-mobile-account-style')?.remove();
    filePanel?.dispose();
    disposeFileProvider();
  };
}