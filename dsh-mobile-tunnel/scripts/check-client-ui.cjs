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

  // 场景 5：宿主机已有登录会话 + 默认下载页 → 显示账号信息 + 二维码
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
        return { ok: true, status: 200, json: async () => ({ session }) };
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
    assert(overlay.querySelector('.dshma-sub').textContent === session.email, '已登录应显示账号邮箱');
    assert(!overlay.querySelector('form'), '已登录不应出现登录表单');
    const qr = overlay.querySelector('.dshma-qr svg');
    assert(qr, '默认下载页应显示二维码');
    const link = overlay.querySelector('.dshma-download-link');
    assert(link, '缺少下载链接');
    assert(link.getAttribute('href') === 'https://dsh.hbzxht.com/download', '下载链接地址错误');
    assert(calls.some((call) => call.url === SESSION_ROUTE), '应请求宿主机会话接口');
    dispose();
    console.log('scenario 5 (remembered login + download QR) passed');
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

  console.log('client UI check passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
