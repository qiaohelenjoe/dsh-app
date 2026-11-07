/**
 * 生成 PC 面板「下载手机 App」二维码（离线，构建期一次生成）。
 *
 * 内容 = 最新版 App 下载页地址；二维码中间嵌入仓库里现成的 DeepSeek 黑色鲸鱼标。
 * 产出 `src/app-qr.ts`，由 build-client 内联进客户端 bundle，运行期不依赖任何库。
 *
 * 用法（改下载地址或换 logo 后重跑）：
 *   cd dsh-mobile-tunnel && npm install && npm run gen:qr
 *
 * 依赖 `qrcode-generator`（devDependency，MIT，单文件零依赖）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-generator';

const DOWNLOAD_URL = 'https://dsh.hbzxht.com/download';

/** 从当前文件向上找到仓库根（含 mobile/assets/deepseek-mark.svg 的目录）。 */
function findRepoRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      readFileSync(join(current, 'mobile', 'assets', 'deepseek-mark.svg'));
      return current;
    } catch {
      // 继续向上
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('未找到仓库根（需要 mobile/assets/deepseek-mark.svg）');
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here);
const pluginRoot = join(repoRoot, 'plugin');
const LOGO_FILE = join(repoRoot, 'mobile', 'assets', 'deepseek-mark.svg');
const OUT_FILE = join(pluginRoot, 'src', 'app-qr.ts');

const markSvg = readFileSync(LOGO_FILE, 'utf8');
const markPath = /<path[^>]*\sd="([^"]+)"/.exec(markSvg)?.[1];
if (!markPath) throw new Error(`未在 ${LOGO_FILE} 中找到 <path d="...">`);

// 0 = 自动选择版本；H = 最高纠错等级，给中间 logo 留出可被遮挡的面积
const qr = qrcode(0, 'H');
qr.addData(DOWNLOAD_URL);
qr.make();

const count = qr.getModuleCount();
const quiet = 4;
const total = count + quiet * 2;
const round = (n) => Math.round(n * 100) / 100;

let modules = '';
for (let row = 0; row < count; row += 1) {
  for (let col = 0; col < count; col += 1) {
    if (!qr.isDark(row, col)) continue;
    modules += `M${col + quiet} ${row + quiet}h1v1h-1z`;
  }
}

// 中间：白底圆角方块 + 黑色鲸鱼（24x24 原始坐标，按比例缩放居中）
const logoBox = Math.round(count * 0.3);
const logoX = (total - logoBox) / 2;
const logoY = (total - logoBox) / 2;
const whaleSize = logoBox * 0.72;
const whaleScale = whaleSize / 24;
const whaleX = (total - 24 * whaleScale) / 2;
const whaleY = (total - 24 * whaleScale) / 2;

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="手机 App 下载二维码">`,
  `<rect width="${total}" height="${total}" fill="#fff"/>`,
  `<path d="${modules}" fill="#111" shape-rendering="crispEdges"/>`,
  `<rect x="${round(logoX)}" y="${round(logoY)}" width="${logoBox}" height="${logoBox}" rx="${round(logoBox * 0.18)}" fill="#fff"/>`,
  `<g transform="translate(${round(whaleX)} ${round(whaleY)}) scale(${round(whaleScale)})"><path d="${markPath}" fill="#111"/></g>`,
  '</svg>',
].join('');

const source = `/**
 * 由 \`node scripts/gen-app-qr.mjs\` 生成，勿手改。
 * 二维码内容 = 手机 App 最新版下载页地址，中间为黑色鲸鱼 logo。
 */
export const APP_DOWNLOAD_URL = ${JSON.stringify(DOWNLOAD_URL)};
export const APP_QR_SVG = \`${svg}\`;
`;

writeFileSync(OUT_FILE, source, 'utf8');
console.log(`[gen-app-qr] ${DOWNLOAD_URL} -> ${OUT_FILE} (${svg.length} bytes, ${count}x${count} modules)`);
