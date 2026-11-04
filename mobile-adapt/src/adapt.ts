import { ADAPT_CSS, ADAPT_VERSION, NARROW_MAX_WIDTH } from './styles.js';

export type AdaptMode = 'narrow' | 'wide';

export interface AdaptSelectors {
  root: string;
  sidebar: string;
  main: string;
  composer: string;
  panel: string;
}

export const DEFAULT_SELECTORS: AdaptSelectors = {
  root: '#root, #app, body > div',
  sidebar: '[data-testid*="sidebar" i], aside, nav, [class*="sidebar" i]',
  main: 'main, [role="main"], [class*="main" i]',
  composer: 'textarea, [contenteditable="true"], [role="textbox"]',
  panel: '[class*="terminal" i], [class*="console" i], [class*="panel" i], [data-panel]',
};

/** 最小 Window 接口，便于 jsdom 注入测试（只依赖适配层用到的成员）。 */
export interface AdaptWindow {
  innerWidth: number;
  innerHeight: number;
  matchMedia?: (query: string) => MediaQueryList;
  localStorage?: Storage;
  HTMLElement: typeof HTMLElement;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

export interface CreateAdaptLayerOptions {
  document: Document;
  window: AdaptWindow;
  selectors?: Partial<AdaptSelectors>;
  storageKey?: string;
  version?: string;
}

export interface AdaptLayer {
  readonly version: string;
  enable(): void;
  disable(): void;
  setEnabled(enabled: boolean): void;
  toggle(): boolean;
  isEnabled(): boolean;
  getMode(): AdaptMode;
  refresh(): void;
  destroy(): void;
}

const STYLE_ID = 'dsh-mobile-adapt-style';
const TOGGLE_ATTR = 'data-dsh-adapt-toggle';
const SCRIM_ATTR = 'data-dsh-adapt-scrim';
const PANEL_TOGGLE_ATTR = 'data-dsh-adapt-panel-toggle';
const DRAWER_ATTR = 'data-dsh-adapt-drawer';

export function shouldUseNarrowLayout(width: number): boolean {
  return width <= NARROW_MAX_WIDTH;
}

export function createAdaptLayer(options: CreateAdaptLayerOptions): AdaptLayer {
  const { document: doc, window: win } = options;
  const storageKey = options.storageKey ?? 'dsh.mobileAdapt.enabled';
  const selectors: AdaptSelectors = { ...DEFAULT_SELECTORS, ...options.selectors };
  const version = options.version ?? ADAPT_VERSION;

  let enabled = readEnabled();
  let mode: AdaptMode = 'wide';
  let installed = false;
  let drawerOpen = false;
  let tagged: HTMLElement[] = [];
  let touchStartX = 0;
  let touchStartY = 0;

  function readEnabled(): boolean {
    try {
      return win.localStorage?.getItem(storageKey) !== 'false';
    } catch {
      return true;
    }
  }

  function writeEnabled(value: boolean): void {
    try {
      win.localStorage?.setItem(storageKey, value ? 'true' : 'false');
    } catch {
      // 忽略隐私模式下的存储异常
    }
  }

  function detectMode(): AdaptMode {
    const width = win.innerWidth || doc.documentElement.clientWidth || 0;
    return shouldUseNarrowLayout(width) ? 'narrow' : 'wide';
  }

  function ensureStyle(): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = ADAPT_CSS;
    doc.head.appendChild(style);
  }

  function removeStyle(): void {
    doc.getElementById(STYLE_ID)?.remove();
  }

  function queryFirst(selector: string): HTMLElement | null {
    return doc.querySelector<HTMLElement>(selector);
  }

  function tag(element: HTMLElement | null, value: string): void {
    if (!element) return;
    element.setAttribute('data-dsh-adapt', value);
    tagged.push(element);
  }

  /** 几何启发式：DSH 的类名是哈希，按位置/尺寸兜底识别侧栏与主区。 */
  function tagByGeometry(): void {
    const root = queryFirst(selectors.root) ?? doc.body.firstElementChild as HTMLElement | null;
    if (!root) return;
    const children = Array.from(root.children).filter((element): element is HTMLElement => element instanceof win.HTMLElement);
    if (children.length < 2) return;
    const viewportHeight = win.innerHeight || 0;
    let sidebar: HTMLElement | null = null;
    let main: HTMLElement | null = null;
    for (const child of children) {
      const width = child.offsetWidth;
      const height = child.offsetHeight;
      if (width <= 0 || height <= 0) continue;
      const looksLikeSidebar = width >= 120 && width <= 420 && height >= viewportHeight * 0.5;
      if (looksLikeSidebar && (!sidebar || width < sidebar.offsetWidth)) sidebar = child;
      else if (!main || width > main.offsetWidth) main = child;
    }
    tag(queryFirst(selectors.sidebar) ?? sidebar, 'sidebar');
    tag(queryFirst(selectors.main) ?? main, 'main');
  }

  function findComposerContainer(element: HTMLElement): HTMLElement {
    let current: HTMLElement = element;
    const main = queryFirst('[data-dsh-adapt="main"]');
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = current.parentElement;
      if (!parent) break;
      if (main && parent === main) break;
      current = parent;
    }
    return current;
  }

  function ensureToggleButton(): void {
    if (doc.querySelector(`[${TOGGLE_ATTR}]`)) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute(TOGGLE_ATTR, 'true');
    button.setAttribute('aria-label', '打开侧栏');
    button.textContent = '☰';
    button.addEventListener('click', () => setDrawer(!drawerOpen));
    doc.body.appendChild(button);
  }

  function ensurePanelToggle(): void {
    const panel = doc.querySelector<HTMLElement>('[data-dsh-adapt="panel"]');
    if (!panel || doc.querySelector(`[${PANEL_TOGGLE_ATTR}]`)) return;
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute(PANEL_TOGGLE_ATTR, 'true');
    button.setAttribute('aria-label', '展开/收起面板');
    button.textContent = '面板';
    button.addEventListener('click', () => {
      const collapsed = panel.getAttribute('data-dsh-adapt-panel-collapsed') === 'true';
      panel.setAttribute('data-dsh-adapt-panel-collapsed', collapsed ? 'false' : 'true');
    });
    doc.body.appendChild(button);
  }

  function ensureScrim(): void {
    if (doc.querySelector(`[${SCRIM_ATTR}]`)) return;
    const scrim = doc.createElement('div');
    scrim.setAttribute(SCRIM_ATTR, 'true');
    scrim.addEventListener('click', () => setDrawer(false));
    doc.body.appendChild(scrim);
  }

  function setDrawer(open: boolean): void {
    drawerOpen = open;
    const html = doc.documentElement;
    if (open) html.setAttribute(DRAWER_ATTR, 'open');
    else html.removeAttribute(DRAWER_ATTR);
  }

  function onTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
  }

  function onTouchEnd(event: TouchEvent): void {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;
    if (Math.abs(deltaY) > 60) return;
    if (!drawerOpen && touchStartX <= 24 && deltaX >= 60) setDrawer(true);
    else if (drawerOpen && deltaX <= -60) setDrawer(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && drawerOpen) setDrawer(false);
  }

  function cleanupNarrow(): void {
    for (const element of tagged) element.removeAttribute('data-dsh-adapt');
    tagged = [];
    for (const element of Array.from(doc.querySelectorAll<HTMLElement>('[data-dsh-adapt]'))) {
      element.removeAttribute('data-dsh-adapt');
    }
    doc.querySelector(`[${TOGGLE_ATTR}]`)?.remove();
    doc.querySelector(`[${SCRIM_ATTR}]`)?.remove();
    doc.querySelector(`[${PANEL_TOGGLE_ATTR}]`)?.remove();
    setDrawer(false);
    for (const element of Array.from(doc.querySelectorAll<HTMLElement>('[data-dsh-adapt-panel-collapsed]'))) {
      element.removeAttribute('data-dsh-adapt-panel-collapsed');
    }
  }

  function installListeners(): void {
    if (installed) return;
    installed = true;
    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true });
    doc.addEventListener('keydown', onKeyDown);
    win.addEventListener('resize', refresh);
    win.matchMedia?.(`(max-width: ${NARROW_MAX_WIDTH}px)`)?.addEventListener?.('change', refresh);
  }

  function removeListeners(): void {
    if (!installed) return;
    installed = false;
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('touchend', onTouchEnd);
    doc.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('resize', refresh);
    win.matchMedia?.(`(max-width: ${NARROW_MAX_WIDTH}px)`)?.removeEventListener?.('change', refresh);
  }

  function refresh(): void {
    const html = doc.documentElement;
    const nextMode = detectMode();

    if (!enabled) {
      mode = nextMode;
      cleanupNarrow();
      removeStyle();
      removeListeners();
      html.removeAttribute('data-dsh-mobile-adapt');
      html.removeAttribute('data-dsh-adapt-mode');
      return;
    }

    // 监听必须常驻（即使当前是宽屏），否则折叠屏 1024 → 390 永远不会触发切换
    installListeners();

    if (nextMode === 'wide') {
      mode = 'wide';
      cleanupNarrow();
      removeStyle();
      html.removeAttribute('data-dsh-mobile-adapt');
      html.removeAttribute('data-dsh-adapt-mode');
      return;
    }

    mode = 'narrow';
    html.setAttribute('data-dsh-mobile-adapt', 'on');
    html.setAttribute('data-dsh-adapt-mode', 'narrow');
    ensureStyle();
    tagByGeometry();
    const composerInput = queryFirst(selectors.composer);
    if (composerInput) tag(findComposerContainer(composerInput), 'composer');
    const panels = Array.from(doc.querySelectorAll<HTMLElement>(selectors.panel));
    for (const panel of panels.slice(0, 3)) tag(panel, 'panel');
    ensureToggleButton();
    ensureScrim();
    ensurePanelToggle();
    installListeners();
  }

  return {
    version,
    enable(): void {
      enabled = true;
      writeEnabled(true);
      refresh();
    },
    disable(): void {
      enabled = false;
      writeEnabled(false);
      refresh();
    },
    setEnabled(value: boolean): void {
      if (value) this.enable();
      else this.disable();
    },
    toggle(): boolean {
      if (enabled) this.disable();
      else this.enable();
      return enabled;
    },
    isEnabled(): boolean {
      return enabled;
    },
    getMode(): AdaptMode {
      return mode;
    },
    refresh,
    destroy(): void {
      cleanupNarrow();
      removeStyle();
      removeListeners();
      doc.documentElement.removeAttribute('data-dsh-mobile-adapt');
      doc.documentElement.removeAttribute('data-dsh-adapt-mode');
    },
  };
}

declare global {
  interface Window {
    __DSH_MOBILE_ADAPT__?: AdaptLayer;
  }
}

/**
 * 客户端插件入口：在 DSH Web 前端加载时自动安装。
 * 手机壳注入脚本可通过 window.__DSH_MOBILE_ADAPT__ 控制开关。
 */
export function installAdaptLayer(): AdaptLayer | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (window.__DSH_MOBILE_ADAPT__) return window.__DSH_MOBILE_ADAPT__;
  const layer = createAdaptLayer({ document, window: window as unknown as AdaptWindow });
  window.__DSH_MOBILE_ADAPT__ = layer;
  const start = (): void => layer.refresh();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  return layer;
}

installAdaptLayer();
