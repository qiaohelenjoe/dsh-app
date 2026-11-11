const { JSDOM } = require('jsdom');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.dirname(__dirname);
const code = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');
const SESSION_ROUTE = '/plugins/dsh-mobile-tunnel/panel-session';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用 jsdom 的 Window 构造一个可执行 bundle 的沙箱。 */
function runBundle(window, fetchImpl) {
  let captured = null;
  window.__ModuleLoader__ = { load: (def) => { captured = def; } };
  // jsdom 没有布局，桩一个可见的矩形，供侧边栏定位逻辑使用
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 8, y: 8, left: 8, top: 8, right: 108, bottom: 38, width: 100, height: 30, toJSON() { return this; } };
  };
  const sandbox = {
    window,
    document: window.document,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    fetch: fetchImpl || (async () => ({ status: 200, json: async () => ({}) })),
    MutationObserver: window.MutationObserver,
    HTMLElement: window.HTMLElement,
    console, Symbol, Object, JSON, Date, URL, Math, setTimeout, clearTimeout, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  assert(captured && captured.id === 'dsh-mobile-tunnel', 'ModuleLoader.load 未被调用或 id 错误');
  return captured.factory(() => ({}));
}

// 场景 1：侧边栏存在“插件”项 → 入口应插入到它下面，悬浮按钮隐藏
{
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
    { url: 'http://127.0.0.1:12345/' },
  );
  const exportsObj = runBundle(dom.window);
  const dispose = exportsObj.apply();
  const doc = dom.window.document;
  const entry = doc.getElementById('dsh-mobile-account-nav-entry');
  assert(entry, '未在“插件”下面插入入口');
  assert(entry.textContent.trim() === '移动端', `入口文案错误: ${entry.textContent}`);
  assert(entry.querySelector('svg'), '入口缺少图标');
  assert(entry.previousElementSibling && entry.previousElementSibling.textContent.includes('插件'), '入口不在“插件”下面');
  entry.click();
  assert(doc.getElementById('dsh-mobile-account-overlay'), '点击侧边栏入口后面板未打开');
  dispose();
  console.log('scenario 1 (sidebar entry) passed');
}

// 场景 2：没有侧边栏“插件”项 → 悬浮按钮兜底
{
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:12345/' });
  const exportsObj = runBundle(dom.window);
  const dispose = exportsObj.apply();
  const doc = dom.window.document;
  assert(!doc.getElementById('dsh-mobile-account-button'), '不应再创建悬浮按钮');
  dispose();
  console.log('scenario 2 (no sidebar, no floating button) passed');
}


// 场景 3：手机 App 内（data-dsh-mobile-app=1）→ 不插入“移动端”，并隐藏无关菜单
{
  const buttons = ['插件', 'SSH', '终端', '记忆系统', '插件市场', '工作区文件', 'MCP连接器', '会话', '自动化任务', '工作区', '设置']
    .map((label) => `<button aria-label="${label}" class="_navItem">${label}</button>`)
    .join('');
  const dom = new JSDOM(`<!doctype html><html><head></head><body><aside>${buttons}</aside></body></html>`, { url: 'http://127.0.0.1:12345/' });
  dom.window.document.documentElement.setAttribute('data-dsh-mobile-app', '1');
  const exportsObj = runBundle(dom.window);
  const dispose = exportsObj.apply();
  const doc = dom.window.document;
  assert(!doc.getElementById('dsh-mobile-account-nav-entry'), '手机端不应插入移动端入口');
  const byLabel = (label) => [...doc.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
  for (const hidden of ['SSH', '终端', '记忆系统', '插件市场', '工作区文件', 'MCP连接器']) {
    assert(byLabel(hidden).style.display === 'none', '手机端应隐藏菜单：' + hidden);
  }
  for (const kept of ['会话', '自动化任务', '工作区', '设置']) {
    assert(byLabel(kept).style.display !== 'none', '手机端应保留菜单：' + kept);
  }
  const more = doc.getElementById('dsh-mobile-account-more-entry');
  assert(more, '缺少更多功能入口');
  let sshClicked = 0;
  byLabel('SSH').addEventListener('click', () => { sshClicked += 1; });
  more.click();
  const morePanel = doc.getElementById('dsh-mobile-account-more-panel');
  assert(morePanel, '更多功能菜单未打开');
  const sshRow = [...morePanel.querySelectorAll('button')].find((b) => b.textContent === 'SSH');
  assert(sshRow, '更多功能菜单缺少 SSH');
  sshRow.click();
  assert(sshClicked === 1, '点击更多菜单项应触发原入口');
  assert(!doc.getElementById('dsh-mobile-account-more-panel'), '选择后菜单应关闭');
  dispose();
  console.log('scenario 3 (mobile menu policy) passed');
}

/** 场景 4~5：异步流程（宿主机会话接口 + 异步渲染）。 */
(async () => {
  // 场景 4：App 异步设置标记（先 apply 后 setAttribute）→ 观察器应生效
  {
    const buttons = ['插件', 'SSH', '自动化任务', '会话', '设置']
      .map((label) => `<button aria-label="${label}" class="_navItem">${label}</button>`)
      .join('');
    const dom = new JSDOM(`<!doctype html><html><head></head><body><aside>${buttons}</aside></body></html>`, { url: 'http://127.0.0.1:12345/' });
    const doc = dom.window.document;
    const exportsObj = runBundle(dom.window);
    const dispose = exportsObj.apply();
    await wait(20);
    doc.documentElement.setAttribute('data-dsh-mobile-app', '1');
    await wait(500);
    assert(doc.querySelector('button[aria-label="SSH"]').style.display === 'none', '异步标记后应隐藏 SSH');
    assert(!!doc.getElementById('dsh-mobile-account-more-entry'), '异步标记后应出现更多功能入口');
    assert(!doc.getElementById('dsh-mobile-account-nav-entry'), '异步标记后应移除移动端入口');
    dispose();
    console.log('scenario 4 (async flag) passed');
  }

  // 场景 5：宿主机已有登录会话 + 默认下载页 → 账号信息 + 二维码 + 橙色 tip + 退出走宿主
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: (init && init.method) || 'GET' });
      if (url === SESSION_ROUTE) {
        return { ok: true, status: 200, json: async () => ({ session }) };
      }
      if (url.endsWith('/tunnel-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tunnel: { online: true, status: 'online', deviceId: 'dev-1', lastError: null } }),
        };
      }
      if (url.endsWith('/v1/account')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: { id: 'a', email: session.email, limits: { desktopDevices: 1, mobileDevices: 2 } },
            usage: { desktopDevices: 1, mobileDevices: 0 },
          }),
        };
      }
      if (url.endsWith('/v1/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ devices: [{ id: 'dev-1', kind: 'desktop', name: 'PC', platform: 'win32', online: true }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(80);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay, '面板未打开');
    assert(overlay.querySelector('.dshma-sub').textContent === session.email, '已登录应显示账号邮箱');
    assert(!overlay.querySelector('form'), '已登录不应出现登录表单');
    const qr = overlay.querySelector('.dshma-qr svg');
    assert(qr, '默认下载页应显示二维码');
    assert(qr.getAttribute('viewBox') === '0 0 39 39', `二维码白边应为 3 模块，实际 ${qr.getAttribute('viewBox')}`);
    const style = doc.getElementById('dsh-mobile-account-style');
    assert(style && style.textContent.includes('width:220px'), '二维码容器应为 220px');
    const link = overlay.querySelector('.dshma-download-link');
    assert(link, '缺少下载链接');
    assert(link.getAttribute('href') === 'https://dsh.hbzxht.com/download', '下载链接地址错误');
    assert(calls.some((call) => call.url === SESSION_ROUTE), '应请求宿主机会话接口');
    assert(calls.some((call) => call.url.endsWith('/tunnel-status')), '打开面板应读取一次本机隧道状态');
    const tip = overlay.querySelector('.dshma-tip');
    assert(tip, '缺少橙色登录状态 tip');
    assert(tip.textContent.includes('登录状态约 30 天有效'), 'tip 应包含登录状态说明');
    assert(
      tip.textContent.includes('桌面 1/1') && tip.textContent.includes('移动 0/2'),
      `tip 应合并配额，实际：${tip.textContent}`,
    );
    assert(!overlay.textContent.includes('配额'), '不应再有独立配额行');
    const logout = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '退出登录');
    assert(logout, '缺少退出登录按钮');
    logout.click();
    await wait(60);
    const logoutCall = calls.find((call) => call.url === '/plugins/dsh-mobile-tunnel/panel-logout');
    assert(logoutCall && logoutCall.method === 'POST', '退出登录应调用宿主 panel-logout（同源相对路径）');
    assert(!doc.getElementById('dsh-mobile-account-overlay'), '退出成功后应收起面板');
    dispose();
    console.log('scenario 5 (remembered login + QR size + tip + logout) passed');
  }

  // 场景 6：宿主机下发了自定义服务端/下载页地址 → 登录接口与下载链接都跟随配置
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    const fetchImpl = async (input, init) => {
      calls.push({ url: String(input), method: (init && init.method) || 'GET' });
      if (String(input) === SESSION_ROUTE) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session,
            apiBase: 'https://api.example.com',
            downloadUrl: 'https://api.example.com/download',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(30);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay, '面板未打开');
    const link = overlay.querySelector('.dshma-download-link');
    assert(link, '缺少下载链接');
    assert(link.getAttribute('href') === 'https://api.example.com/download', '下载链接应跟随宿主机配置');
    assert(!overlay.querySelector('.dshma-qr svg'), '自定义下载页不应复用默认二维码');
    assert(
      calls.some((call) => call.url.startsWith('https://api.example.com/')),
      '账号接口应跟随宿主机配置的服务端地址',
    );
    dispose();
    console.log('scenario 6 (custom api base + download url) passed');
  }

  // 场景 7：未登录 → 默认选中「注册」
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const fetchImpl = async (input) => {
      if (String(input) === SESSION_ROUTE) {
        return { ok: true, status: 200, json: async () => ({ session: null }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(60);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay, '面板未打开');
    const form = overlay.querySelector('form');
    assert(form, '未登录应出现登录/注册表单');
    const activeTab = overlay.querySelector('.dshma-tab.active');
    assert(activeTab && activeTab.textContent === '注册', `未登录应默认选中注册，实际 ${activeTab && activeTab.textContent}`);
    const submit = overlay.querySelector('.dshma-primary');
    assert(submit && submit.textContent === '注册并登录', `按钮文案应为注册并登录，实际 ${submit && submit.textContent}`);
    assert(overlay.querySelectorAll('.dshma-field')[2].style.display !== 'none', '注册态应显示确认密码');
    const forgot = overlay.querySelector('.dshma-link');
    assert(forgot && forgot.style.display === 'none', '注册态应隐藏忘记密码');
    overlay.querySelectorAll('.dshma-tab')[0].click();
    assert(forgot.style.display !== 'none', '登录态应显示忘记密码');
    overlay.querySelector('input[type="email"]').value = 'someone@example.com';
    forgot.click();
    await wait(50);
    assert(overlay.textContent.includes('第 1 步 / 3'), '点忘记密码应进入三步流程第 1 步');
    assert(!overlay.querySelector('form'), '忘记密码不应再是弹框/内联表单');
    dispose();
    console.log('scenario 7 (default register tab) passed');
  }

  // 场景 8：access token 过期 → 走宿主 panel-refresh 续期，且不能拼上账号服务地址
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    let accountCalls = 0;
    const fetchImpl = async (input) => {
      const url = String(input);
      calls.push({ url });
      if (url === SESSION_ROUTE) {
        return { ok: true, status: 200, json: async () => ({ session, apiBase: 'https://api.example.com' }) };
      }
      if (url === '/plugins/dsh-mobile-tunnel/panel-refresh') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            session: { accessToken: 'at-2', refreshToken: 'rt-2', email: session.email },
          }),
        };
      }
      if (url.endsWith('/tunnel-status')) {
        return { ok: true, status: 200, json: async () => ({ tunnel: { online: true, deviceId: 'dev-1' } }) };
      }
      if (url.endsWith('/v1/account')) {
        accountCalls += 1;
        if (accountCalls === 1) {
          return { ok: false, status: 401, json: async () => ({ error: { code: 'auth.token_expired' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: { id: 'a', email: session.email, limits: { desktopDevices: 2, mobileDevices: 2 } },
            usage: { desktopDevices: 1, mobileDevices: 0 },
          }),
        };
      }
      if (url.endsWith('/v1/devices')) {
        return { ok: true, status: 200, json: async () => ({ devices: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(120);
    assert(
      calls.some((call) => call.url === '/plugins/dsh-mobile-tunnel/panel-refresh'),
      '过期后应走宿主 panel-refresh（相对路径）',
    );
    assert(
      !calls.some((call) => call.url.includes('api.example.com/plugins/')),
      '宿主路由不应拼上账号服务地址',
    );
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay.querySelector('.dshma-tip'), '续期后仍应渲染橙色 tip');
    assert(!overlay.querySelector('.dshma-error'), '续期成功后不应出现错误提示');
    dispose();
    console.log('scenario 8 (host-side refresh, no apiBase prefix) passed');
  }

  // 场景 9：机器短码身份 —— 面板只展示"本机短码 + 服务端认下的设备名"，不出现任何手工认领按钮
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: (init && init.method) || 'GET' });
      if (url === SESSION_ROUTE) {
        return { ok: true, status: 200, json: async () => ({ session, machineName: 'desktop-lfjstdl' }) };
      }
      if (url === '/plugins/dsh-mobile-tunnel/register-device') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, deviceId: '11111111-1111-1111-1111-111111111111', deviceName: '家里台式机', platform: 'win32', online: false }),
        };
      }
      if (url.endsWith('/tunnel-status')) {
        return { ok: true, status: 200, json: async () => ({ tunnel: { online: true, deviceId: '11111111-1111-1111-1111-111111111111' } }) };
      }
      if (url.endsWith('/v1/account')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: { id: 'a', email: session.email, limits: { desktopDevices: 2, mobileDevices: 2 } },
            usage: { desktopDevices: 2, mobileDevices: 0 },
          }),
        };
      }
      if (url.endsWith('/v1/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            devices: [
              { id: '11111111-1111-1111-1111-111111111111', kind: 'desktop', name: '家里台式机', platform: 'win32', online: false, machineName: 'desktop-lfjstdl' },
              { id: '22222222-2222-2222-2222-222222222222', kind: 'desktop', name: '单位笔记本', platform: 'win32', online: true, machineName: 'laptop-office' },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(150);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay, '面板未打开');
    assert(overlay.textContent.includes('家里台式机'), '设备行应显示用户起的设备名');
    assert(overlay.textContent.includes('（DESKTOP-LFJSTDL）'), '本机那行也应显示计算机名称');
    assert(overlay.textContent.includes('（LAPTOP-OFFICE）'), '非本机设备的电脑名称应显示在括号里');
    assert(!overlay.textContent.includes('本机短码'), '不应出现「本机短码」字样');
    assert(!overlay.textContent.includes('（win32）'), '平台类型不应放在括号里');
    assert(!!overlay.querySelector('.dshma-tag'), '本机行应有「本机」标签');
    const meta = overlay.querySelector('.dshma-device-meta');
    assert(meta && meta.textContent === 'win32', '平台类型应以小字放在设备名下方');
    assert(calls.filter((call) => call.url === '/plugins/dsh-mobile-tunnel/register-device').length >= 1, '应自动登记设备（无需用户操作）');
    assert(!overlay.querySelector('.dshma-claim'), '不应出现手工认领区块');
    assert(!overlay.textContent.includes('这台北是'), '不应出现手工认领按钮');
    dispose();
    console.log('scenario 9 (machine short code, auto-identified) passed');
  }

  // 场景 10：修改密码入口 —— 登录态可见，提交后调 /v1/auth/change-password
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
      if (url === SESSION_ROUTE) {
        if ((init && init.method) === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ session, machineName: 'desktop-lfjstdl' }) };
      }
      if (url.endsWith('/tunnel-status')) {
        return { ok: true, status: 200, json: async () => ({ tunnel: { online: true, deviceId: 'dev-1' } }) };
      }
      if (url.endsWith('/v1/account')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: { id: 'a', email: session.email, limits: { desktopDevices: 2, mobileDevices: 2 } },
            usage: { desktopDevices: 1, mobileDevices: 0 },
          }),
        };
      }
      if (url.endsWith('/v1/devices')) {
        return { ok: true, status: 200, json: async () => ({ devices: [] }) };
      }
      if (url.endsWith('/v1/auth/change-password')) {
        return { ok: true, status: 204, json: async () => null };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(120);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    const changeButton = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '修改密码');
    assert(changeButton, '登录态应有「修改密码」入口');
    changeButton.click();
    await wait(30);
    const fields = [...overlay.querySelectorAll('.dshma-field input')];
    assert(fields.length === 3, `修改密码表单应有 3 个输入框，实际 ${fields.length}`);
    fields[0].value = 'old-password-2026';
    fields[1].value = 'New-Strong-Pass-2026';
    fields[2].value = 'New-Strong-Pass-2026';
    overlay.querySelector('.dshma-primary').click();
    await wait(60);
    const changeCall = calls.find((call) => call.url.endsWith('/v1/auth/change-password'));
    assert(changeCall && changeCall.method === 'POST', '提交后应调用 /v1/auth/change-password');
    assert(changeCall.body.includes('New-Strong-Pass-2026'), '请求应带新密码');
    dispose();
    console.log('scenario 10 (change password) passed');
  }

  // 场景 11：自动刷新必须静默 —— 不出现「加载中」，数据没变时连 DOM 都不重建
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    let accountCalls = 0;
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url === SESSION_ROUTE) return { ok: true, status: 200, json: async () => ({ session }) };
      if (url === '/plugins/dsh-mobile-tunnel/register-device') {
        return { ok: true, status: 200, json: async () => ({ ok: true, deviceName: '家里台式机' }) };
      }
      if (url.endsWith('/tunnel-status')) return { ok: true, status: 200, json: async () => ({ tunnel: null }) };
      if (url.endsWith('/v1/account')) {
        accountCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: { id: 'a', email: session.email, limits: { desktopDevices: 2, mobileDevices: 2 } },
            usage: { desktopDevices: 1, mobileDevices: 0 },
          }),
        };
      }
      if (url.endsWith('/v1/devices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            devices: [{ id: 'dev-1', kind: 'desktop', name: '家里台式机', platform: 'win32', online: true, machineName: 'desktop-lfjstdl' }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    // 捕获自动刷新回调，手动触发，避免等 10 秒
    let autoRefresh = null;
    const originalSetInterval = dom.window.setInterval;
    dom.window.setInterval = (callback) => {
      autoRefresh = callback;
      return 0;
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(120);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay && overlay.textContent.includes('家里台式机'), '首次加载应渲染设备行');
    assert(typeof autoRefresh === 'function', '应注册自动刷新定时器');
    const rowBefore = overlay.querySelectorAll('.dshma-row')[1];
    const callsBefore = accountCalls;
    autoRefresh();
    await wait(80);
    assert(!overlay.textContent.includes('加载中'), '自动刷新不应出现「加载中」');
    const rowAfter = overlay.querySelectorAll('.dshma-row')[1];
    assert(rowBefore === rowAfter, '数据没变化时不应重建 DOM（节点应保持同一个）');
    assert(accountCalls > callsBefore, '自动刷新应真的重新拉取了一次数据');
    autoRefresh();
    await wait(80);
    assert(rowBefore === overlay.querySelectorAll('.dshma-row')[1], '第二次静默刷新同样不应重建 DOM');
    dom.window.setInterval = originalSetInterval;
    dispose();
    console.log('scenario 11 (silent in-place refresh) passed');
  }

  // 场景 12：会话被服务端撤销 → 直接回到登录画面，不提示"登录已过期"、不需要点按钮
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const session = { accessToken: 'at', refreshToken: 'rt', email: 'someone@example.com' };
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: (init && init.method) || 'GET' });
      if (url === SESSION_ROUTE) {
        if ((init && init.method) === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ session }) };
      }
      if (url === '/plugins/dsh-mobile-tunnel/register-device') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url === '/plugins/dsh-mobile-tunnel/panel-refresh') {
        return { ok: false, status: 401, json: async () => ({ error: 'revoked' }) };
      }
      if (url.endsWith('/v1/account')) {
        return { ok: false, status: 401, json: async () => ({ error: { code: 'auth.token_expired' } }) };
      }
      if (url.endsWith('/tunnel-status')) return { ok: true, status: 200, json: async () => ({ tunnel: null }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(200);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    assert(overlay, '面板未打开');
    assert(!!overlay.querySelector('form'), '会话过期后应直接显示登录/注册表单');
    assert(!overlay.textContent.includes('登录已过期'), '不应显示「登录已过期」提示');
    assert(![...overlay.querySelectorAll('button')].some((b) => b.textContent === '重新登录'), '不应出现「重新登录」按钮');
    assert(!overlay.textContent.includes('退出登录'), '过期后不应还显示退出登录');
    assert(calls.some((c) => c.url === '/plugins/dsh-mobile-tunnel/panel-refresh'), '过期后应尝试过宿主续期');
    dispose();
    console.log('scenario 12 (expired session returns to login silently) passed');
  }

  // 场景 13：忘记密码三步页 —— 邮箱 → 验证码 → 新密码 → 回登录
  {
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><aside><button class="_2H3hWW_navItem"><svg></svg><span>插件</span></button></aside></body></html>',
      { url: 'http://127.0.0.1:12345/' },
    );
    const calls = [];
    const fetchImpl = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
      if (url === SESSION_ROUTE) {
        if ((init && init.method) === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ session: null }) };
      }
      if (url.endsWith('/v1/auth/forgot-password')) return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) };
      if (url.endsWith('/v1/auth/verify-reset-code')) return { ok: true, status: 200, json: async () => ({ resetToken: 'reset-token-1234567890' }) };
      if (url.endsWith('/v1/auth/reset-password')) return { ok: true, status: 204, json: async () => null };
      if (url.endsWith('/tunnel-status')) return { ok: true, status: 200, json: async () => ({ tunnel: null }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const exportsObj = runBundle(dom.window, fetchImpl);
    const dispose = exportsObj.apply();
    const doc = dom.window.document;
    doc.getElementById('dsh-mobile-account-nav-entry').click();
    await wait(80);
    const overlay = doc.getElementById('dsh-mobile-account-overlay');
    const forgot = overlay.querySelector('.dshma-link');
    assert(forgot && forgot.textContent === '忘记密码', '登录态应有忘记密码入口');
    forgot.click();
    await wait(40);
    assert(overlay.textContent.includes('第 1 步 / 3'), '第 1 步应显示邮箱输入');
    const emailInput = overlay.querySelector('input[type="email"]');
    emailInput.value = 'someone@example.com';
    const send = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '发送验证码');
    assert(send, 
      '第 1 步应有发送验证码按钮',
    );
    send.click();
    await wait(60);
    assert(overlay.textContent.includes('第 2 步 / 3'), '发送后应进入验证码步骤');
    assert(calls.some((c) => c.url.endsWith('/v1/auth/forgot-password')), '应调用 forgot-password');
    const codeInput = overlay.querySelector('input[inputmode="numeric"]');
    codeInput.value = '123456';
    const next = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '下一步');
    next.click();
    await wait(60);
    assert(overlay.textContent.includes('第 3 步 / 3'), '验证码通过后应进入设置新密码');
    assert(calls.some((c) => c.url.endsWith('/v1/auth/verify-reset-code')), '应调用 verify-reset-code');
    const pwFields = [...overlay.querySelectorAll('input[type="password"]')];
    assert(pwFields.length === 2, `新密码步骤应有两个密码框，实际 ${pwFields.length}`);
    pwFields[0].value = 'New-Strong-Pass-2026';
    pwFields[1].value = 'New-Strong-Pass-2026';
    const save = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '保存并返回登录');
    save.click();
    await wait(80);
    const resetCall = calls.find((c) => c.url.endsWith('/v1/auth/reset-password'));
    assert(resetCall && resetCall.body.includes('reset-token-1234567890'), '应带 resetToken 调用 reset-password');
    assert(!!overlay.querySelector('form'), '重置成功后应回到登录界面');
    dispose();
    console.log('scenario 13 (forgot password three steps) passed');
  }

  console.log('client UI check passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
