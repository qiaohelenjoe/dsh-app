"use strict";
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
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.name = void 0;
exports.apply = apply;
exports.name = 'dsh-mobile-account-ui';
var API_BASE = 'https://dsh.hbzxht.com';
var SESSION_KEY = 'dsh.mobileAccount.session';
var BUTTON_ID = 'dsh-mobile-account-button';
var OVERLAY_ID = 'dsh-mobile-account-overlay';
var STYLE = "\n#".concat(BUTTON_ID, "{position:fixed;left:12px;bottom:84px;z-index:2147483000;width:40px;height:40px;border-radius:12px;border:1px solid rgba(120,130,150,.28);background:linear-gradient(135deg,#4f7cff,#7a5cff);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 18px rgba(60,90,200,.28);transition:transform .15s ease,box-shadow .15s ease}\n#").concat(BUTTON_ID, ":hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(60,90,200,.38)}\n#").concat(BUTTON_ID, " svg{width:20px;height:20px}\n#").concat(OVERLAY_ID, "{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;background:rgba(10,14,24,.45);backdrop-filter:blur(2px);font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif}\n#").concat(OVERLAY_ID, " .dshma-card{width:min(420px,92vw);max-height:86vh;overflow:auto;border-radius:16px;background:var(--dshma-bg,#fff);color:var(--dshma-fg,#1c2330);box-shadow:0 24px 64px rgba(0,0,0,.28);padding:22px}\n#").concat(OVERLAY_ID, " .dshma-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}\n#").concat(OVERLAY_ID, " .dshma-title{font-size:17px;font-weight:650;letter-spacing:.2px}\n#").concat(OVERLAY_ID, " .dshma-sub{font-size:12px;color:#7a8494;margin:2px 0 16px}\n#").concat(OVERLAY_ID, " .dshma-close{border:0;background:transparent;color:#8a93a3;font-size:20px;line-height:1;cursor:pointer;padding:4px 6px;border-radius:8px}\n#").concat(OVERLAY_ID, " .dshma-close:hover{background:rgba(120,130,150,.12)}\n#").concat(OVERLAY_ID, " .dshma-tabs{display:flex;gap:6px;background:rgba(120,130,150,.12);padding:4px;border-radius:10px;margin-bottom:16px}\n#").concat(OVERLAY_ID, " .dshma-tab{flex:1;border:0;background:transparent;padding:8px 0;border-radius:8px;font-size:13px;color:#6b7484;cursor:pointer}\n#").concat(OVERLAY_ID, " .dshma-tab.active{background:var(--dshma-bg,#fff);color:var(--dshma-fg,#1c2330);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.12)}\n#").concat(OVERLAY_ID, " label.dshma-field{display:block;font-size:12px;color:#6b7484;margin:0 0 12px}\n#").concat(OVERLAY_ID, " label.dshma-field input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:10px;border:1px solid rgba(120,130,150,.30);background:transparent;color:inherit;font-size:14px;outline:none}\n#").concat(OVERLAY_ID, " label.dshma-field input:focus{border-color:#4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,.16)}\n#").concat(OVERLAY_ID, " .dshma-primary{width:100%;border:0;border-radius:10px;padding:11px 0;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#4f7cff,#7a5cff);cursor:pointer;margin-top:4px}\n#").concat(OVERLAY_ID, " .dshma-primary:disabled{opacity:.6;cursor:default}\n#").concat(OVERLAY_ID, " .dshma-error{color:#e5484d;font-size:12px;margin:10px 0 0;white-space:pre-wrap}\n#").concat(OVERLAY_ID, " .dshma-muted{color:#8a93a3;font-size:12px}\n#").concat(OVERLAY_ID, " .dshma-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid rgba(120,130,150,.14)}\n#").concat(OVERLAY_ID, " .dshma-row:last-child{border-bottom:0}\n#").concat(OVERLAY_ID, " .dshma-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:7px}\n#").concat(OVERLAY_ID, " .dshma-actions{display:flex;gap:8px;margin-top:14px}\n#").concat(OVERLAY_ID, " .dshma-ghost{flex:1;border:1px solid rgba(120,130,150,.30);background:transparent;color:inherit;border-radius:10px;padding:9px 0;font-size:13px;cursor:pointer}\n@media (prefers-color-scheme:dark){#").concat(OVERLAY_ID, "{--dshma-bg:#1b1e26;--dshma-fg:#e8ecf4}}\n");
function readSession() {
    try {
        var raw = sessionStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    }
    catch (_a) {
        return null;
    }
}
function writeSession(session) {
    try {
        if (session)
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else
            sessionStorage.removeItem(SESSION_KEY);
    }
    catch (_a) {
        // 忽略
    }
}
function api(path_1) {
    return __awaiter(this, arguments, void 0, function (path, options) {
        var response, body, _a;
        var _b;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, fetch("".concat(API_BASE).concat(path), {
                        method: (_b = options.method) !== null && _b !== void 0 ? _b : 'GET',
                        headers: __assign({ 'content-type': 'application/json' }, (options.token ? { authorization: "Bearer ".concat(options.token) } : {})),
                        body: options.body === undefined ? undefined : JSON.stringify(options.body),
                    })];
                case 1:
                    response = _c.sent();
                    body = null;
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, response.json()];
                case 3:
                    body = _c.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _a = _c.sent();
                    body = null;
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/, { status: response.status, body: body }];
            }
        });
    });
}
function errorText(result) {
    var _a, _b, _c, _d, _e, _f;
    var code = (_c = (_b = (_a = result.body) === null || _a === void 0 ? void 0 : _a.error) === null || _b === void 0 ? void 0 : _b.code) !== null && _c !== void 0 ? _c : '';
    var message = (_f = (_e = (_d = result.body) === null || _d === void 0 ? void 0 : _d.error) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : '';
    if (message)
        return "".concat(message).concat(code ? "\uFF08".concat(code, "\uFF09") : '');
    return "\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ".concat(result.status, "\uFF09");
}
function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text)
        node.textContent = text;
    return node;
}
function platform() {
    var ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac'))
        return 'darwin';
    if (ua.includes('linux'))
        return 'linux';
    return 'win32';
}
function installStyle() {
    if (document.getElementById('dsh-mobile-account-style'))
        return;
    var style = document.createElement('style');
    style.id = 'dsh-mobile-account-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
}
function createPanel() {
    var overlay = null;
    function render() {
        if (!overlay)
            return;
        var session = readSession();
        overlay.innerHTML = '';
        var card = el('div', 'dshma-card');
        overlay.appendChild(card);
        var head = el('div', 'dshma-head');
        head.appendChild(el('div', 'dshma-title', session ? 'DSH 移动端账号' : 'DSH 移动端账号'));
        var close = el('button', 'dshma-close', '×');
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', function () { return closePanel(); });
        head.appendChild(close);
        card.appendChild(head);
        card.appendChild(el('div', 'dshma-sub', session ? session.email : '登录后手机可远程打开这台电脑的 DSH'));
        if (session)
            renderAccount(card, session);
        else
            renderAuth(card);
    }
    function renderAuth(card) {
        var _this = this;
        var mode = 'login';
        var tabs = el('div', 'dshma-tabs');
        var loginTab = el('button', 'dshma-tab active', '登录');
        var registerTab = el('button', 'dshma-tab', '注册');
        tabs.append(loginTab, registerTab);
        card.appendChild(tabs);
        var form = el('form');
        var emailLabel = el('label', 'dshma-field', '邮箱');
        var email = el('input');
        email.type = 'email';
        email.autocomplete = 'username';
        email.required = true;
        emailLabel.appendChild(email);
        var passwordLabel = el('label', 'dshma-field', '密码');
        var password = el('input');
        password.type = 'password';
        password.autocomplete = 'current-password';
        password.required = true;
        passwordLabel.appendChild(password);
        var confirmLabel = el('label', 'dshma-field', '确认密码');
        var confirm = el('input');
        confirm.type = 'password';
        confirm.autocomplete = 'new-password';
        confirmLabel.appendChild(confirm);
        confirmLabel.style.display = 'none';
        var submit = el('button', 'dshma-primary', '登录');
        submit.type = 'submit';
        var error = el('p', 'dshma-error');
        form.append(emailLabel, passwordLabel, confirmLabel, submit, error);
        card.appendChild(form);
        function switchMode(next) {
            mode = next;
            loginTab.classList.toggle('active', next === 'login');
            registerTab.classList.toggle('active', next === 'register');
            confirmLabel.style.display = next === 'register' ? 'block' : 'none';
            confirm.required = next === 'register';
            submit.textContent = next === 'register' ? '注册并登录' : '登录';
            error.textContent = '';
        }
        loginTab.addEventListener('click', function () { return switchMode('login'); });
        registerTab.addEventListener('click', function () { return switchMode('register'); });
        form.addEventListener('submit', function (event) { return __awaiter(_this, void 0, void 0, function () {
            var emailValue, passwordValue, registered, loggedIn, requestError_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        event.preventDefault();
                        error.textContent = '';
                        emailValue = email.value.trim();
                        passwordValue = password.value;
                        if (!emailValue || !passwordValue) {
                            error.textContent = '请填写邮箱和密码';
                            return [2 /*return*/];
                        }
                        if (mode === 'register') {
                            if (passwordValue.length < 10) {
                                error.textContent = '密码至少 10 位，且不能是常见弱口令';
                                return [2 /*return*/];
                            }
                            if (passwordValue !== confirm.value) {
                                error.textContent = '两次输入的密码不一致';
                                return [2 /*return*/];
                            }
                        }
                        submit.disabled = true;
                        submit.textContent = mode === 'register' ? '注册中…' : '登录中…';
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 5, 6, 7]);
                        if (!(mode === 'register')) return [3 /*break*/, 3];
                        return [4 /*yield*/, api('/v1/auth/register', { method: 'POST', body: { email: emailValue, password: passwordValue } })];
                    case 2:
                        registered = _a.sent();
                        if (registered.status !== 201) {
                            error.textContent = errorText(registered);
                            return [2 /*return*/];
                        }
                        _a.label = 3;
                    case 3: return [4 /*yield*/, api('/v1/auth/login', {
                            method: 'POST',
                            body: {
                                email: emailValue,
                                password: passwordValue,
                                clientType: 'mobile',
                                device: {
                                    name: 'DSH 桌面面板',
                                    platform: platform(),
                                    appVersion: '0.1.0',
                                    signPublicKey: 'dsh-panel-sign',
                                    ecdhPublicKey: 'dsh-panel-ecdh',
                                },
                            },
                        })];
                    case 4:
                        loggedIn = _a.sent();
                        if (loggedIn.status !== 200) {
                            error.textContent = errorText(loggedIn);
                            return [2 /*return*/];
                        }
                        writeSession({
                            accessToken: loggedIn.body.accessToken,
                            refreshToken: loggedIn.body.refreshToken,
                            email: emailValue,
                        });
                        render();
                        return [3 /*break*/, 7];
                    case 5:
                        requestError_1 = _a.sent();
                        error.textContent = "\u7F51\u7EDC\u9519\u8BEF\uFF1A".concat(requestError_1.message);
                        return [3 /*break*/, 7];
                    case 6:
                        submit.disabled = false;
                        submit.textContent = mode === 'register' ? '注册并登录' : '登录';
                        return [7 /*endfinally*/];
                    case 7: return [2 /*return*/];
                }
            });
        }); });
    }
    function renderAccount(card, session) {
        var body = el('div');
        body.innerHTML = '<p class="dshma-muted">加载中…</p>';
        card.appendChild(body);
        var actions = el('div', 'dshma-actions');
        var refresh = el('button', 'dshma-ghost', '刷新');
        var logout = el('button', 'dshma-ghost', '退出登录');
        actions.append(refresh, logout);
        card.appendChild(actions);
        logout.addEventListener('click', function () {
            writeSession(null);
            render();
        });
        refresh.addEventListener('click', function () { return loadAccount(); });
        function ensureToken() {
            return __awaiter(this, void 0, void 0, function () {
                var current, account, refreshed;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            current = readSession();
                            if (!current)
                                return [2 /*return*/, null];
                            return [4 /*yield*/, api('/v1/account', { token: current.accessToken })];
                        case 1:
                            account = _a.sent();
                            if (account.status !== 401)
                                return [2 /*return*/, current.accessToken];
                            return [4 /*yield*/, api('/v1/auth/refresh', { method: 'POST', body: { refreshToken: current.refreshToken } })];
                        case 2:
                            refreshed = _a.sent();
                            if (refreshed.status !== 200) {
                                writeSession(null);
                                return [2 /*return*/, null];
                            }
                            current = {
                                accessToken: refreshed.body.accessToken,
                                refreshToken: refreshed.body.refreshToken,
                                email: current.email,
                            };
                            writeSession(current);
                            return [2 /*return*/, current.accessToken];
                    }
                });
            });
        }
        function loadAccount() {
            return __awaiter(this, void 0, void 0, function () {
                var token, _a, account, devices, info, usage, quota, list, _i, list_1, device, row, left, dot, requestError_2;
                var _b, _c, _d, _e, _f, _g, _h, _j;
                return __generator(this, function (_k) {
                    switch (_k.label) {
                        case 0:
                            body.innerHTML = '<p class="dshma-muted">加载中…</p>';
                            _k.label = 1;
                        case 1:
                            _k.trys.push([1, 4, , 5]);
                            return [4 /*yield*/, ensureToken()];
                        case 2:
                            token = _k.sent();
                            if (!token) {
                                render();
                                return [2 /*return*/];
                            }
                            return [4 /*yield*/, Promise.all([
                                    api('/v1/account', { token: token }),
                                    api('/v1/devices', { token: token }),
                                ])];
                        case 3:
                            _a = _k.sent(), account = _a[0], devices = _a[1];
                            if (account.status !== 200) {
                                body.innerHTML = '';
                                body.appendChild(el('p', 'dshma-error', errorText(account)));
                                return [2 /*return*/];
                            }
                            body.innerHTML = '';
                            info = account.body.account;
                            usage = (_b = account.body.usage) !== null && _b !== void 0 ? _b : {};
                            quota = el('div', 'dshma-row');
                            quota.appendChild(el('span', '', "\u684C\u9762 ".concat((_c = usage.desktopDevices) !== null && _c !== void 0 ? _c : 0, "/").concat((_e = (_d = info.limits) === null || _d === void 0 ? void 0 : _d.desktopDevices) !== null && _e !== void 0 ? _e : 20, " \u00B7 \u79FB\u52A8 ").concat((_f = usage.mobileDevices) !== null && _f !== void 0 ? _f : 0, "/").concat((_h = (_g = info.limits) === null || _g === void 0 ? void 0 : _g.mobileDevices) !== null && _h !== void 0 ? _h : 10)));
                            quota.appendChild(el('span', 'dshma-muted', '配额'));
                            body.appendChild(quota);
                            body.appendChild(el('div', 'dshma-row', '设备'));
                            list = Array.isArray((_j = devices.body) === null || _j === void 0 ? void 0 : _j.devices) ? devices.body.devices : [];
                            if (list.length === 0)
                                body.appendChild(el('p', 'dshma-muted', '暂无设备，请在电脑端安装 dsh-mobile-tunnel 插件'));
                            for (_i = 0, list_1 = list; _i < list_1.length; _i++) {
                                device = list_1[_i];
                                row = el('div', 'dshma-row');
                                left = el('span');
                                dot = el('span', 'dshma-dot');
                                dot.style.background = device.online ? '#30a46c' : '#b0b7c3';
                                left.append(dot, document.createTextNode("".concat(device.name, "\uFF08").concat(device.platform, "\uFF09")));
                                row.appendChild(left);
                                row.appendChild(el('span', 'dshma-muted', device.online ? '在线' : '离线'));
                                body.appendChild(row);
                            }
                            body.appendChild(el('p', 'dshma-muted', '登录状态约 30 天有效，期间自动续期，无需反复登录。'));
                            return [3 /*break*/, 5];
                        case 4:
                            requestError_2 = _k.sent();
                            body.innerHTML = '';
                            body.appendChild(el('p', 'dshma-error', "\u52A0\u8F7D\u5931\u8D25\uFF1A".concat(requestError_2.message)));
                            return [3 /*break*/, 5];
                        case 5: return [2 /*return*/];
                    }
                });
            });
        }
        void loadAccount();
    }
    function openPanel() {
        if (overlay)
            return;
        installStyle();
        overlay = el('div');
        overlay.id = OVERLAY_ID;
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay)
                closePanel();
        });
        document.body.appendChild(overlay);
        render();
    }
    function closePanel() {
        overlay === null || overlay === void 0 ? void 0 : overlay.remove();
        overlay = null;
    }
    return { open: openPanel, close: closePanel };
}
/** Cordis 客户端插件入口。 */
function apply() {
    if (typeof document === 'undefined')
        return function () { return undefined; };
    installStyle();
    if (document.getElementById(BUTTON_ID))
        return function () { return undefined; };
    var panel = createPanel();
    var button = el('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = 'DSH 移动端账号';
    button.setAttribute('aria-label', 'DSH 移动端账号');
    button.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 5.2h4"/><circle cx="12" cy="18.2" r="0.9" fill="currentColor" stroke="none"/></svg>';
    button.addEventListener('click', function () { return panel.open(); });
    document.body.appendChild(button);
    return function () {
        var _a;
        button.remove();
        panel.close();
        (_a = document.getElementById('dsh-mobile-account-style')) === null || _a === void 0 ? void 0 : _a.remove();
    };
}
//# sourceMappingURL=client.js.map