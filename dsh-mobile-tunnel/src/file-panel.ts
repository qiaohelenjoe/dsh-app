/// <reference lib="dom" />
/**
 * 移动端文件面板（树形 + 多页签，仿官方「工作区文件」）。
 *
 * 官方文档预览依赖 `ctx.resources` 的 file 协议，移动端缺该服务，点开文件只会提示
 * 「文件资源服务不可用」。这里不改官方 UI：移动端右下角一个悬浮入口 / 桌面按
 * Ctrl+Shift+M，打开自己的面板。
 *
 * 数据走宿主只读 HTTP（不用 `remote.workspaceFiles`：声明 inject 会阻塞插件启动，
 * 反应式注入又被 Cordis 拒绝）：
 * - `/plugins/dsh-mobile-tunnel/fs-roots`      当前会话工作区（唯一根）
 * - `/plugins/dsh-mobile-tunnel/fs?path=`      列目录（宿主限定在工作区内）
 * - `/plugins/dsh-mobile-tunnel/fs-file?path=` 读文件（文本 JSON / 图片原始字节）
 *
 * 交互仿官方：顶部是页签条（「文件」页签 = 目录树，点文件在右侧新开页签），
 * 页签下方是灰色路径行；目录树按需加载，每层缩进。
 */

const GUIDE_ENTRY_ID = 'dsh-mobile-files-guide-entry';

const HIDDEN_FLAG = 'data-dshmf-hidden';

const PANEL_ID = 'dsh-mobile-files-panel';
const STYLE_ID = 'dsh-mobile-files-style';
const PANEL_VERSION = '__PKG_VERSION__';
const BASE = '/plugins/dsh-mobile-tunnel';
const DIAG_ROUTE = BASE + '/diag';
const ROOTS_ROUTE = BASE + '/fs-roots';
const LIST_ROUTE = BASE + '/fs';
const FILE_ROUTE = BASE + '/fs-file';

interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error: string;
  children: TreeNode[];
}

interface TabState {
  key: string;
  label: string;
  path: string;
  kind: 'tree' | 'file';
}

function fpIsMobile(): boolean {
  if (document.documentElement?.getAttribute('data-dsh-mobile-app') === '1') return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** 把根绝对路径拼到 DSH 当前挂载前缀下（中继可能把页面挂在 /t/<deviceId>/）。 */
function fpUrl(path: string): string {
  const transport = (window as unknown as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } })
    .__DSH_TRANSPORT__;
  const base =
    typeof transport?.streamBaseUrl === 'string' && transport.streamBaseUrl
      ? transport.streamBaseUrl
      : location.origin + '/';
  try {
    return new URL(path.replace(/^\//, ''), base).toString();
  } catch {
    return path;
  }
}

/** 自报诊断日志到宿主（sendBeacon；失败不影响主流程）。 */
function fpReport(message: string): void {
  if (typeof location === 'undefined' || typeof navigator === 'undefined') return;
  const payload = JSON.stringify({ msg: message, href: location.href, mobile: fpIsMobile() });
  const urls: string[] = [];
  urls.push(fpUrl(DIAG_ROUTE));
  const direct = location.origin + DIAG_ROUTE;
  if (!urls.includes(direct)) urls.push(direct);
  for (const url of urls) {
    try {
      if (typeof navigator.sendBeacon === 'function') navigator.sendBeacon(url, payload);
    } catch {
      // 忽略
    }
  }
}

/** 依次尝试候选前缀，返回第一个成功解析的 JSON。 */
async function fpJson<T>(path: string): Promise<T> {
  const candidates: string[] = [];
  const push = (url: string): void => {
    if (url && !candidates.includes(url)) candidates.push(url);
  };
  push(fpUrl(path));
  push(location.origin + path);
  const prefix = /^\/t\/[^/]+/.exec(location.pathname);
  if (prefix) push(location.origin + prefix[0] + path);
  const failures: string[] = [];
  for (const url of candidates) {
    const controller = new AbortController();
    const guard = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        failures.push(url + ' → HTTP ' + response.status);
        continue;
      }
      return (await response.json()) as T;
    } catch (error) {
      failures.push(url + ' → ' + String((error as Error)?.name ?? error));
    } finally {
      window.clearTimeout(guard);
    }
  }
  throw new Error(failures.join(' | '));
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 从 localStorage 猜当前会话 id（宿主用它定位工作区）。 */
function currentSessionId(): string {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index) ?? '';
      if (!/session/i.test(key)) continue;
      const value = localStorage.getItem(key) ?? '';
      const match = UUID_RE.exec(value) ?? UUID_RE.exec(key);
      if (match) return match[0];
    }
  } catch {
    // 忽略
  }
  return '';
}

function withSession(path: string): string {
  const session = currentSessionId();
  if (!session) return path;
  return path + (path.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(session);
}

function joinPath(parent: string, name: string): string {
  const base = parent.replace(/[/\\]+$/, '');
  const sep = parent.includes('\\') || /^[A-Za-z]:/.test(parent) ? '\\' : '/';
  return base + sep + name;
}

const FILE_PANEL_STYLE = `
#${PANEL_ID}{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--dshmf-bg,#fff);color:var(--dshmf-fg,#1c2330);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
#${PANEL_ID} .dshmf-head{flex:none;padding:8px 10px 0;border-bottom:1px solid rgba(120,130,150,.14)}
#${PANEL_ID} .dshmf-tabrow{display:flex;align-items:flex-end;gap:6px;overflow-x:auto;scrollbar-width:none}
#${PANEL_ID} .dshmf-tabrow::-webkit-scrollbar{display:none}
#${PANEL_ID} .dshmf-tab{display:inline-flex;align-items:center;gap:7px;padding:8px 10px;border-radius:10px 10px 0 0;background:transparent;font-size:13px;color:#6b7484;cursor:pointer;flex:none;max-width:56vw}
#${PANEL_ID} .dshmf-tab.active{background:rgba(120,130,150,.13);color:inherit;font-weight:600}
#${PANEL_ID} .dshmf-tabicon{font-size:14px;flex:none}
#${PANEL_ID} .dshmf-tablabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .dshmf-tabclose{border:0;background:transparent;color:#9aa3b2;font-size:16px;line-height:1;padding:0 0 0 2px;cursor:pointer;flex:none}
#${PANEL_ID} .dshmf-headrow{display:flex;align-items:flex-end;gap:8px}
#${PANEL_ID} .dshmf-tabrow{flex:1;min-width:0}
#${PANEL_ID} .dshmf-path{padding:10px 14px;color:#9aa3b2;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
#${PANEL_ID} .dshmf-status{padding:0 14px 8px;font-size:11px;color:#c2410c;flex:none}
#${PANEL_ID} .dshmf-status:empty{display:none}
#${PANEL_ID} .dshmf-body{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:4px 6px 48px}
#${PANEL_ID} .dshmf-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;text-align:left;padding:9px 10px;margin:1px 0;border-radius:8px;cursor:pointer}
#${PANEL_ID} .dshmf-row:hover{background:rgba(120,130,150,.10)}
#${PANEL_ID} .dshmf-row:active{background:rgba(120,130,150,.16)}
#${PANEL_ID} .dshmf-icon{width:20px;flex:none;text-align:center;font-size:15px}
#${PANEL_ID} .dshmf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .dshmf-size{font-size:11px;color:#9aa3b2;flex:none}
#${PANEL_ID} .dshmf-hint{padding:6px 10px;font-size:12px;color:#9aa3b2}
#${PANEL_ID} .dshmf-pre{margin:0;padding:12px 14px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
#${PANEL_ID} .dshmf-msg{padding:28px 16px;color:#9aa3b2;font-size:13px;text-align:center}
#${PANEL_ID} .dshmf-img{max-width:100%;display:block;margin:0 auto;padding:12px 0}
#${PANEL_ID} code{background:rgba(120,130,150,.14);padding:1px 4px;border-radius:4px;font-size:.92em;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
#${PANEL_ID} .dshmf-md-h{margin:16px 14px 6px;line-height:1.35;font-weight:650}
#${PANEL_ID} .dshmf-md-h1{font-size:20px}
#${PANEL_ID} .dshmf-md-h2{font-size:18px}
#${PANEL_ID} .dshmf-md-h3{font-size:16px}
#${PANEL_ID} .dshmf-md-h4,#${PANEL_ID} .dshmf-md-h5,#${PANEL_ID} .dshmf-md-h6{font-size:14px}
#${PANEL_ID} .dshmf-md-p{margin:6px 14px;line-height:1.65;font-size:14px}
#${PANEL_ID} .dshmf-md-list{margin:6px 14px 6px 30px;padding:0;font-size:14px;line-height:1.65}
#${PANEL_ID} .dshmf-md-quote{margin:8px 14px;padding:6px 10px;border-left:3px solid rgba(120,130,150,.35);color:#6b7484;font-size:13px}
#${PANEL_ID} .dshmf-md-code{margin:8px 14px;padding:10px;background:rgba(120,130,150,.09);border-radius:8px;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto}
#${PANEL_ID} .dshmf-md-hr{border:0;border-top:1px solid rgba(120,130,150,.2);margin:16px 14px}
#${PANEL_ID} .dshmf-md a{color:#4f7cff;text-decoration:none}
#${PANEL_ID} .dshmf-img{cursor:zoom-in}
#${PANEL_ID} .dshmf-img.zoomed{max-width:none;width:auto;cursor:zoom-out}
#${PANEL_ID} .dshmf-code{display:flex;align-items:flex-start;background:#fafbfc;border-radius:8px;margin:6px;overflow:hidden}
#${PANEL_ID} .dshmf-gutter{flex:none;padding:12px 8px 12px 12px;text-align:right;color:#b3bac6;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;user-select:none;border-right:1px solid rgba(120,130,150,.14)}
#${PANEL_ID} .dshmf-code-pre{margin:0;padding:12px 14px 12px 10px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow:auto;flex:1;min-width:0}
#${PANEL_ID} .dshmf-tok-comment{color:#8a93a3;font-style:italic}
#${PANEL_ID} .dshmf-tok-string{color:#0a7d33}
#${PANEL_ID} .dshmf-tok-number{color:#b45309}
#${PANEL_ID} .dshmf-tok-keyword{color:#7c3aed;font-weight:600}
`;

function fpEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fpSize(size?: number): string {
  if (!size || size < 0) return '';
  if (size < 1024) return String(size) + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

/** 按扩展名给图标（仿官方）。 */
function fpIcon(name: string, isDir: boolean, expanded: boolean): string {
  if (isDir) return expanded ? '📂' : '📁';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'md' || ext === 'markdown') return '📘';
  if (ext === 'json' || ext === 'yml' || ext === 'yaml' || ext === 'toml') return '🧾';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs') return '📜';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg') return '🖼';
  if (ext === 'ps1' || ext === 'bat' || ext === 'cmd' || ext === 'sh') return '⚙️';
  return '📄';
}

const FP_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const FP_TEXT_EXT = new Set([
  'txt', 'log', 'md', 'markdown', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'vue',
  'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'cs', 'php', 'rb', 'swift', 'dart',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'gradle', 'properties', 'lock', 'gitignore',
  'dockerfile', 'editorconfig', 'csv', 'tsv', 'diff', 'patch',
]);

function fpExtOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile' || lower === '.gitignore' || lower === '.env') {
    return lower.replace(/^\./, '');
  }
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : '';
}

/** 只有可执行文件/压缩包/媒体/字体等二进制不可预览，其余都当文本或图片看。 */
const FP_BLOCKED_EXT = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'sys', 'o', 'obj', 'class', 'jar', 'war', 'apk', 'ipa',
  'deb', 'rpm', 'dmg', 'iso', 'img', 'vhd', 'vhdx',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'cab',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'db', 'sqlite', 'sqlite3', 'pyc', 'node',
]);

function fpSupported(name: string): boolean {
  const ext = fpExtOf(name);
  if (FP_BLOCKED_EXT.has(ext)) return false;
  return true;
}

function fpEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 极简 Markdown 渲染（不引入依赖）：标题、粗斜体、行内代码、代码块、列表、引用、链接。 */
function fpRenderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = source.split(/\r?\n/);
  let list: HTMLElement | null = null;
  let index = 0;
  const inline = (text: string): string =>
    fpEscape(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  while (index < lines.length) {
    const line = lines[index] as string;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      const pre = fpEl('pre', 'dshmf-md-code', code.join('\n'));
      fragment.appendChild(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const el = fpEl(('h' + String(Math.min(level, 4))) as 'h1');
      el.className = 'dshmf-md-h dshmf-md-h' + String(level);
      el.innerHTML = inline(heading[2] as string);
      fragment.appendChild(el);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      fragment.appendChild(fpEl('hr', 'dshmf-md-hr'));
      index += 1;
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const tag = bullet ? 'ul' : 'ol';
      if (!list || (list.tagName.toLowerCase() !== tag)) {
        list = document.createElement(tag);
        list.className = 'dshmf-md-list';
        fragment.appendChild(list);
      }
      const li = document.createElement('li');
      li.innerHTML = inline((bullet ?? ordered)?.[1] ?? '');
      list.appendChild(li);
      index += 1;
      continue;
    }
    list = null;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const block = fpEl('blockquote', 'dshmf-md-quote');
      block.innerHTML = inline(quote[1] as string);
      fragment.appendChild(block);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const para = fpEl('p', 'dshmf-md-p');
    para.innerHTML = inline(line);
    fragment.appendChild(para);
    index += 1;
  }
  return fragment;
}

/** JSON 美化；失败就原样返回。 */
function fpPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 各语言关键字（够用即可，不做完整词法分析）。 */
const FP_KEYWORDS: Record<string, string[]> = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'null', 'undefined', 'true', 'false', 'void', 'delete', 'yield', 'static', 'get', 'set', 'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly', 'namespace', 'declare', 'as', 'satisfies', 'keyof'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'global', 'nonlocal', 'pass', 'yield', 'async', 'await', 'assert', 'del'],
  go: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'break', 'continue', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'var', 'const', 'nil', 'true', 'false', 'make', 'new', 'append', 'error'],
  rs: ['fn', 'let', 'mut', 'const', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'Some', 'None', 'Ok', 'Err', 'async', 'await', 'move', 'where', 'dyn', 'ref', 'unsafe'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'exists', 'union', 'all', 'distinct', 'case', 'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'index', 'default', 'constraint', 'begin', 'commit', 'rollback'],
  sh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'local', 'export', 'echo', 'exit', 'set', 'source', 'cd', 'readonly', 'shift'],
  ps1: ['param', 'function', 'if', 'else', 'elseif', 'foreach', 'for', 'while', 'do', 'switch', 'return', 'try', 'catch', 'finally', 'throw', 'begin', 'process', 'end', 'filter', 'class', 'enum', 'using', 'Set-StrictMode', 'Write-Host', 'Write-Output', 'Get-Item', 'Get-ChildItem', 'Test-Path', 'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item'],
  css: ['important', 'media', 'import', 'keyframes', 'root', 'hover', 'active', 'focus', 'before', 'after', 'not', 'nth-child'],
  html: [],
  yaml: ['true', 'false', 'null', 'yes', 'no'],
  c: ['int', 'char', 'float', 'double', 'void', 'struct', 'union', 'enum', 'typedef', 'static', 'const', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'sizeof', 'include', 'define', 'class', 'public', 'private', 'protected', 'virtual', 'override', 'namespace', 'using', 'template', 'typename', 'new', 'delete', 'nullptr', 'true', 'false', 'auto', 'import', 'package', 'extends', 'implements', 'interface', 'final', 'throws', 'try', 'catch', 'finally', 'fun', 'val', 'var', 'when', 'object', 'data'],
};

function fpLangOf(ext: string): string {
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'jsonc'].includes(ext)) return 'js';
  if (['py'].includes(ext)) return 'py';
  if (['go'].includes(ext)) return 'go';
  if (['rs'].includes(ext)) return 'rs';
  if (['java', 'kt', 'cs', 'php', 'rb', 'swift', 'dart'].includes(ext)) return 'c';
  if (['c', 'h', 'cc', 'cpp', 'hpp'].includes(ext)) return 'c';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'sh';
  if (['ps1'].includes(ext)) return 'ps1';
  if (['bat', 'cmd'].includes(ext)) return 'ps1';
  if (['sql'].includes(ext)) return 'sql';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'properties'].includes(ext)) return 'yaml';
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html';
  return 'text';
}

/** 单行着色：注释 → 字符串 → 数字 → 关键字，按出现顺序替换，避免二次匹配。 */
function fpHueLine(line: string, lang: string): string {
  const keywords = FP_KEYWORDS[lang] ?? [];
  const tokenRe = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$-]*)\b/g;
  let out = '';
  let last = 0;
  let match = tokenRe.exec(line);
  while (match) {
    out += fpEscape(line.slice(last, match.index));
    const [raw, comment, str, num, word] = match;
    if (comment) out += '<span class="dshmf-tok-comment">' + fpEscape(raw) + '</span>';
    else if (str) out += '<span class="dshmf-tok-string">' + fpEscape(raw) + '</span>';
    else if (num) out += '<span class="dshmf-tok-number">' + fpEscape(raw) + '</span>';
    else if (word && keywords.includes(word)) {
      out += '<span class="dshmf-tok-keyword">' + fpEscape(raw) + '</span>';
    } else out += fpEscape(raw);
    last = match.index + raw.length;
    match = tokenRe.exec(line);
  }
  out += fpEscape(line.slice(last));
  return out;
}

/** 代码块：行号 + 高亮。 */
function fpCodeBlock(text: string, ext: string): HTMLElement {
  const lang = fpLangOf(ext);
  const lines = text.split(/\r?\n/);
  const wrapper = fpEl('div', 'dshmf-code');
  const gutter = fpEl('div', 'dshmf-gutter');
  const pre = fpEl('pre', 'dshmf-code-pre');
  const numbers: string[] = [];
  const html: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    numbers.push(String(index + 1));
    html.push(fpHueLine(lines[index] as string, lang));
  }
  gutter.textContent = numbers.join('\n');
  pre.innerHTML = html.join('\n');
  wrapper.append(gutter, pre);
  return wrapper;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FILE_PANEL_STYLE;
  document.head.appendChild(style);
}

export interface FilePanelHandle {
  close(): void;
  dispose(): void;
}

/** 挂载移动端文件入口（悬浮按钮 / 桌面快捷键）。 */
export function mountFilePanel(): FilePanelHandle {
  let overlay: HTMLElement | null = null;
  let closePanel = (): void => undefined;
  const disposed = { value: false };

  const open = (): void => {
    if (disposed.value) return;
    if (overlay) {
      closePanel();
      return;
    }
    ensureStyle();
    fpReport('panel opened ' + PANEL_VERSION);

    const state = {
      root: '',
      tree: [] as TreeNode[],
      tabs: [] as TabState[],
      active: '',
    };

    const node = fpEl('div');
    node.id = PANEL_ID;
    const head = fpEl('div', 'dshmf-head');
    const tabRow = fpEl('div', 'dshmf-tabrow');
    const pathLine = fpEl('div', 'dshmf-path');
    head.append(tabRow, pathLine);
    const status = fpEl('div', 'dshmf-status');
    const body = fpEl('div', 'dshmf-body');
    node.append(head, status, body);
    document.body.appendChild(node);
    overlay = node;

    const fail = (text: string): void => {
      status.textContent = text;
      fpReport(text);
    };
    const clearFail = (): void => {
      if (status.textContent) status.textContent = '';
    };
    const message = (text: string): void => {
      body.replaceChildren(fpEl('div', 'dshmf-msg', text));
    };

    const activeTab = (): TabState | undefined => state.tabs.find((tab) => tab.key === state.active);

    const renderTabs = (): void => {
      tabRow.replaceChildren();
      for (const tab of state.tabs) {
        const chip = fpEl('div', 'dshmf-tab' + (tab.key === state.active ? ' active' : ''));
        chip.appendChild(
          fpEl('span', 'dshmf-tabicon', tab.kind === 'tree' ? '📁' : fpIcon(tab.label, false, false)),
        );
        chip.appendChild(fpEl('span', 'dshmf-tablabel', tab.label));
        const close = fpEl('button', 'dshmf-tabclose', '×');
        close.setAttribute('aria-label', '关闭页签');
        const onClose = (event: Event): void => {
          event.preventDefault();
          event.stopPropagation();
          fpReport('close tab clicked: ' + tab.key);
          closeTab(tab.key);
        };
        close.addEventListener('click', onClose);
        close.addEventListener('touchend', onClose);
        chip.appendChild(close);
        chip.addEventListener('click', () => {
          state.active = tab.key;
          renderTabs();
          renderActive();
        });
        tabRow.appendChild(chip);
      }
    };

    /** 按当前树状态重建列表（只渲染已展开节点的子级）。 */
    const renderTree = (): void => {
      const fragment = document.createDocumentFragment();
      const walk = (nodes: TreeNode[]): void => {
        for (const entry of nodes) {
          const row = fpEl('button', 'dshmf-row');
          row.style.paddingLeft = String(10 + entry.depth * 16) + 'px';
          row.appendChild(fpEl('span', 'dshmf-icon', fpIcon(entry.name, entry.isDir, entry.expanded)));
          row.appendChild(fpEl('span', 'dshmf-name', entry.name));
          const size = fpSize(entry.size);
          if (size && !entry.isDir) row.appendChild(fpEl('span', 'dshmf-size', size));
          const supported = entry.isDir || fpSupported(entry.name);
          if (!supported) row.style.opacity = '0.45';
          row.addEventListener('click', () => {
            if (entry.isDir) void toggle(entry);
            else if (supported) openFile(entry.path, entry.name);
          });
          fragment.appendChild(row);
          if (entry.isDir && entry.expanded) {
            if (entry.loading) {
              fragment.appendChild(fpEl('div', 'dshmf-hint', '加载中…'));
            } else if (entry.error) {
              const hint = fpEl('div', 'dshmf-hint', entry.error);
              hint.style.paddingLeft = String(10 + (entry.depth + 1) * 16) + 'px';
              fragment.appendChild(hint);
            } else if (entry.children.length === 0) {
              const hint = fpEl('div', 'dshmf-hint', '空目录');
              hint.style.paddingLeft = String(10 + (entry.depth + 1) * 16) + 'px';
              fragment.appendChild(hint);
            } else {
              walk(entry.children);
            }
          }
        }
      };
      walk(state.tree);
      body.replaceChildren(fragment);
    };

    const loadChildren = async (parentPath: string, depth: number): Promise<TreeNode[]> => {
      const data = await fpJson<{ entries?: FsEntry[] }>(
        withSession(LIST_ROUTE + '?path=' + encodeURIComponent(parentPath)),
      );
      return (data.entries ?? []).map((item) => ({
        name: item.name,
        path: joinPath(parentPath, item.name),
        isDir: item.isDir,
        size: item.size,
        depth,
        expanded: false,
        loaded: false,
        loading: false,
        error: '',
        children: [],
      }));
    };

    const toggle = async (entry: TreeNode): Promise<void> => {
      clearFail();
      if (entry.expanded) {
        entry.expanded = false;
        renderTree();
        return;
      }
      entry.expanded = true;
      if (entry.loaded) {
        renderTree();
        return;
      }
      entry.loading = true;
      renderTree();
      try {
        entry.children = await loadChildren(entry.path, entry.depth + 1);
        entry.loaded = true;
      } catch (error) {
        entry.error = '读取失败：' + String((error as Error)?.message ?? error);
        fail(entry.error);
      } finally {
        entry.loading = false;
        if (state.active === 'tree') renderTree();
      }
    };

    const closeTab = (key: string): void => {
      const index = state.tabs.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const tab = state.tabs[index] as TabState;
      // 关闭「文件」（树）页签 = 关闭整个面板；文件页签只关自己。
      if (tab.kind === 'tree') {
        closePanel();
        return;
      }
      const wasActive = state.active === key;
      state.tabs.splice(index, 1);
      if (wasActive) {
        const fallback = state.tabs[Math.max(0, index - 1)] ?? state.tabs[0];
        state.active = fallback ? fallback.key : '';
      }
      renderTabs();
      renderActive();
    };

    const renderActive = (): void => {
      const tab = activeTab();
      if (!tab) {
        closePanel();
        return;
      }
      pathLine.textContent = tab.kind === 'tree' ? state.root : tab.path;
      if (tab.kind === 'tree') {
        renderTree();
        return;
      }
      void showFile(tab);
    };

    const showFile = async (tab: TabState): Promise<void> => {
      clearFail();
      message('加载中…');
      const stillActive = (): boolean => state.active === tab.key;
      const ext = fpExtOf(tab.label);
      if (FP_IMAGE_EXT.has(ext)) {
        const image = fpEl('img', 'dshmf-img');
        image.alt = tab.label;
        image.src = fpUrl(withSession(FILE_ROUTE + '?path=' + encodeURIComponent(tab.path) + '&mode=raw'));
        image.addEventListener('error', () => {
          if (stillActive()) message('图片加载失败');
        }, { once: true });
        image.addEventListener('click', () => image.classList.toggle('zoomed'), { once: false });
        if (!stillActive()) return;
        body.replaceChildren(image);
        return;
      }

      try {
        const data = await fpJson<{ text?: string }>(
          withSession(FILE_ROUTE + '?path=' + encodeURIComponent(tab.path)),
        );
        if (!stillActive()) return;
        if (typeof data.text !== 'string') {
          message('这个类型暂不支持预览');
          return;
        }
        const text = data.text;
        if (ext === 'md' || ext === 'markdown') {
          body.replaceChildren(fpRenderMarkdown(text));
          return;
        }
        if (ext === 'json' || ext === 'jsonc') {
          body.replaceChildren(fpCodeBlock(fpPrettyJson(text), 'json'));
          return;
        }
        body.replaceChildren(fpCodeBlock(text, ext));
      } catch (error) {
        if (!stillActive()) return;
        message('读取失败：' + String((error as Error)?.message ?? error));
      }
    };

    /** 点文件：已有同路径页签就激活，否则在「文件」右侧新开一个。 */
    const openFile = (path: string, name: string): void => {
      if (!fpSupported(name)) return;
      const existing = state.tabs.find((tab) => tab.kind === 'file' && tab.path === path);
      if (existing) {
        state.active = existing.key;
      } else {
        const key = 'file:' + path;
        state.tabs.push({ key, label: name, path, kind: 'file' });
        state.active = key;
      }
      renderTabs();
      renderActive();
    };

    const openWorkspace = async (): Promise<void> => {
      message('加载中…');
      try {
        const data = await fpJson<{ roots?: Array<{ label: string; path: string }> }>(
          withSession(ROOTS_ROUTE),
        );
        const root = (data.roots ?? [])[0];
        if (!root || !root.path) {
          message('没有找到当前会话的工作区');
          return;
        }
        state.root = root.path;
        state.tree = await loadChildren(root.path, 0);
        state.tabs = [{ key: 'tree', label: '文件', path: root.path, kind: 'tree' }];
        state.active = 'tree';
        renderTabs();
        pathLine.textContent = root.path;
        if (state.tree.length === 0) {
          message('工作区是空的');
          return;
        }
        renderTree();
      } catch (error) {
        message('获取工作区失败：' + String((error as Error)?.message ?? error));
      }
    };

    /** 文档级捕获：绕过任何上层拦截，确保 × 一定能关。 */
    const onCapture = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const hit = target.closest('.dshmf-tabclose');
      if (!hit) return;
      const chip = hit.closest('.dshmf-tab');
      if (!chip) return;
      const tabs = tabRow.querySelectorAll('.dshmf-tab');
      const index = Array.prototype.indexOf.call(tabs, chip) as number;
      const tab = state.tabs[index];
      if (!tab) return;
      event.preventDefault();
      event.stopPropagation();
      fpReport('capture close: ' + tab.key);
      closeTab(tab.key);
    };
    document.addEventListener('click', onCapture, true);
    document.addEventListener('touchend', onCapture, true);

    closePanel = (): void => {
      document.removeEventListener('click', onCapture, true);
      document.removeEventListener('touchend', onCapture, true);
      fpReport('panel closed');
      node.remove();
      overlay = null;
      closePanel = () => undefined;
    };

    void openWorkspace();
  };



/**
 * 把右侧面板 Guide 里的官方「工作区文件」入口**替换**成我们的入口：
 * 克隆官方卡片（保持同样式），只改文字与点击行为；仅移动端。
 */
function replaceOfficialEntry(open: () => void): void {
  if (!fpIsMobile()) return;
  if (document.getElementById(GUIDE_ENTRY_ID)) return;
  const nodes = document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="tab"], li, div');
  for (const node of nodes) {
    const text = (node.textContent ?? '').replace(/\s+/g, '');
    if (!text.startsWith('工作区文件')) continue;
    if (text.includes('浏览器') || text.includes('终端') || text.includes('图像工作台')) continue;
    const target = node.closest<HTMLElement>('button, a, [role="button"], [role="tab"]') ?? node;
    if (target.getAttribute(HIDDEN_FLAG) === '1') continue;
    const clone = target.cloneNode(true) as HTMLElement;
    clone.id = GUIDE_ENTRY_ID;
    clone.removeAttribute('aria-selected');
    // 名称保持官方的「工作区文件」，只替换点击行为。

    clone.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        fpReport('guide entry clicked');
        open();
      },
      true,
    );
    target.setAttribute(HIDDEN_FLAG, '1');
    target.style.display = 'none';
    target.after(clone);
    fpReport('official entry replaced');
    return;
  }
}

  /** 兜底：捕获任何「工作区文件」行的点击，避免原生预览在重渲染间隙被触发。 */
  const onGuideClick = (event: Event): void => {
    if (!fpIsMobile()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>('button, a, [role="button"], [role="tab"], li, div');
    if (!row) return;
    if (row.id === GUIDE_ENTRY_ID) return;
    const text = (row.textContent ?? '').replace(/\s+/g, '');
    if (!text.startsWith('工作区文件')) return;
    if (text.includes('浏览器') || text.includes('终端') || text.includes('图像工作台')) return;
    event.preventDefault();
    event.stopPropagation();
    fpReport('guide row intercepted');
    open();
  };
  document.addEventListener('click', onGuideClick, true);

  ensureStyle();
  replaceOfficialEntry(open);
  const hideTimer = window.setInterval(() => replaceOfficialEntry(open), 1500);

  return {
    close: (): void => closePanel(),
    dispose: (): void => {
      disposed.value = true;
      document.removeEventListener('click', onGuideClick, true);
      window.clearInterval(hideTimer);
      closePanel();
      document.getElementById(GUIDE_ENTRY_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      document.querySelectorAll<HTMLElement>('[' + HIDDEN_FLAG + ']').forEach((node) => {
        node.style.display = '';
        node.removeAttribute(HIDDEN_FLAG);
      });
    },
  };
}

export function filePanelEnabled(): boolean {
  return fpIsMobile();
}
