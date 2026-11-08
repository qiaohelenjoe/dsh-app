window.__ModuleLoader__.load({
	id: "dsh-mobile-tunnel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		const PANEL_VERSION = '1.1.1';
		const BASE = '/plugins/dsh-mobile-tunnel';
		const DIAG_ROUTE = BASE + '/diag';
		const ROOTS_ROUTE = BASE + '/fs-roots';
		const LIST_ROUTE = BASE + '/fs';
		const FILE_ROUTE = BASE + '/fs-file';
		function fpIsMobile() {
		    if (document.documentElement?.getAttribute('data-dsh-mobile-app') === '1')
		        return true;
		    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
		}
		/** 把根绝对路径拼到 DSH 当前挂载前缀下（中继可能把页面挂在 /t/<deviceId>/）。 */
		function fpUrl(path) {
		    const transport = window
		        .__DSH_TRANSPORT__;
		    const base = typeof transport?.streamBaseUrl === 'string' && transport.streamBaseUrl
		        ? transport.streamBaseUrl
		        : location.origin + '/';
		    try {
		        return new URL(path.replace(/^\//, ''), base).toString();
		    }
		    catch {
		        return path;
		    }
		}
		/** 自报诊断日志到宿主（sendBeacon；失败不影响主流程）。 */
		function fpReport(message) {
		    if (typeof location === 'undefined' || typeof navigator === 'undefined')
		        return;
		    const payload = JSON.stringify({ msg: message, href: location.href, mobile: fpIsMobile() });
		    const urls = [];
		    urls.push(fpUrl(DIAG_ROUTE));
		    const direct = location.origin + DIAG_ROUTE;
		    if (!urls.includes(direct))
		        urls.push(direct);
		    for (const url of urls) {
		        try {
		            if (typeof navigator.sendBeacon === 'function')
		                navigator.sendBeacon(url, payload);
		        }
		        catch {
		            // 忽略
		        }
		    }
		}
		/** 依次尝试候选前缀，返回第一个成功解析的 JSON。 */
		async function fpJson(path) {
		    const candidates = [];
		    const push = (url) => {
		        if (url && !candidates.includes(url))
		            candidates.push(url);
		    };
		    push(fpUrl(path));
		    push(location.origin + path);
		    const prefix = /^\/t\/[^/]+/.exec(location.pathname);
		    if (prefix)
		        push(location.origin + prefix[0] + path);
		    const failures = [];
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
		            return (await response.json());
		        }
		        catch (error) {
		            failures.push(url + ' → ' + String(error?.name ?? error));
		        }
		        finally {
		            window.clearTimeout(guard);
		        }
		    }
		    throw new Error(failures.join(' | '));
		}
		const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
		/** 从 localStorage 猜当前会话 id（宿主用它定位工作区）。 */
		function currentSessionId() {
		    try {
		        for (let index = 0; index < localStorage.length; index += 1) {
		            const key = localStorage.key(index) ?? '';
		            if (!/session/i.test(key))
		                continue;
		            const value = localStorage.getItem(key) ?? '';
		            const match = UUID_RE.exec(value) ?? UUID_RE.exec(key);
		            if (match)
		                return match[0];
		        }
		    }
		    catch {
		        // 忽略
		    }
		    return '';
		}
		function withSession(path) {
		    const session = currentSessionId();
		    if (!session)
		        return path;
		    return path + (path.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(session);
		}
		function joinPath(parent, name) {
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
		function fpEl(tag, className, text) {
		    const node = document.createElement(tag);
		    if (className)
		        node.className = className;
		    if (text !== undefined)
		        node.textContent = text;
		    return node;
		}
		function fpSize(size) {
		    if (!size || size < 0)
		        return '';
		    if (size < 1024)
		        return String(size) + ' B';
		    if (size < 1024 * 1024)
		        return (size / 1024).toFixed(1) + ' KB';
		    return (size / 1024 / 1024).toFixed(1) + ' MB';
		}
		/** 按扩展名给图标（仿官方）。 */
		function fpIcon(name, isDir, expanded) {
		    if (isDir)
		        return expanded ? '📂' : '📁';
		    const dot = name.lastIndexOf('.');
		    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
		    if (ext === 'md' || ext === 'markdown')
		        return '📘';
		    if (ext === 'json' || ext === 'yml' || ext === 'yaml' || ext === 'toml')
		        return '🧾';
		    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs')
		        return '📜';
		    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp' || ext === 'svg')
		        return '🖼';
		    if (ext === 'ps1' || ext === 'bat' || ext === 'cmd' || ext === 'sh')
		        return '⚙️';
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
		function fpExtOf(name) {
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
		function fpSupported(name) {
		    const ext = fpExtOf(name);
		    if (FP_BLOCKED_EXT.has(ext))
		        return false;
		    return true;
		}
		function fpEscape(text) {
		    return text
		        .replace(/&/g, '&amp;')
		        .replace(/</g, '&lt;')
		        .replace(/>/g, '&gt;')
		        .replace(/"/g, '&quot;');
		}
		/** 极简 Markdown 渲染（不引入依赖）：标题、粗斜体、行内代码、代码块、列表、引用、链接。 */
		function fpRenderMarkdown(source) {
		    const fragment = document.createDocumentFragment();
		    const lines = source.split(/\r?\n/);
		    let list = null;
		    let index = 0;
		    const inline = (text) => fpEscape(text)
		        .replace(/`([^`]+)`/g, '<code>$1</code>')
		        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
		        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
		    while (index < lines.length) {
		        const line = lines[index];
		        const fence = /^```(\w*)/.exec(line);
		        if (fence) {
		            const code = [];
		            index += 1;
		            while (index < lines.length && !/^```/.test(lines[index])) {
		                code.push(lines[index]);
		                index += 1;
		            }
		            index += 1;
		            const pre = fpEl('pre', 'dshmf-md-code', code.join('\n'));
		            fragment.appendChild(pre);
		            continue;
		        }
		        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		        if (heading) {
		            const level = heading[1].length;
		            const el = fpEl(('h' + String(Math.min(level, 4))));
		            el.className = 'dshmf-md-h dshmf-md-h' + String(level);
		            el.innerHTML = inline(heading[2]);
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
		            block.innerHTML = inline(quote[1]);
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
		function fpPrettyJson(text) {
		    try {
		        return JSON.stringify(JSON.parse(text), null, 2);
		    }
		    catch {
		        return text;
		    }
		}
		/** 各语言关键字（够用即可，不做完整词法分析）。 */
		const FP_KEYWORDS = {
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
		function fpLangOf(ext) {
		    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'json', 'jsonc'].includes(ext))
		        return 'js';
		    if (['py'].includes(ext))
		        return 'py';
		    if (['go'].includes(ext))
		        return 'go';
		    if (['rs'].includes(ext))
		        return 'rs';
		    if (['java', 'kt', 'cs', 'php', 'rb', 'swift', 'dart'].includes(ext))
		        return 'c';
		    if (['c', 'h', 'cc', 'cpp', 'hpp'].includes(ext))
		        return 'c';
		    if (['sh', 'bash', 'zsh'].includes(ext))
		        return 'sh';
		    if (['ps1'].includes(ext))
		        return 'ps1';
		    if (['bat', 'cmd'].includes(ext))
		        return 'ps1';
		    if (['sql'].includes(ext))
		        return 'sql';
		    if (['css', 'scss', 'less'].includes(ext))
		        return 'css';
		    if (['yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'properties'].includes(ext))
		        return 'yaml';
		    if (['html', 'htm', 'xml', 'svg'].includes(ext))
		        return 'html';
		    return 'text';
		}
		/** 单行着色：注释 → 字符串 → 数字 → 关键字，按出现顺序替换，避免二次匹配。 */
		function fpHueLine(line, lang) {
		    const keywords = FP_KEYWORDS[lang] ?? [];
		    const tokenRe = /(\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$-]*)\b/g;
		    let out = '';
		    let last = 0;
		    let match = tokenRe.exec(line);
		    while (match) {
		        out += fpEscape(line.slice(last, match.index));
		        const [raw, comment, str, num, word] = match;
		        if (comment)
		            out += '<span class="dshmf-tok-comment">' + fpEscape(raw) + '</span>';
		        else if (str)
		            out += '<span class="dshmf-tok-string">' + fpEscape(raw) + '</span>';
		        else if (num)
		            out += '<span class="dshmf-tok-number">' + fpEscape(raw) + '</span>';
		        else if (word && keywords.includes(word)) {
		            out += '<span class="dshmf-tok-keyword">' + fpEscape(raw) + '</span>';
		        }
		        else
		            out += fpEscape(raw);
		        last = match.index + raw.length;
		        match = tokenRe.exec(line);
		    }
		    out += fpEscape(line.slice(last));
		    return out;
		}
		/** 代码块：行号 + 高亮。 */
		function fpCodeBlock(text, ext) {
		    const lang = fpLangOf(ext);
		    const lines = text.split(/\r?\n/);
		    const wrapper = fpEl('div', 'dshmf-code');
		    const gutter = fpEl('div', 'dshmf-gutter');
		    const pre = fpEl('pre', 'dshmf-code-pre');
		    const numbers = [];
		    const html = [];
		    for (let index = 0; index < lines.length; index += 1) {
		        numbers.push(String(index + 1));
		        html.push(fpHueLine(lines[index], lang));
		    }
		    gutter.textContent = numbers.join('\n');
		    pre.innerHTML = html.join('\n');
		    wrapper.append(gutter, pre);
		    return wrapper;
		}
		function ensureStyle() {
		    if (document.getElementById(STYLE_ID))
		        return;
		    const style = document.createElement('style');
		    style.id = STYLE_ID;
		    style.textContent = FILE_PANEL_STYLE;
		    document.head.appendChild(style);
		}
		/** 挂载移动端文件入口（悬浮按钮 / 桌面快捷键）。 */
		function mountFilePanel() {
		    let overlay = null;
		    let closePanel = () => undefined;
		    const disposed = { value: false };
		    const open = () => {
		        if (disposed.value)
		            return;
		        if (overlay) {
		            closePanel();
		            return;
		        }
		        ensureStyle();
		        fpReport('panel opened ' + PANEL_VERSION);
		        const state = {
		            root: '',
		            tree: [],
		            tabs: [],
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
		        const fail = (text) => {
		            status.textContent = text;
		            fpReport(text);
		        };
		        const clearFail = () => {
		            if (status.textContent)
		                status.textContent = '';
		        };
		        const message = (text) => {
		            body.replaceChildren(fpEl('div', 'dshmf-msg', text));
		        };
		        const activeTab = () => state.tabs.find((tab) => tab.key === state.active);
		        const renderTabs = () => {
		            tabRow.replaceChildren();
		            for (const tab of state.tabs) {
		                const chip = fpEl('div', 'dshmf-tab' + (tab.key === state.active ? ' active' : ''));
		                chip.appendChild(fpEl('span', 'dshmf-tabicon', tab.kind === 'tree' ? '📁' : fpIcon(tab.label, false, false)));
		                chip.appendChild(fpEl('span', 'dshmf-tablabel', tab.label));
		                const close = fpEl('button', 'dshmf-tabclose', '×');
		                close.setAttribute('aria-label', '关闭页签');
		                const onClose = (event) => {
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
		        const renderTree = () => {
		            const fragment = document.createDocumentFragment();
		            const walk = (nodes) => {
		                for (const entry of nodes) {
		                    const row = fpEl('button', 'dshmf-row');
		                    row.style.paddingLeft = String(10 + entry.depth * 16) + 'px';
		                    row.appendChild(fpEl('span', 'dshmf-icon', fpIcon(entry.name, entry.isDir, entry.expanded)));
		                    row.appendChild(fpEl('span', 'dshmf-name', entry.name));
		                    const size = fpSize(entry.size);
		                    if (size && !entry.isDir)
		                        row.appendChild(fpEl('span', 'dshmf-size', size));
		                    const supported = entry.isDir || fpSupported(entry.name);
		                    if (!supported)
		                        row.style.opacity = '0.45';
		                    row.addEventListener('click', () => {
		                        if (entry.isDir)
		                            void toggle(entry);
		                        else if (supported)
		                            openFile(entry.path, entry.name);
		                    });
		                    fragment.appendChild(row);
		                    if (entry.isDir && entry.expanded) {
		                        if (entry.loading) {
		                            fragment.appendChild(fpEl('div', 'dshmf-hint', '加载中…'));
		                        }
		                        else if (entry.error) {
		                            const hint = fpEl('div', 'dshmf-hint', entry.error);
		                            hint.style.paddingLeft = String(10 + (entry.depth + 1) * 16) + 'px';
		                            fragment.appendChild(hint);
		                        }
		                        else if (entry.children.length === 0) {
		                            const hint = fpEl('div', 'dshmf-hint', '空目录');
		                            hint.style.paddingLeft = String(10 + (entry.depth + 1) * 16) + 'px';
		                            fragment.appendChild(hint);
		                        }
		                        else {
		                            walk(entry.children);
		                        }
		                    }
		                }
		            };
		            walk(state.tree);
		            body.replaceChildren(fragment);
		        };
		        const loadChildren = async (parentPath, depth) => {
		            const data = await fpJson(withSession(LIST_ROUTE + '?path=' + encodeURIComponent(parentPath)));
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
		        const toggle = async (entry) => {
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
		            }
		            catch (error) {
		                entry.error = '读取失败：' + String(error?.message ?? error);
		                fail(entry.error);
		            }
		            finally {
		                entry.loading = false;
		                if (state.active === 'tree')
		                    renderTree();
		            }
		        };
		        const closeTab = (key) => {
		            const index = state.tabs.findIndex((tab) => tab.key === key);
		            if (index < 0)
		                return;
		            const tab = state.tabs[index];
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
		        const renderActive = () => {
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
		        const showFile = async (tab) => {
		            clearFail();
		            message('加载中…');
		            const stillActive = () => state.active === tab.key;
		            const ext = fpExtOf(tab.label);
		            if (FP_IMAGE_EXT.has(ext)) {
		                const image = fpEl('img', 'dshmf-img');
		                image.alt = tab.label;
		                image.src = fpUrl(withSession(FILE_ROUTE + '?path=' + encodeURIComponent(tab.path) + '&mode=raw'));
		                image.addEventListener('error', () => {
		                    if (stillActive())
		                        message('图片加载失败');
		                }, { once: true });
		                image.addEventListener('click', () => image.classList.toggle('zoomed'), { once: false });
		                if (!stillActive())
		                    return;
		                body.replaceChildren(image);
		                return;
		            }
		            try {
		                const data = await fpJson(withSession(FILE_ROUTE + '?path=' + encodeURIComponent(tab.path)));
		                if (!stillActive())
		                    return;
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
		            }
		            catch (error) {
		                if (!stillActive())
		                    return;
		                message('读取失败：' + String(error?.message ?? error));
		            }
		        };
		        /** 点文件：已有同路径页签就激活，否则在「文件」右侧新开一个。 */
		        const openFile = (path, name) => {
		            if (!fpSupported(name))
		                return;
		            const existing = state.tabs.find((tab) => tab.kind === 'file' && tab.path === path);
		            if (existing) {
		                state.active = existing.key;
		            }
		            else {
		                const key = 'file:' + path;
		                state.tabs.push({ key, label: name, path, kind: 'file' });
		                state.active = key;
		            }
		            renderTabs();
		            renderActive();
		        };
		        const openWorkspace = async () => {
		            message('加载中…');
		            try {
		                const data = await fpJson(withSession(ROOTS_ROUTE));
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
		            }
		            catch (error) {
		                message('获取工作区失败：' + String(error?.message ?? error));
		            }
		        };
		        /** 文档级捕获：绕过任何上层拦截，确保 × 一定能关。 */
		        const onCapture = (event) => {
		            const target = event.target;
		            if (!(target instanceof Element))
		                return;
		            const hit = target.closest('.dshmf-tabclose');
		            if (!hit)
		                return;
		            const chip = hit.closest('.dshmf-tab');
		            if (!chip)
		                return;
		            const tabs = tabRow.querySelectorAll('.dshmf-tab');
		            const index = Array.prototype.indexOf.call(tabs, chip);
		            const tab = state.tabs[index];
		            if (!tab)
		                return;
		            event.preventDefault();
		            event.stopPropagation();
		            fpReport('capture close: ' + tab.key);
		            closeTab(tab.key);
		        };
		        document.addEventListener('click', onCapture, true);
		        document.addEventListener('touchend', onCapture, true);
		        closePanel = () => {
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
		    function replaceOfficialEntry(open) {
		        if (!fpIsMobile())
		            return;
		        if (document.getElementById(GUIDE_ENTRY_ID))
		            return;
		        const nodes = document.querySelectorAll('button, a, [role="button"], [role="tab"], li, div');
		        for (const node of nodes) {
		            const text = (node.textContent ?? '').replace(/\s+/g, '');
		            if (!text.startsWith('工作区文件'))
		                continue;
		            if (text.includes('浏览器') || text.includes('终端') || text.includes('图像工作台'))
		                continue;
		            const target = node.closest('button, a, [role="button"], [role="tab"]') ?? node;
		            if (target.getAttribute(HIDDEN_FLAG) === '1')
		                continue;
		            const clone = target.cloneNode(true);
		            clone.id = GUIDE_ENTRY_ID;
		            clone.removeAttribute('aria-selected');
		            // 名称保持官方的「工作区文件」，只替换点击行为。
		            clone.addEventListener('click', (event) => {
		                event.preventDefault();
		                event.stopPropagation();
		                fpReport('guide entry clicked');
		                open();
		            }, true);
		            target.setAttribute(HIDDEN_FLAG, '1');
		            target.style.display = 'none';
		            target.after(clone);
		            fpReport('official entry replaced');
		            return;
		        }
		    }
		    /** 兜底：捕获任何「工作区文件」行的点击，避免原生预览在重渲染间隙被触发。 */
		    const onGuideClick = (event) => {
		        if (!fpIsMobile())
		            return;
		        const target = event.target;
		        if (!(target instanceof Element))
		            return;
		        const row = target.closest('button, a, [role="button"], [role="tab"], li, div');
		        if (!row)
		            return;
		        if (row.id === GUIDE_ENTRY_ID)
		            return;
		        const text = (row.textContent ?? '').replace(/\s+/g, '');
		        if (!text.startsWith('工作区文件'))
		            return;
		        if (text.includes('浏览器') || text.includes('终端') || text.includes('图像工作台'))
		            return;
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
		        close: () => closePanel(),
		        dispose: () => {
		            disposed.value = true;
		            document.removeEventListener('click', onGuideClick, true);
		            window.clearInterval(hideTimer);
		            closePanel();
		            document.getElementById(GUIDE_ENTRY_ID)?.remove();
		            document.getElementById(STYLE_ID)?.remove();
		            document.querySelectorAll('[' + HIDDEN_FLAG + ']').forEach((node) => {
		                node.style.display = '';
		                node.removeAttribute(HIDDEN_FLAG);
		            });
		        },
		    };
		}
		function filePanelEnabled() {
		    return fpIsMobile();
		}

		/**
		 * 由 `node scripts/gen-app-qr.mjs` 生成，勿手改。
		 * 二维码内容 = 手机 App 最新版下载页地址，中间为黑色鲸鱼 logo。
		 */
		const APP_DOWNLOAD_URL = "https://dsh.hbzxht.com/download";
		const APP_QR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41" role="img" aria-label="手机 App 下载二维码"><rect width="41" height="41" fill="#fff"/><path d="M4 4h1v1h-1zM5 4h1v1h-1zM6 4h1v1h-1zM7 4h1v1h-1zM8 4h1v1h-1zM9 4h1v1h-1zM10 4h1v1h-1zM15 4h1v1h-1zM18 4h1v1h-1zM19 4h1v1h-1zM20 4h1v1h-1zM21 4h1v1h-1zM22 4h1v1h-1zM23 4h1v1h-1zM26 4h1v1h-1zM28 4h1v1h-1zM30 4h1v1h-1zM31 4h1v1h-1zM32 4h1v1h-1zM33 4h1v1h-1zM34 4h1v1h-1zM35 4h1v1h-1zM36 4h1v1h-1zM4 5h1v1h-1zM10 5h1v1h-1zM14 5h1v1h-1zM15 5h1v1h-1zM16 5h1v1h-1zM17 5h1v1h-1zM18 5h1v1h-1zM19 5h1v1h-1zM21 5h1v1h-1zM22 5h1v1h-1zM23 5h1v1h-1zM24 5h1v1h-1zM25 5h1v1h-1zM28 5h1v1h-1zM30 5h1v1h-1zM36 5h1v1h-1zM4 6h1v1h-1zM6 6h1v1h-1zM7 6h1v1h-1zM8 6h1v1h-1zM10 6h1v1h-1zM12 6h1v1h-1zM17 6h1v1h-1zM18 6h1v1h-1zM19 6h1v1h-1zM22 6h1v1h-1zM23 6h1v1h-1zM25 6h1v1h-1zM26 6h1v1h-1zM27 6h1v1h-1zM28 6h1v1h-1zM30 6h1v1h-1zM32 6h1v1h-1zM33 6h1v1h-1zM34 6h1v1h-1zM36 6h1v1h-1zM4 7h1v1h-1zM6 7h1v1h-1zM7 7h1v1h-1zM8 7h1v1h-1zM10 7h1v1h-1zM12 7h1v1h-1zM14 7h1v1h-1zM17 7h1v1h-1zM18 7h1v1h-1zM19 7h1v1h-1zM24 7h1v1h-1zM25 7h1v1h-1zM27 7h1v1h-1zM28 7h1v1h-1zM30 7h1v1h-1zM32 7h1v1h-1zM33 7h1v1h-1zM34 7h1v1h-1zM36 7h1v1h-1zM4 8h1v1h-1zM6 8h1v1h-1zM7 8h1v1h-1zM8 8h1v1h-1zM10 8h1v1h-1zM15 8h1v1h-1zM16 8h1v1h-1zM17 8h1v1h-1zM19 8h1v1h-1zM22 8h1v1h-1zM24 8h1v1h-1zM25 8h1v1h-1zM26 8h1v1h-1zM27 8h1v1h-1zM30 8h1v1h-1zM32 8h1v1h-1zM33 8h1v1h-1zM34 8h1v1h-1zM36 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM14 9h1v1h-1zM15 9h1v1h-1zM16 9h1v1h-1zM19 9h1v1h-1zM21 9h1v1h-1zM22 9h1v1h-1zM28 9h1v1h-1zM30 9h1v1h-1zM36 9h1v1h-1zM4 10h1v1h-1zM5 10h1v1h-1zM6 10h1v1h-1zM7 10h1v1h-1zM8 10h1v1h-1zM9 10h1v1h-1zM10 10h1v1h-1zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h1v1h-1zM31 10h1v1h-1zM32 10h1v1h-1zM33 10h1v1h-1zM34 10h1v1h-1zM35 10h1v1h-1zM36 10h1v1h-1zM14 11h1v1h-1zM16 11h1v1h-1zM18 11h1v1h-1zM19 11h1v1h-1zM20 11h1v1h-1zM22 11h1v1h-1zM24 11h1v1h-1zM27 11h1v1h-1zM7 12h1v1h-1zM8 12h1v1h-1zM10 12h1v1h-1zM11 12h1v1h-1zM13 12h1v1h-1zM14 12h1v1h-1zM16 12h1v1h-1zM17 12h1v1h-1zM19 12h1v1h-1zM20 12h1v1h-1zM23 12h1v1h-1zM24 12h1v1h-1zM27 12h1v1h-1zM28 12h1v1h-1zM33 12h1v1h-1zM34 12h1v1h-1zM4 13h1v1h-1zM6 13h1v1h-1zM7 13h1v1h-1zM8 13h1v1h-1zM9 13h1v1h-1zM12 13h1v1h-1zM13 13h1v1h-1zM16 13h1v1h-1zM17 13h1v1h-1zM21 13h1v1h-1zM24 13h1v1h-1zM26 13h1v1h-1zM27 13h1v1h-1zM29 13h1v1h-1zM31 13h1v1h-1zM32 13h1v1h-1zM33 13h1v1h-1zM34 13h1v1h-1zM35 13h1v1h-1zM10 14h1v1h-1zM12 14h1v1h-1zM13 14h1v1h-1zM15 14h1v1h-1zM16 14h1v1h-1zM18 14h1v1h-1zM21 14h1v1h-1zM22 14h1v1h-1zM23 14h1v1h-1zM24 14h1v1h-1zM25 14h1v1h-1zM27 14h1v1h-1zM29 14h1v1h-1zM31 14h1v1h-1zM33 14h1v1h-1zM34 14h1v1h-1zM35 14h1v1h-1zM36 14h1v1h-1zM4 15h1v1h-1zM5 15h1v1h-1zM6 15h1v1h-1zM7 15h1v1h-1zM8 15h1v1h-1zM11 15h1v1h-1zM12 15h1v1h-1zM13 15h1v1h-1zM14 15h1v1h-1zM15 15h1v1h-1zM18 15h1v1h-1zM19 15h1v1h-1zM20 15h1v1h-1zM23 15h1v1h-1zM30 15h1v1h-1zM31 15h1v1h-1zM32 15h1v1h-1zM33 15h1v1h-1zM34 15h1v1h-1zM4 16h1v1h-1zM5 16h1v1h-1zM6 16h1v1h-1zM10 16h1v1h-1zM11 16h1v1h-1zM14 16h1v1h-1zM15 16h1v1h-1zM18 16h1v1h-1zM20 16h1v1h-1zM21 16h1v1h-1zM22 16h1v1h-1zM24 16h1v1h-1zM25 16h1v1h-1zM26 16h1v1h-1zM30 16h1v1h-1zM31 16h1v1h-1zM33 16h1v1h-1zM36 16h1v1h-1zM4 17h1v1h-1zM7 17h1v1h-1zM8 17h1v1h-1zM9 17h1v1h-1zM11 17h1v1h-1zM14 17h1v1h-1zM16 17h1v1h-1zM19 17h1v1h-1zM20 17h1v1h-1zM23 17h1v1h-1zM25 17h1v1h-1zM26 17h1v1h-1zM27 17h1v1h-1zM29 17h1v1h-1zM31 17h1v1h-1zM33 17h1v1h-1zM35 17h1v1h-1zM5 18h1v1h-1zM6 18h1v1h-1zM7 18h1v1h-1zM8 18h1v1h-1zM9 18h1v1h-1zM10 18h1v1h-1zM14 18h1v1h-1zM16 18h1v1h-1zM18 18h1v1h-1zM22 18h1v1h-1zM24 18h1v1h-1zM28 18h1v1h-1zM30 18h1v1h-1zM7 19h1v1h-1zM8 19h1v1h-1zM9 19h1v1h-1zM12 19h1v1h-1zM16 19h1v1h-1zM17 19h1v1h-1zM19 19h1v1h-1zM21 19h1v1h-1zM23 19h1v1h-1zM27 19h1v1h-1zM28 19h1v1h-1zM29 19h1v1h-1zM31 19h1v1h-1zM33 19h1v1h-1zM34 19h1v1h-1zM35 19h1v1h-1zM4 20h1v1h-1zM7 20h1v1h-1zM10 20h1v1h-1zM11 20h1v1h-1zM12 20h1v1h-1zM15 20h1v1h-1zM16 20h1v1h-1zM18 20h1v1h-1zM19 20h1v1h-1zM21 20h1v1h-1zM24 20h1v1h-1zM27 20h1v1h-1zM29 20h1v1h-1zM30 20h1v1h-1zM31 20h1v1h-1zM32 20h1v1h-1zM33 20h1v1h-1zM35 20h1v1h-1zM5 21h1v1h-1zM6 21h1v1h-1zM7 21h1v1h-1zM8 21h1v1h-1zM9 21h1v1h-1zM11 21h1v1h-1zM14 21h1v1h-1zM15 21h1v1h-1zM16 21h1v1h-1zM18 21h1v1h-1zM19 21h1v1h-1zM21 21h1v1h-1zM23 21h1v1h-1zM24 21h1v1h-1zM25 21h1v1h-1zM26 21h1v1h-1zM28 21h1v1h-1zM30 21h1v1h-1zM31 21h1v1h-1zM32 21h1v1h-1zM33 21h1v1h-1zM36 21h1v1h-1zM4 22h1v1h-1zM5 22h1v1h-1zM7 22h1v1h-1zM8 22h1v1h-1zM10 22h1v1h-1zM11 22h1v1h-1zM13 22h1v1h-1zM16 22h1v1h-1zM17 22h1v1h-1zM18 22h1v1h-1zM19 22h1v1h-1zM21 22h1v1h-1zM22 22h1v1h-1zM23 22h1v1h-1zM25 22h1v1h-1zM26 22h1v1h-1zM27 22h1v1h-1zM29 22h1v1h-1zM30 22h1v1h-1zM33 22h1v1h-1zM34 22h1v1h-1zM36 22h1v1h-1zM5 23h1v1h-1zM6 23h1v1h-1zM9 23h1v1h-1zM13 23h1v1h-1zM14 23h1v1h-1zM15 23h1v1h-1zM16 23h1v1h-1zM21 23h1v1h-1zM27 23h1v1h-1zM28 23h1v1h-1zM30 23h1v1h-1zM33 23h1v1h-1zM34 23h1v1h-1zM5 24h1v1h-1zM7 24h1v1h-1zM8 24h1v1h-1zM9 24h1v1h-1zM10 24h1v1h-1zM11 24h1v1h-1zM14 24h1v1h-1zM16 24h1v1h-1zM18 24h1v1h-1zM19 24h1v1h-1zM20 24h1v1h-1zM21 24h1v1h-1zM24 24h1v1h-1zM28 24h1v1h-1zM31 24h1v1h-1zM33 24h1v1h-1zM4 25h1v1h-1zM6 25h1v1h-1zM8 25h1v1h-1zM15 25h1v1h-1zM19 25h1v1h-1zM20 25h1v1h-1zM23 25h1v1h-1zM24 25h1v1h-1zM25 25h1v1h-1zM26 25h1v1h-1zM28 25h1v1h-1zM32 25h1v1h-1zM34 25h1v1h-1zM35 25h1v1h-1zM4 26h1v1h-1zM6 26h1v1h-1zM10 26h1v1h-1zM13 26h1v1h-1zM14 26h1v1h-1zM19 26h1v1h-1zM20 26h1v1h-1zM22 26h1v1h-1zM24 26h1v1h-1zM26 26h1v1h-1zM27 26h1v1h-1zM28 26h1v1h-1zM30 26h1v1h-1zM31 26h1v1h-1zM35 26h1v1h-1zM36 26h1v1h-1zM4 27h1v1h-1zM15 27h1v1h-1zM16 27h1v1h-1zM18 27h1v1h-1zM23 27h1v1h-1zM27 27h1v1h-1zM34 27h1v1h-1zM4 28h1v1h-1zM5 28h1v1h-1zM8 28h1v1h-1zM9 28h1v1h-1zM10 28h1v1h-1zM11 28h1v1h-1zM12 28h1v1h-1zM14 28h1v1h-1zM16 28h1v1h-1zM20 28h1v1h-1zM21 28h1v1h-1zM27 28h1v1h-1zM28 28h1v1h-1zM29 28h1v1h-1zM30 28h1v1h-1zM31 28h1v1h-1zM32 28h1v1h-1zM33 28h1v1h-1zM35 28h1v1h-1zM12 29h1v1h-1zM13 29h1v1h-1zM14 29h1v1h-1zM18 29h1v1h-1zM19 29h1v1h-1zM23 29h1v1h-1zM24 29h1v1h-1zM25 29h1v1h-1zM26 29h1v1h-1zM28 29h1v1h-1zM32 29h1v1h-1zM33 29h1v1h-1zM35 29h1v1h-1zM4 30h1v1h-1zM5 30h1v1h-1zM6 30h1v1h-1zM7 30h1v1h-1zM8 30h1v1h-1zM9 30h1v1h-1zM10 30h1v1h-1zM12 30h1v1h-1zM13 30h1v1h-1zM18 30h1v1h-1zM19 30h1v1h-1zM20 30h1v1h-1zM23 30h1v1h-1zM27 30h1v1h-1zM28 30h1v1h-1zM30 30h1v1h-1zM32 30h1v1h-1zM4 31h1v1h-1zM10 31h1v1h-1zM13 31h1v1h-1zM14 31h1v1h-1zM16 31h1v1h-1zM20 31h1v1h-1zM24 31h1v1h-1zM25 31h1v1h-1zM26 31h1v1h-1zM28 31h1v1h-1zM32 31h1v1h-1zM33 31h1v1h-1zM34 31h1v1h-1zM35 31h1v1h-1zM4 32h1v1h-1zM6 32h1v1h-1zM7 32h1v1h-1zM8 32h1v1h-1zM10 32h1v1h-1zM12 32h1v1h-1zM17 32h1v1h-1zM18 32h1v1h-1zM19 32h1v1h-1zM20 32h1v1h-1zM21 32h1v1h-1zM23 32h1v1h-1zM24 32h1v1h-1zM25 32h1v1h-1zM26 32h1v1h-1zM27 32h1v1h-1zM28 32h1v1h-1zM29 32h1v1h-1zM30 32h1v1h-1zM31 32h1v1h-1zM32 32h1v1h-1zM33 32h1v1h-1zM35 32h1v1h-1zM4 33h1v1h-1zM6 33h1v1h-1zM7 33h1v1h-1zM8 33h1v1h-1zM10 33h1v1h-1zM12 33h1v1h-1zM13 33h1v1h-1zM14 33h1v1h-1zM16 33h1v1h-1zM17 33h1v1h-1zM18 33h1v1h-1zM19 33h1v1h-1zM21 33h1v1h-1zM22 33h1v1h-1zM23 33h1v1h-1zM25 33h1v1h-1zM26 33h1v1h-1zM28 33h1v1h-1zM29 33h1v1h-1zM31 33h1v1h-1zM35 33h1v1h-1zM4 34h1v1h-1zM6 34h1v1h-1zM7 34h1v1h-1zM8 34h1v1h-1zM10 34h1v1h-1zM16 34h1v1h-1zM17 34h1v1h-1zM19 34h1v1h-1zM20 34h1v1h-1zM22 34h1v1h-1zM25 34h1v1h-1zM26 34h1v1h-1zM32 34h1v1h-1zM33 34h1v1h-1zM34 34h1v1h-1zM35 34h1v1h-1zM36 34h1v1h-1zM4 35h1v1h-1zM10 35h1v1h-1zM15 35h1v1h-1zM19 35h1v1h-1zM21 35h1v1h-1zM22 35h1v1h-1zM25 35h1v1h-1zM26 35h1v1h-1zM29 35h1v1h-1zM33 35h1v1h-1zM34 35h1v1h-1zM35 35h1v1h-1zM36 35h1v1h-1zM4 36h1v1h-1zM5 36h1v1h-1zM6 36h1v1h-1zM7 36h1v1h-1zM8 36h1v1h-1zM9 36h1v1h-1zM10 36h1v1h-1zM16 36h1v1h-1zM17 36h1v1h-1zM18 36h1v1h-1zM20 36h1v1h-1zM21 36h1v1h-1zM23 36h1v1h-1zM24 36h1v1h-1zM26 36h1v1h-1zM27 36h1v1h-1zM28 36h1v1h-1zM29 36h1v1h-1zM32 36h1v1h-1z" fill="#111" shape-rendering="crispEdges"/><rect x="15.5" y="15.5" width="10" height="10" rx="1.8" fill="#fff"/><g transform="translate(16.9 16.9) scale(0.3)"><path d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z" fill="#111"/></g></svg>`;

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


		const pluginName = 'dsh-mobile-account-ui';
		const pluginInject = [];
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
		/** 宿主机接口：会话落到插件数据文件，跨 DSH 重启有效（端口变化也不受影响）。 */
		const SESSION_ROUTE = '/plugins/dsh-mobile-tunnel/panel-session';
		function normalizeSession(value) {
		    if (typeof value !== 'object' || value === null)
		        return null;
		    const candidate = value;
		    if (typeof candidate.accessToken !== 'string' || candidate.accessToken.length === 0)
		        return null;
		    if (typeof candidate.refreshToken !== 'string' || candidate.refreshToken.length === 0)
		        return null;
		    if (typeof candidate.email !== 'string' || candidate.email.length === 0)
		        return null;
		    return {
		        accessToken: candidate.accessToken,
		        refreshToken: candidate.refreshToken,
		        email: candidate.email,
		    };
		}
		/** 浏览器内兜底副本：宿主机接口不可用时行为与改动前完全一致。 */
		function readLocalSession() {
		    try {
		        const raw = sessionStorage.getItem(SESSION_KEY);
		        return raw ? normalizeSession(JSON.parse(raw)) : null;
		    }
		    catch {
		        return null;
		    }
		}
		function writeLocalSession(session) {
		    try {
		        if (session)
		            sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
		        else
		            sessionStorage.removeItem(SESSION_KEY);
		    }
		    catch {
		        // 忽略
		    }
		}
		/** 读会话：宿主机接口优先；接口不可用（旧版插件/异常）才回落 sessionStorage。 */
		async function loadSession() {
		    try {
		        const response = await fetch(SESSION_ROUTE, { cache: 'no-store', headers: { accept: 'application/json' } });
		        if (response.ok) {
		            const body = (await response.json());
		            // 宿主机下发的服务端地址/下载页地址优先（换服务器部署时无需改客户端）
		            if (typeof body.apiBase === 'string' && /^https?:\/\//.test(body.apiBase)) {
		                apiBase = body.apiBase.replace(/\/+$/, '');
		            }
		            if (typeof body.downloadUrl === 'string' && /^https?:\/\//.test(body.downloadUrl)) {
		                downloadUrl = body.downloadUrl;
		            }
		            return normalizeSession(body?.session);
		        }
		    }
		    catch {
		        // 回落本地副本
		    }
		    return readLocalSession();
		}
		/** 写会话：先镜像到本地副本（保证接口异常时不丢登录），再交给宿主机持久化。 */
		async function saveSession(session) {
		    writeLocalSession(session);
		    try {
		        if (session) {
		            await fetch(SESSION_ROUTE, {
		                method: 'POST',
		                headers: { 'content-type': 'application/json' },
		                body: JSON.stringify({ session }),
		            });
		        }
		        else {
		            await fetch(SESSION_ROUTE, { method: 'DELETE' });
		        }
		    }
		    catch {
		        // 本地副本已写入，行为同改动前
		    }
		}
		async function api(path, options = {}) {
		    const response = await fetch(`${apiBase}${path}`, {
		        method: options.method ?? 'GET',
		        headers: {
		            'content-type': 'application/json',
		            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
		        },
		        body: options.body === undefined ? undefined : JSON.stringify(options.body),
		    });
		    let body = null;
		    try {
		        body = await response.json();
		    }
		    catch {
		        body = null;
		    }
		    return { status: response.status, body };
		}
		function errorText(result) {
		    const code = result.body?.error?.code ?? '';
		    const message = result.body?.error?.message ?? '';
		    if (message)
		        return `${message}${code ? `（${code}）` : ''}`;
		    return `请求失败（HTTP ${result.status}）`;
		}
		function el(tag, className, text) {
		    const node = document.createElement(tag);
		    if (className)
		        node.className = className;
		    if (text)
		        node.textContent = text;
		    return node;
		}
		function installStyle() {
		    if (document.getElementById('dsh-mobile-account-style'))
		        return;
		    const style = document.createElement('style');
		    style.id = 'dsh-mobile-account-style';
		    style.textContent = STYLE;
		    document.head.appendChild(style);
		}
		function createPanel() {
		    let overlay = null;
		    async function render() {
		        const node = overlay;
		        if (!node)
		            return;
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
		        if (!card.isConnected)
		            return;
		        sub.textContent = session ? session.email : '登录后手机可远程打开这台电脑的 DSH';
		        if (session) {
		            renderAccount(card, session);
		            renderDownload(card);
		        }
		        else {
		            renderAuth(card);
		        }
		    }
		    /** 登录后展示手机 App 下载入口：二维码内容与链接地址一致。 */
		    function renderDownload(card) {
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
		    function renderAuth(card) {
		        let mode = 'login';
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
		        function switchMode(next) {
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
		                void render();
		            }
		            catch (requestError) {
		                error.textContent = `网络错误：${requestError.message}`;
		            }
		            finally {
		                submit.disabled = false;
		                submit.textContent = mode === 'register' ? '注册并登录' : '登录';
		            }
		        });
		    }
		    function renderAccount(card, session) {
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
		        async function ensureToken() {
		            let current = await loadSession();
		            if (!current)
		                return null;
		            const account = await api('/v1/account', { token: current.accessToken });
		            if (account.status !== 401)
		                return current.accessToken;
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
		        async function loadAccount() {
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
		                if (list.length === 0)
		                    body.appendChild(el('p', 'dshma-muted', '暂无设备，请在电脑端安装 dsh-mobile-tunnel 插件'));
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
		            }
		            catch (requestError) {
		                body.innerHTML = '';
		                body.appendChild(el('p', 'dshma-error', `加载失败：${requestError.message}`));
		            }
		        }
		        void loadAccount();
		    }
		    function openPanel() {
		        if (overlay)
		            return;
		        installStyle();
		        overlay = el('div');
		        overlay.id = OVERLAY_ID;
		        overlay.addEventListener('click', (event) => {
		            if (event.target === overlay)
		                closePanel();
		        });
		        document.body.appendChild(overlay);
		        void render();
		    }
		    function closePanel() {
		        overlay?.remove();
		        overlay = null;
		    }
		    return { open: openPanel, close: closePanel };
		}
		const PHONE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 5.2h4"/><circle cx="12" cy="18.2" r="0.9" fill="currentColor" stroke="none"/></svg>';
		/** 在侧边栏里找“插件”导航项：按文字或 aria-label，兼容延迟渲染/折叠状态。 */
		function findPluginsNavItem() {
		    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], li'));
		    for (const candidate of candidates) {
		        if (candidate.id === NAV_ENTRY_ID)
		            continue;
		        const text = (candidate.textContent ?? '').replace(/\s+/g, '').trim();
		        const label = `${candidate.getAttribute('aria-label') ?? ''}${candidate.getAttribute('title') ?? ''}`.replace(/\s+/g, '');
		        const matches = /^插件\d{0,3}$/.test(text) ||
		            text === '插件设置' ||
		            /^plugins?\d{0,3}$/i.test(text) ||
		            /插件/.test(label);
		        if (!matches)
		            continue;
		        const rect = candidate.getBoundingClientRect();
		        // 已布局但明显不在左侧区域时跳过；尚未布局（0 尺寸）时仍然接受
		        if (rect.width > 0 && rect.left > 360)
		            continue;
		        if (candidate.matches('li')) {
		            const inner = candidate.querySelector('button, a, [role="button"]');
		            if (inner)
		                return inner;
		        }
		        return candidate;
		    }
		    return null;
		}
		/** 把入口挂到“插件”下面（找不到时什么都不做，不再显示悬浮按钮）。 */
		function mountNavEntry(panel) {
		    if (document.getElementById(NAV_ENTRY_ID))
		        return true;
		    const target = findPluginsNavItem();
		    if (!target)
		        return false;
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
		const MORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
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
		const MOBILE_DISABLED_PATTERNS = [/添加工作区/, /打开文件夹/, /打开文件/, /工作区文件/, /目录选择/];
		let hiddenSidebarItems = [];
		function isMobileApp() {
		    if (document.documentElement?.getAttribute('data-dsh-mobile-app') === '1')
		        return true;
		    // App 标记注入失败时的兜底：手机 WebView/浏览器 UA 直接按移动端处理
		    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
		}
		/** `dsh-resource://file/session/<sessionId>/<path>` → `{ sessionId, path }`（path 保留前导斜杠）。 */
		function parseFileAddress(address) {
		    try {
		        const url = new URL(address);
		        if (url.protocol !== 'dsh-resource:' || url.host !== 'file')
		            return null;
		        const segments = url.pathname.replace(/^\//, '').split('/');
		        if (segments[0] !== 'session')
		            return null;
		        const sessionId = decodeURIComponent(segments[1] ?? '');
		        if (!sessionId)
		            return null;
		        return {
		            sessionId,
		            path: segments
		                .slice(2)
		                .map((segment) => decodeURIComponent(segment))
		                .join('/'),
		        };
		    }
		    catch {
		        return null;
		    }
		}
		function fileFailure(code, message) {
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
		function mountFileProvider(ctx) {
		    if (!isMobileApp() || typeof ctx?.get !== 'function')
		        return () => undefined;
		    let release;
		    let timer = 0;
		    let disposed = false;
		    const tryRegister = () => {
		        if (disposed || release)
		            return true;
		        const resources = ctx.get?.('resources');
		        if (!resources || typeof resources.register !== 'function')
		            return false;
		        try {
		            release = resources.register({
		                protocol: 'file',
		                async *open(address, opts) {
		                    const parsed = parseFileAddress(address);
		                    if (!parsed) {
		                        yield fileFailure('workspace-file/unsupported-address', '不支持的资源地址');
		                        return;
		                    }
		                    const remote = ctx.get?.('remote');
		                    const workspaceFiles = remote?.workspaceFiles;
		                    if (!workspaceFiles) {
		                        yield fileFailure('workspace-file/unavailable', '工作区文件通道尚未就绪');
		                        return;
		                    }
		                    try {
		                        yield await workspaceFiles.stat(parsed.sessionId, parsed.path, opts.signal);
		                    }
		                    catch (error) {
		                        yield fileFailure('workspace-file/read-failed', String(error?.message ?? error));
		                    }
		                },
		            });
		            console.log('[file-provider] registered');
		        }
		        catch (error) {
		            // 已有其它提供方（桌面端 DSH 自带），保持原样
		            console.log('[file-provider] skipped: ' + String(error?.message ?? error));
		        }
		        return true;
		    };
		    if (!tryRegister()) {
		        timer = window.setInterval(() => {
		            if (!tryRegister())
		                return;
		            window.clearInterval(timer);
		            timer = 0;
		        }, 300);
		    }
		    return () => {
		        disposed = true;
		        if (timer)
		            window.clearInterval(timer);
		        try {
		            release?.();
		        }
		        catch {
		            // 忽略
		        }
		    };
		}
		/** 只把侧边栏当作作用域，避免误伤主区域的模型/安全审查等按钮。 */
		function sidebarRoot() {
		    const all = Array.from(document.querySelectorAll('button[aria-label], a[aria-label]'));
		    const anchor = all.find((element) => ['自动化任务', '插件市场', '记忆系统', '插件'].includes((element.getAttribute('aria-label') ?? '').trim()));
		    if (!anchor)
		        return null;
		    // 从入口向上找到“最小的、至少包含 3 个入口”的容器，即侧栏本身
		    let node = anchor;
		    while (node && node !== document.body) {
		        const rect = node.getBoundingClientRect();
		        const count = node.querySelectorAll('button[aria-label], a[aria-label]').length;
		        if (count >= 3 && rect.left <= 16 && rect.width > 0 && rect.width <= 420)
		            return node;
		        node = node.parentElement;
		    }
		    return null;
		}
		function sidebarButtons() {
		    const root = sidebarRoot();
		    if (!root)
		        return [];
		    return Array.from(root.querySelectorAll('button[aria-label], a[aria-label]')).filter((element) => {
		        if (element.id === NAV_ENTRY_ID || element.id === MORE_ENTRY_ID)
		            return false;
		        // 已被本插件收起的入口：尺寸为 0，但仍要参与后续轮次，否则“更多功能”会被误删
		        if (element.dataset.dshMobileHidden === '1')
		            return true;
		        const rect = element.getBoundingClientRect();
		        return rect.width > 0 && rect.height > 0;
		    });
		}
		function closeMorePanel() {
		    document.getElementById('dsh-mobile-account-more-panel')?.remove();
		}
		/** “更多功能”底部菜单：列出被收起的侧栏入口，点击后触发原入口。 */
		function openMorePanel() {
		    closeMorePanel();
		    if (hiddenSidebarItems.length === 0)
		        return;
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
		        if (event.target === overlay)
		            closeMorePanel();
		    });
		    document.body.appendChild(overlay);
		}
		function ensureMoreEntry(anchor, before) {
		    if (!anchor || hiddenSidebarItems.length === 0) {
		        document.getElementById(MORE_ENTRY_ID)?.remove();
		        return;
		    }
		    let entry = document.getElementById(MORE_ENTRY_ID);
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
		        if (entry.nextElementSibling !== before)
		            before.parentElement.insertBefore(entry, before);
		    }
		    else if (entry.previousElementSibling !== anchor) {
		        anchor.insertAdjacentElement('afterend', entry);
		    }
		    // 收起态只显示图标，不显示“更多功能”文字
		    const collapsed = !!document.querySelector('button[aria-label="打开侧边栏"]');
		    const label = entry.querySelector('.dshma-nav-label');
		    if (label)
		        label.style.display = collapsed ? 'none' : '';
		    entry.style.width = collapsed ? '36px' : '100%';
		    entry.style.padding = collapsed ? '0' : '6px 10px';
		    entry.style.borderRadius = collapsed ? '12px' : '8px';
		    entry.style.justifyContent = collapsed ? 'center' : 'flex-start';
		    entry.style.opacity = '1';
		    entry.style.visibility = 'visible';
		}
		const PANEL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M9 3v18"/></svg>';
		/** 收起态：展开按钮换成侧栏图标；展开态：恢复品牌 Logo（鲸鱼 + DeepSeek Harness）。 */
		function applyLogoPolicy() {
		    if (!isMobileApp())
		        return;
		    const toggle = document.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]');
		    if (!toggle)
		        return;
		    const row = toggle.parentElement;
		    const collapsed = toggle.getAttribute('aria-label') === '打开侧边栏';
		    row?.querySelectorAll('[class*="brand" i]').forEach((element) => {
		        if (!toggle.contains(element))
		            element.style.display = collapsed ? 'none' : '';
		    });
		    if (collapsed) {
		        toggle.querySelectorAll('svg').forEach((svg) => {
		            if (!svg.closest('.dshma-toggle-icon'))
		                svg.style.display = 'none';
		        });
		        if (!toggle.querySelector('.dshma-toggle-icon')) {
		            const icon = document.createElement('span');
		            icon.className = 'dshma-toggle-icon';
		            icon.innerHTML = PANEL_ICON;
		            (toggle.querySelector('[class*="railMark" i], [data-slot="sidebar.brand.mark"]') ?? toggle).appendChild(icon);
		        }
		    }
		    else {
		        toggle.querySelectorAll('svg').forEach((svg) => {
		            svg.style.display = '';
		        });
		        toggle.querySelector('.dshma-toggle-icon')?.remove();
		    }
		}
		/** 依赖电脑端原生对话框的入口：不论在侧栏哪个区域，移动端一律隐藏。 */
		function hideDesktopOnlyEntries() {
		    if (!isMobileApp())
		        return;
		    const toggle = document.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]');
		    // 只处理左侧栏列内部的入口；右侧栏（文件预览/终端）结构上不在这个容器里
		    const column = toggle?.closest('[class*="sidebarCol" i], aside');
		    const scope = column ?? document;
		    scope.querySelectorAll('button, a, [role="button"]').forEach((element) => {
		        if (element.id === MORE_ENTRY_ID || element.closest('#dsh-mobile-account-more-panel'))
		            return;
		        if (element.dataset.dshMobileHidden === '1')
		            return;
		        const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, '').trim();
		        if (!label)
		            return;
		        if (MOBILE_DISABLED_PATTERNS.some((pattern) => pattern.test(label))) {
		            element.style.display = 'none';
		        }
		    });
		}
		/** 手机 App 内：侧栏按白名单保留，其余入口收进“更多功能”。 */
		function applyMobileMenuPolicy() {
		    document.documentElement.classList.toggle('dshma-mobile', isMobileApp());
		    if (!isMobileApp())
		        return;
		    document.getElementById(NAV_ENTRY_ID)?.remove();
		    hiddenSidebarItems = [];
		    let anchor = null;
		    let preferredAnchor = null;
		    for (const button of sidebarButtons()) {
		        const label = (button.getAttribute('aria-label') ?? '').replace(/\s+/g, '').trim();
		        if (!label)
		            continue;
		        if (MOBILE_KEEP_LABELS.has(label)) {
		            button.style.display = '';
		            delete button.dataset.dshMobileHidden;
		            anchor = button;
		            if (label === '自动化任务')
		                preferredAnchor = button;
		            continue;
		        }
		        button.style.display = 'none';
		        button.dataset.dshMobileHidden = '1';
		        // 依赖电脑端原生对话框的入口：移动端直接隐藏，不放进“更多功能”
		        if (MOBILE_DISABLED_PATTERNS.some((pattern) => pattern.test(label)))
		            continue;
		        hiddenSidebarItems.push({ label, element: button });
		    }
		    hideDesktopOnlyEntries();
		    const searchButton = document.querySelector('button[aria-label="搜索会话"]');
		    const searchWrap = searchButton?.parentElement;
		    const collapsedRail = !!document.querySelector('button[aria-label="打开侧边栏"]');
		    // 收起态：隐藏工作区区域里留白的 sectionHeader，避免下方图标被顶下去
		    const railContainer = searchWrap?.parentElement;
		    const sectionHeader = railContainer
		        ? Array.from(railContainer.children).find((child) => /sectionHeader/i.test(String(child.className)))
		        : undefined;
		    if (sectionHeader instanceof HTMLElement) {
		        sectionHeader.style.display = collapsedRail ? 'none' : '';
		    }
		    if (collapsedRail && searchWrap?.parentElement) {
		        // 收起态：把“更多功能”放到工作区图标组、搜索按钮之前，避免负边距裁切
		        ensureMoreEntry(searchWrap, searchWrap);
		    }
		    else {
		        ensureMoreEntry(preferredAnchor ?? anchor);
		    }
		    applyLogoPolicy();
		}
		/** Cordis 客户端插件入口。 */
		function apply(ctx) {
		    if (typeof document === 'undefined')
		        return () => undefined;
		    // 文件管家与界面策略相互独立：即使下面因重复挂载提前返回，也要保留它的清理函数。
		    const disposeFileProvider = mountFileProvider(ctx);
		    installStyle();
		    if (document.getElementById(NAV_ENTRY_ID))
		        return disposeFileProvider;
		    // 移动端：用自己的文件面板替换官方「工作区文件」入口（官方预览依赖缺失的 resources 服务）。
		    const filePanel = filePanelEnabled() ? mountFilePanel() : null;
		    console.log('[mobile-menu] mobile=' + isMobileApp() + ' flag=' + document.documentElement?.getAttribute('data-dsh-mobile-app') + ' ua=' + navigator.userAgent.slice(0, 70));
		    const retryLogo = () => {
		        applyLogoPolicy();
		        window.setTimeout(applyLogoPolicy, 120);
		        window.setTimeout(applyLogoPolicy, 400);
		        window.setTimeout(applyLogoPolicy, 900);
		        window.setTimeout(applyLogoPolicy, 1600);
		        window.setTimeout(applyLogoPolicy, 2400);
		    };
		    const onToggleClick = (event) => {
		        const target = event.target;
		        if (target?.closest('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]'))
		            retryLogo();
		    };
		    document.addEventListener('click', onToggleClick, true);
		    // 移动端：切换会话/工作区时临时拦截输入框的自动聚焦，避免键盘闪一下
		    let focusGuardTimer = 0;
		    let restoreFocus = null;
		    const guardComposerFocus = () => {
		        if (restoreFocus) {
		            window.clearTimeout(focusGuardTimer);
		        }
		        else {
		            const original = HTMLElement.prototype.focus;
		            restoreFocus = () => {
		                HTMLElement.prototype.focus = original;
		                restoreFocus = null;
		            };
		            HTMLElement.prototype.focus = function (...args) {
		                if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.isContentEditable)
		                    return;
		                return original.apply(this, args);
		            };
		        }
		        focusGuardTimer = window.setTimeout(() => {
		            restoreFocus?.();
		        }, 800);
		    };
		    const onSidebarClick = (event) => {
		        if (!isMobileApp())
		            return;
		        const target = event.target;
		        if (!target)
		            return;
		        if (target.closest('input, textarea, [contenteditable="true"]'))
		            return;
		        if (!target.closest('[class*="sidebarCol" i], aside'))
		            return;
		        const active = document.activeElement;
		        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
		            active.blur();
		        }
		        guardComposerFocus();
		    };
		    document.addEventListener('click', onSidebarClick, true);
		    const panel = createPanel();
		    const syncEntry = () => {
		        applyMobileMenuPolicy();
		        // 手机 App 内不提供“移动端”入口（避免入口套入口）
		        if (isMobileApp())
		            return;
		        mountNavEntry(panel);
		    };
		    syncEntry();
		    // 首屏 DSH 可能在插件之后才完成侧栏渲染：仅在移动端延时校正
		    if (isMobileApp())
		        retryLogo();
		    // DSH 侧边栏会随路由/折叠重渲染；App 注入标识也是异步的
		    let pending = 0;
		    const observer = new MutationObserver(() => {
		        if (pending)
		            return;
		        pending = window.setTimeout(() => {
		            pending = 0;
		            applyMobileMenuPolicy();
		            if (!isMobileApp() && !document.getElementById(NAV_ENTRY_ID))
		                syncEntry();
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

		exports.apply = apply;
		exports.inject = pluginInject;
		exports.name = pluginName;
		return module.exports;
	}
});
