export const ADAPT_VERSION = '0.1.0';

/** 窄屏断点（短边/宽度）：< 900px 视为手机形态，与规格 §7.2 一致。 */
export const NARROW_MAX_WIDTH = 899;

/**
 * 适配层样式（唯一来源）。
 * 全部规则都限定在 `html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"]` 下，
 * 因此宽屏（桌面布局）下不产生任何样式影响（T10 验收 4）。
 */
export const ADAPT_CSS = `
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] {
  --dsh-adapt-touch: 44px;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt="main"] {
  width: 100% !important;
  min-width: 0 !important;
  flex: 1 1 auto !important;
  padding-bottom: 96px;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt="sidebar"] {
  position: fixed !important;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(82vw, 320px) !important;
  max-width: 320px;
  z-index: 2147483000;
  transform: translateX(-102%);
  transition: transform 180ms ease-out;
  box-shadow: 0 0 24px rgb(0 0 0 / 35%);
  background: var(--dsw-alias-bg-base, var(--dsh-bg-base, #ffffff));
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"][data-dsh-adapt-drawer="open"] [data-dsh-adapt="sidebar"] {
  transform: translateX(0);
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt-scrim] {
  display: none;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"][data-dsh-adapt-drawer="open"] [data-dsh-adapt-scrim] {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 2147482999;
  background: rgb(0 0 0 / 40%);
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt="composer"] {
  position: fixed !important;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147482000;
  background: var(--dsw-alias-bg-base, var(--dsh-bg-base, #ffffff));
  padding-bottom: env(safe-area-inset-bottom, 0);
  box-shadow: 0 -2px 12px rgb(0 0 0 / 12%);
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] button,
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [role="button"],
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt-toggle] {
  min-width: var(--dsh-adapt-touch);
  min-height: var(--dsh-adapt-touch);
  touch-action: manipulation;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt="panel"] {
  max-height: 40vh;
  overflow: auto;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt-panel-collapsed="true"] {
  display: none !important;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt-toggle] {
  position: fixed;
  left: 8px;
  top: 8px;
  z-index: 2147483001;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 12px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 20px;
}
html[data-dsh-mobile-adapt="on"][data-dsh-adapt-mode="narrow"] [data-dsh-adapt-panel-toggle] {
  position: fixed;
  right: 8px;
  bottom: calc(88px + env(safe-area-inset-bottom, 0px));
  z-index: 2147482001;
  border: 0;
  border-radius: 12px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  font-size: 14px;
  padding: 0 12px;
}
`;
