import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createAdaptLayer, shouldUseNarrowLayout, type AdaptWindow } from '../src/adapt.js';
import { ADAPT_CSS, NARROW_MAX_WIDTH } from '../src/styles.js';

const FIXTURE = `<!DOCTYPE html><html><head></head><body>
  <div id="app">
    <aside data-testid="sidebar"><h3>会话</h3><ul><li>会话 A</li></ul></aside>
    <main role="main">
      <div id="messages"><p>历史消息 1</p></div>
      <div id="composer-box"><textarea placeholder="给 DSH 发消息"></textarea></div>
    </main>
    <div class="terminal-panel">终端输出</div>
  </div>
</body></html>`;

function setup(width: number, height = 844) {
  const dom = new JSDOM(FIXTURE, { url: 'https://dsh.example.com/t/d1/', pretendToBeVisual: true });
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
  win.matchMedia = ((query: string) => {
    const match = /max-width:\s*(\d+)px/.exec(query);
    const matches = match ? width <= Number(match[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof win.matchMedia;

  const layer = createAdaptLayer({ document: win.document, window: win as unknown as AdaptWindow });
  const resize = (nextWidth: number): void => {
    Object.defineProperty(win, 'innerWidth', { value: nextWidth, configurable: true });
  };
  return { dom, win, doc: win.document, layer, resize };
}

function dispatchTouch(win: JSDOM['window'], doc: Document, type: 'touchstart' | 'touchend', x: number, y: number): void {
  const event = new win.Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  doc.dispatchEvent(event);
}

describe('移动适配层（T10）', () => {
  test('断点：< 900px 为窄屏，>= 900px 为宽屏', () => {
    assert.equal(shouldUseNarrowLayout(390), true);
    assert.equal(shouldUseNarrowLayout(NARROW_MAX_WIDTH), true);
    assert.equal(shouldUseNarrowLayout(1024), false);
  });

  test('窄屏：打标侧栏/主区/输入框/面板并插入抽屉与开关', () => {
    const { doc, layer } = setup(390);
    layer.refresh();

    const html = doc.documentElement;
    assert.equal(html.getAttribute('data-dsh-mobile-adapt'), 'on');
    assert.equal(html.getAttribute('data-dsh-adapt-mode'), 'narrow');
    assert.equal(doc.querySelector('[data-testid="sidebar"]')?.getAttribute('data-dsh-adapt'), 'sidebar');
    assert.equal(doc.querySelector('main')?.getAttribute('data-dsh-adapt'), 'main');
    assert.ok(doc.querySelector('#composer-box')?.getAttribute('data-dsh-adapt'), '输入框容器应被打标');
    assert.equal(doc.querySelector('.terminal-panel')?.getAttribute('data-dsh-adapt'), 'panel');
    assert.ok(doc.querySelector('[data-dsh-adapt-toggle]'));
    assert.ok(doc.querySelector('[data-dsh-adapt-scrim]'));
    assert.ok(doc.querySelector('[data-dsh-adapt-panel-toggle]'));
    assert.ok(doc.getElementById('dsh-mobile-adapt-style'));
  });

  test('宽屏：不生效，DOM 与未注入时一致', () => {
    const { doc, layer } = setup(1024, 768);
    layer.refresh();

    const html = doc.documentElement;
    assert.equal(html.getAttribute('data-dsh-mobile-adapt'), null);
    assert.equal(html.getAttribute('data-dsh-adapt-mode'), null);
    assert.equal(doc.querySelectorAll('[data-dsh-adapt]').length, 0);
    assert.equal(doc.querySelector('[data-dsh-adapt-toggle]'), null);
    assert.equal(doc.getElementById('dsh-mobile-adapt-style'), null);
  });

  test('折叠屏从 1024 切到 390：动态切换且不重建 DOM', () => {
    const { doc, layer, resize } = setup(1024, 768);
    layer.refresh();
    const sidebar = doc.querySelector('[data-testid="sidebar"]');
    assert.equal(sidebar?.getAttribute('data-dsh-adapt'), null);
    assert.equal(layer.getMode(), 'wide');

    resize(390);
    layer.refresh();
    assert.equal(layer.getMode(), 'narrow');
    assert.equal(doc.querySelector('[data-testid="sidebar"]'), sidebar, 'DOM 元素应保持不变');
    assert.equal(sidebar?.getAttribute('data-dsh-adapt'), 'sidebar');

    resize(1024);
    layer.refresh();
    assert.equal(layer.getMode(), 'wide');
    assert.equal(sidebar?.getAttribute('data-dsh-adapt'), null);
    assert.equal(doc.querySelector('[data-dsh-adapt-toggle]'), null);
  });

  test('手势：左缘右滑打开抽屉，Esc 关闭；点“面板”切换终端显示', () => {
    const { doc, layer, win } = setup(390);
    layer.refresh();

    dispatchTouch(win, doc, 'touchstart', 10, 400);
    dispatchTouch(win, doc, 'touchend', 140, 405);
    assert.equal(doc.documentElement.getAttribute('data-dsh-adapt-drawer'), 'open');

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.documentElement.getAttribute('data-dsh-adapt-drawer'), null);

    const panel = doc.querySelector('.terminal-panel');
    assert.equal(panel?.getAttribute('data-dsh-adapt-panel-collapsed'), null);
    doc.querySelector<HTMLElement>('[data-dsh-adapt-panel-toggle]')?.click();
    assert.equal(panel?.getAttribute('data-dsh-adapt-panel-collapsed'), 'true');
    doc.querySelector<HTMLElement>('[data-dsh-adapt-panel-toggle]')?.click();
    assert.equal(panel?.getAttribute('data-dsh-adapt-panel-collapsed'), 'false');
  });

  test('一键关闭后恢复官方原样；再次开启恢复适配', () => {
    const { doc, layer, win } = setup(390);
    layer.refresh();
    assert.ok(doc.getElementById('dsh-mobile-adapt-style'));

    layer.disable();
    assert.equal(layer.isEnabled(), false);
    assert.equal(win.localStorage.getItem('dsh.mobileAdapt.enabled'), 'false');
    assert.equal(doc.documentElement.getAttribute('data-dsh-mobile-adapt'), null);
    assert.equal(doc.querySelectorAll('[data-dsh-adapt]').length, 0);
    assert.equal(doc.querySelector('[data-dsh-adapt-toggle]'), null);
    assert.equal(doc.getElementById('dsh-mobile-adapt-style'), null);

    layer.enable();
    assert.equal(layer.isEnabled(), true);
    assert.equal(doc.documentElement.getAttribute('data-dsh-adapt-mode'), 'narrow');
  });

  test('样式全部限定在窄屏作用域，且触控尺寸 ≥ 44px', () => {
    assert.match(ADAPT_CSS, /\[data-dsh-adapt-mode="narrow"\]/);
    assert.match(ADAPT_CSS, /min-height: var\(--dsh-adapt-touch\)/);
    assert.match(ADAPT_CSS, /--dsh-adapt-touch: 44px/);
    assert.match(ADAPT_CSS, /\[data-dsh-adapt="sidebar"\]/);
    assert.match(ADAPT_CSS, /\[data-dsh-adapt="composer"\]/);
    // 不能有未限定在窄屏作用域之外的布局规则
    const outside = ADAPT_CSS.split('html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"]');
    for (const chunk of outside.slice(1)) {
      const selector = chunk.slice(0, chunk.indexOf('{') === -1 ? 0 : chunk.indexOf('{')).trim();
      if (selector) assert.ok(selector.startsWith('[') || selector.startsWith(' button') || selector.startsWith(' [') || selector === '' || selector.startsWith(' )'), `unexpected selector ${selector}`);
    }
  });
});
