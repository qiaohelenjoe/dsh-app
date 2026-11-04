import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

let server: Server;
let browser: Browser;
let page: Page;
let baseUrl: string;

async function launchBrowser(): Promise<Browser> {
  const attempts: Array<Record<string, unknown>> = [
    { channel: 'msedge' },
    { channel: 'chrome' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ headless: true, ...attempt });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`无法启动本机浏览器：${(lastError as Error)?.message}`);
}

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const filePath = path.join(PACKAGE_ROOT, url.pathname);
      if (!filePath.startsWith(PACKAGE_ROOT)) {
        response.writeHead(403).end();
        return;
      }
      const content = await readFile(filePath);
      response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
  page = await browser.newPage();
});

after(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function openNarrow(): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/test/fixture.html`, { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      (window as any).__DSH_MOBILE_ADAPT__ !== undefined &&
      document.documentElement.getAttribute('data-dsh-adapt-mode') === 'narrow',
  );
  // 抽屉有 180ms 入场过渡，等过渡结束再测量布局
  await page.waitForTimeout(300);
}

describe('移动适配层真实布局（390×844 / 1024×768）', () => {
  test('390×844：侧栏抽屉化、主区全宽、输入吸底、触控尺寸 ≥44px、面板可收起', async () => {
    await openNarrow();

    const state = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') as HTMLElement;
      const main = document.querySelector('main') as HTMLElement;
      const composer = document.querySelector('#composer-box') as HTMLElement;
      const toggle = document.querySelector('[data-dsh-adapt-toggle]') as HTMLElement;
      const panel = document.querySelector('.terminal-panel') as HTMLElement;
      const sidebarStyle = getComputedStyle(sidebar);
      const composerRect = composer.getBoundingClientRect();
      return {
        mode: document.documentElement.getAttribute('data-dsh-adapt-mode'),
        sidebarPosition: sidebarStyle.position,
        sidebarLeft: sidebar.getBoundingClientRect().left,
        mainWidth: main.getBoundingClientRect().width,
        composerPosition: getComputedStyle(composer).position,
        composerBottom: Math.round(composerRect.bottom),
        viewportHeight: window.innerHeight,
        toggleMinHeight: getComputedStyle(toggle).minHeight,
        toggleHeight: toggle.getBoundingClientRect().height,
        panelMarked: panel.getAttribute('data-dsh-adapt'),
        panelDisplay: getComputedStyle(panel).display,
      };
    });

    assert.equal(state.mode, 'narrow');
    assert.equal(state.sidebarPosition, 'fixed', '侧栏应脱离文档流成为抽屉');
    assert.ok(state.sidebarLeft < 0, `抽屉初始应收起，left=${state.sidebarLeft}`);
    assert.ok(state.mainWidth >= 380, `消息区应占满宽度，实际 ${state.mainWidth}`);
    assert.equal(state.composerPosition, 'fixed', '输入框应吸底');
    assert.ok(Math.abs(state.composerBottom - state.viewportHeight) <= 2, '输入框应贴在视口底部');
    assert.equal(state.toggleMinHeight, '44px');
    assert.ok(state.toggleHeight >= 44, `开关可点高度应 ≥44，实际 ${state.toggleHeight}`);
    assert.equal(state.panelMarked, 'panel');

    // 抽屉打开
    await page.click('[data-dsh-adapt-toggle]');
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') as HTMLElement;
      return {
        drawer: document.documentElement.getAttribute('data-dsh-adapt-drawer'),
        left: Math.round(sidebar.getBoundingClientRect().left),
      };
    });
    assert.equal(opened.drawer, 'open');
    assert.ok(Math.abs(opened.left) <= 1, `抽屉打开后应贴左，left=${opened.left}`);

    // 收起抽屉（关闭遮罩）后再操作面板
    await page.click('[data-dsh-adapt-toggle]');
    await page.waitForTimeout(300);

    // 面板收起/展开
    await page.click('[data-dsh-adapt-panel-toggle]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.terminal-panel') as HTMLElement).display), 'none');
    await page.click('[data-dsh-adapt-panel-toggle]');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.terminal-panel') as HTMLElement).display), 'none');
  });

  test('1024×768：适配样式完全不生效，保持桌面布局', async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${baseUrl}/test/fixture.html`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (window as any).__DSH_MOBILE_ADAPT__ !== undefined &&
        document.documentElement.getAttribute('data-dsh-adapt-mode') === null,
    );

    const state = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-testid="sidebar"]') as HTMLElement;
      const main = document.querySelector('main') as HTMLElement;
      return {
        adaptAttr: document.documentElement.getAttribute('data-dsh-mobile-adapt'),
        modeAttr: document.documentElement.getAttribute('data-dsh-adapt-mode'),
        taggedCount: document.querySelectorAll('[data-dsh-adapt]').length,
        toggleExists: document.querySelector('[data-dsh-adapt-toggle]') !== null,
        styleExists: document.getElementById('dsh-mobile-adapt-style') !== null,
        sidebarPosition: getComputedStyle(sidebar).position,
        sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
        mainWidth: Math.round(main.getBoundingClientRect().width),
      };
    });

    assert.equal(state.adaptAttr, null);
    assert.equal(state.modeAttr, null);
    assert.equal(state.taggedCount, 0, '宽屏不应有任何适配打标');
    assert.equal(state.toggleExists, false);
    assert.equal(state.styleExists, false);
    assert.notEqual(state.sidebarPosition, 'fixed');
    assert.equal(state.sidebarWidth, 240);
    assert.ok(state.mainWidth > 700);
  });

  test('折叠屏切换：1024 → 390 无需刷新即切换布局', async () => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${baseUrl}/test/fixture.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__DSH_MOBILE_ADAPT__ !== undefined);
    await page.evaluate(() => {
      (window as unknown as { __marker: string }).__marker = 'same-document';
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-dsh-adapt-mode') === 'narrow',
    );
    const narrow = await page.evaluate(() => ({
      marker: (window as unknown as { __marker: string }).__marker,
      sidebarPosition: getComputedStyle(document.querySelector('[data-testid="sidebar"]') as HTMLElement).position,
    }));
    assert.equal(narrow.marker, 'same-document', '布局切换不应刷新页面');
    assert.equal(narrow.sidebarPosition, 'fixed');

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-dsh-adapt-mode') === null);
    const wide = await page.evaluate(() => ({
      marker: (window as unknown as { __marker: string }).__marker,
      adaptAttrs: document.querySelectorAll('[data-dsh-adapt]').length,
    }));
    assert.equal(wide.marker, 'same-document');
    assert.equal(wide.adaptAttrs, 0);
  });
});


