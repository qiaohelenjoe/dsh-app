import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
/**
 * 移动端文件面板的宿主侧文件接口（只读，限定在当前会话的工作区内）。
 *
 * 为什么不走 `remote.workspaceFiles`：客户端插件声明该服务会让整个插件延迟启动，反应式
 * 注入又被 Cordis 拒绝。宿主插件本身就在桌面进程里，直接读文件系统更简单。
 *
 * 三个接口：
 * - `GET /plugins/dsh-mobile-tunnel/fs-roots[?session=]` 当前会话的工作区（唯一根）
 * - `GET /plugins/dsh-mobile-tunnel/fs?path=<abs>`      列目录（必须在工作区内）
 * - `GET /plugins/dsh-mobile-tunnel/fs-file?path=<abs>` 读文件（必须在工作区内）
 *
 * 工作区判定：`~/.dsh/storages/workspace.json` 的 `tables.workspaces[*].path/sessionIds`；
 * 未传 session 时取最近写入的会话（~/.dsh/sessions/<workspace>/session-<id>/ 的最新 mtime）。
 */
export const FS_ROOTS_ROUTE = '/plugins/dsh-mobile-tunnel/fs-roots';
export const FS_LIST_ROUTE = '/plugins/dsh-mobile-tunnel/fs';
export const FS_FILE_ROUTE = '/plugins/dsh-mobile-tunnel/fs-file';
const MAX_TEXT_BYTES = 512 * 1024;
const DSH_HOME = join(homedir(), '.dsh');
const WORKSPACE_STORE = join(DSH_HOME, 'storages', 'workspace.json');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(body)),
    });
    res.end(body);
}
function textOf(value) {
    return typeof value === 'string' ? value : '';
}
async function loadWorkspaces() {
    const result = new Map();
    let raw = '';
    try {
        raw = await readFile(WORKSPACE_STORE, 'utf8');
    }
    catch {
        return result;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return result;
    }
    const tables = parsed.tables;
    const workspaces = tables?.workspaces ?? {};
    for (const [id, record] of Object.entries(workspaces)) {
        if (record && typeof record.path === 'string' && record.path) {
            result.set(id, record);
        }
    }
    return result;
}
/** 最近写入的会话 id（不带 `session-` 前缀）。 */
async function latestSessionId() {
    let best = { id: '', at: 0 };
    let workspaces = [];
    try {
        workspaces = (await readdir(SESSIONS_DIR, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch {
        return '';
    }
    for (const workspace of workspaces) {
        let sessions = [];
        try {
            sessions = (await readdir(join(SESSIONS_DIR, workspace), { withFileTypes: true }))
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
                .map((entry) => entry.name);
        }
        catch {
            continue;
        }
        for (const dir of sessions) {
            try {
                const info = await stat(join(SESSIONS_DIR, workspace, dir, 'session.v4.jsonl.zstd'));
                if (info.mtimeMs > best.at) {
                    best = { id: dir.replace(/^session-/, ''), at: info.mtimeMs };
                }
            }
            catch {
                // 会话还没落盘
            }
        }
    }
    return best.id;
}
/**
 * 解析当前工作区：优先用调用方给的 session，其次最近写入的会话。
 * @param sessionId - 可选会话 id（可带 `session-` 前缀）。
 */
export async function resolveWorkspaceScope(sessionId) {
    const wanted = textOf(sessionId).replace(/^session-/, '');
    const fallback = wanted || (await latestSessionId());
    const workspaces = await loadWorkspaces();
    for (const [id, record] of workspaces) {
        const ids = (record.sessionIds ?? []).map((value) => value.replace(/^session-/, ''));
        if (fallback && ids.includes(fallback)) {
            return { path: record.path, title: record.title || record.path, sessionId: fallback };
        }
        void id;
    }
    // 会话没登记进任何工作区时，退化为默认工作区
    for (const record of workspaces.values()) {
        if (record.title === 'default-workspace') {
            return { path: record.path, title: record.title, sessionId: fallback };
        }
    }
    return null;
}
function within(root, target) {
    const a = resolve(root).toLowerCase().replace(/[/\\]+$/, '');
    const b = resolve(target).toLowerCase().replace(/[/\\]+$/, '');
    if (b === a)
        return true;
    return b.startsWith(a + (process.platform === 'win32' ? '\\' : sep));
}
async function listDirectory(path) {
    const dirents = await readdir(path, { withFileTypes: true });
    const entries = [];
    for (const dirent of dirents) {
        const full = join(path, dirent.name);
        let size = 0;
        let isDir = dirent.isDirectory();
        try {
            const info = await stat(full);
            isDir = info.isDirectory();
            size = info.size;
        }
        catch {
            // 权限/断链时仍展示名字
        }
        entries.push({ name: dirent.name, isDir, size });
    }
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir)
            return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return entries;
}
export async function handleFsRoots(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const scope = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
    if (!scope) {
        sendJson(res, 404, { error: 'no-workspace' });
        return;
    }
    sendJson(res, 200, {
        sessionId: scope.sessionId,
        roots: [{ label: scope.title, path: scope.path }],
    });
}
export async function handleFsList(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = textOf(url.searchParams.get('path'));
    const scope = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
    if (!scope) {
        sendJson(res, 404, { error: 'no-workspace' });
        return;
    }
    if (!target || !isAbsolute(target)) {
        sendJson(res, 400, { error: 'path-not-absolute', path: target });
        return;
    }
    if (!within(scope.path, target)) {
        sendJson(res, 403, { error: 'outside-workspace', root: scope.path, path: target });
        return;
    }
    try {
        const info = await stat(target);
        if (!info.isDirectory()) {
            sendJson(res, 400, { error: 'not-a-directory', path: target });
            return;
        }
        const entries = await listDirectory(target);
        sendJson(res, 200, { path: resolve(target), root: scope.path, entries });
    }
    catch (error) {
        sendJson(res, 404, { error: 'list-failed', path: target, detail: String(error.message) });
    }
}
export async function handleFsFile(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const raw = textOf(url.searchParams.get('path'));
    const mode = textOf(url.searchParams.get('mode')) || 'auto';
    const scope = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
    if (!scope) {
        sendJson(res, 404, { error: 'no-workspace' });
        return;
    }
    if (!raw || !isAbsolute(raw)) {
        sendJson(res, 400, { error: 'path-invalid', path: raw });
        return;
    }
    if (!within(scope.path, raw)) {
        sendJson(res, 403, { error: 'outside-workspace', root: scope.path, path: raw });
        return;
    }
    try {
        const info = await stat(raw);
        if (!info.isFile()) {
            sendJson(res, 400, { error: 'not-a-file', path: raw });
            return;
        }
        const ext = extname(raw).toLowerCase();
        const isImage = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(ext);
        if (mode === 'raw' || (mode === 'auto' && isImage)) {
            const data = await readFile(raw);
            res.writeHead(200, {
                'content-type': mimeOf(ext),
                'content-length': String(data.byteLength),
                'cache-control': 'no-store',
            });
            res.end(data);
            return;
        }
        const buffer = await readFile(raw);
        const slice = buffer.subarray(0, MAX_TEXT_BYTES);
        let binary = false;
        for (const byte of slice) {
            if (byte === 0) {
                binary = true;
                break;
            }
        }
        if (binary) {
            res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': String(buffer.byteLength),
                'cache-control': 'no-store',
            });
            res.end(buffer);
            return;
        }
        sendJson(res, 200, {
            path: raw,
            size: info.size,
            truncated: buffer.byteLength > MAX_TEXT_BYTES,
            text: buffer.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
        });
    }
    catch (error) {
        sendJson(res, 404, { error: 'read-failed', path: raw, detail: String(error.message) });
    }
}
function mimeOf(ext) {
    switch (ext) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        case '.bmp':
            return 'image/bmp';
        case '.svg':
            return 'image/svg+xml';
        case '.ico':
            return 'image/x-icon';
        default:
            return 'application/octet-stream';
    }
}
//# sourceMappingURL=fs-routes.js.map