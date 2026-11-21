import type { IncomingMessage, ServerResponse } from 'node:http';
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
 * 工作区判定：`~/.dsh/storages/workspace.json` 的 `tables.workspaces[*].path/sessionIds`，
 * 并用 `~/.dsh/sessions/<workspace>/session-<id>/` 目录名做权威校验；
 * 未传 session 时取最近写入的会话。
 *
 * 显式传了 session 但对不上任何工作区时**不再静默回落默认工作区**（那样客户端一旦给错
 * 会话 id 就会永远打开同一个错误目录），改为 404 `session-not-found`，由客户端决定是否
 * 去掉 session 重试。
 */

export const FS_ROOTS_ROUTE = '/plugins/dsh-mobile-tunnel/fs-roots';
export const FS_LIST_ROUTE = '/plugins/dsh-mobile-tunnel/fs';
export const FS_FILE_ROUTE = '/plugins/dsh-mobile-tunnel/fs-file';

const MAX_TEXT_BYTES = 512 * 1024;
const DSH_HOME = join(homedir(), '.dsh');
const WORKSPACE_STORE = join(DSH_HOME, 'storages', 'workspace.json');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
}

interface WorkspaceRecord {
  path: string;
  title?: string;
  sessionIds?: string[];
}

interface WorkspaceScope {
  path: string;
  title: string;
  sessionId: string;
}

/** 工作区解析结果：`scope` 为空时用 `sessionUnknown` 区分「会话未知」与「没有工作区」。 */
interface ScopeLookup {
  scope: WorkspaceScope | null;
  sessionUnknown: boolean;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function loadWorkspaces(): Promise<Map<string, WorkspaceRecord>> {
  const result = new Map<string, WorkspaceRecord>();
  let raw = '';
  try {
    raw = await readFile(WORKSPACE_STORE, 'utf8');
  } catch {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  const tables = (parsed as { tables?: { workspaces?: Record<string, WorkspaceRecord> } }).tables;
  const workspaces = tables?.workspaces ?? {};
  for (const [id, record] of Object.entries(workspaces)) {
    if (record && typeof record.path === 'string' && record.path) {
      result.set(id, record);
    }
  }
  return result;
}

/** 最近写入的会话 id（不带 `session-` 前缀）。 */
async function latestSessionId(): Promise<string> {
  let best = { id: '', at: 0 };
  let workspaces: string[] = [];
  try {
    workspaces = (await readdir(SESSIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return '';
  }
  for (const workspace of workspaces) {
    let sessions: string[] = [];
    try {
      sessions = (await readdir(join(SESSIONS_DIR, workspace), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dir of sessions) {
      try {
        const info = await stat(join(SESSIONS_DIR, workspace, dir, 'session.v4.jsonl.zstd'));
        if (info.mtimeMs > best.at) {
          best = { id: dir.replace(/^session-/, ''), at: info.mtimeMs };
        }
      } catch {
        // 会话还没落盘
      }
    }
  }
  return best.id;
}

function stripSessionPrefix(value: string): string {
  return value.replace(/^session-/, '');
}

/** 会话目录名里的工作区编码：`G:\zxht-git\other\dsh-app` → `--G-zxht-git-other-dsh-app--`。 */
function encodeWorkspaceDir(path: string): string {
  return '--' + path.replace(/[\\/:]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-') + '--';
}

function scopeOf(record: WorkspaceRecord, sessionId: string): WorkspaceScope {
  return { path: record.path, title: record.title || record.path, sessionId };
}

function defaultWorkspace(workspaces: Map<string, WorkspaceRecord>): WorkspaceRecord | null {
  for (const record of workspaces.values()) {
    if (record.title === 'default-workspace') return record;
  }
  return null;
}

/**
 * 用 `~/.dsh/sessions/<dir>/session-<id>` 反查工作区。
 *
 * 目录名由 DSH 按工作区路径编码而来，比 workspace.json 里的 `sessionIds` 更贴近事实
 * （会话迁移、记录过期都不会影响它），所以优先采信。
 */
async function workspaceFromSessionDir(
  sessionId: string,
  workspaces: Map<string, WorkspaceRecord>,
): Promise<WorkspaceRecord | null> {
  if (!sessionId) return null;
  let dirs: string[] = [];
  try {
    dirs = (await readdir(SESSIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const wanted = 'session-' + sessionId;
  for (const dir of dirs) {
    let sessions: string[] = [];
    try {
      sessions = await readdir(join(SESSIONS_DIR, dir));
    } catch {
      continue;
    }
    if (!sessions.includes(wanted)) continue;
    for (const record of workspaces.values()) {
      if (encodeWorkspaceDir(record.path).toLowerCase() === dir.toLowerCase()) return record;
    }
  }
  return null;
}

/**
 * 解析当前工作区。
 *
 * - 未传 session：取最近写入的会话，找不到再退默认工作区；
 * - 传了 session：会话目录 → workspace.json 的 `sessionIds`，都没有则 `sessionUnknown`，
 *   由调用方返回 404（**不再静默回落默认工作区**，否则错会话会永远打开同一个错目录）。
 *
 * @param sessionId - 可选会话 id（可带 `session-` 前缀）。
 */
export async function resolveWorkspaceScope(sessionId?: string): Promise<ScopeLookup> {
  const wanted = stripSessionPrefix(textOf(sessionId));
  const workspaces = await loadWorkspaces();
  if (wanted) {
    const record = await workspaceFromSessionDir(wanted, workspaces);
    if (record) return { scope: scopeOf(record, wanted), sessionUnknown: false };
    for (const candidate of workspaces.values()) {
      const ids = (candidate.sessionIds ?? []).map(stripSessionPrefix);
      if (ids.includes(wanted)) return { scope: scopeOf(candidate, wanted), sessionUnknown: false };
    }
    return { scope: null, sessionUnknown: true };
  }
  const latest = await latestSessionId();
  const latestRecord = await workspaceFromSessionDir(latest, workspaces);
  if (latestRecord) return { scope: scopeOf(latestRecord, latest), sessionUnknown: false };
  for (const record of workspaces.values()) {
    const ids = (record.sessionIds ?? []).map(stripSessionPrefix);
    if (latest && ids.includes(latest)) return { scope: scopeOf(record, latest), sessionUnknown: false };
  }
  const fallback = defaultWorkspace(workspaces);
  return { scope: fallback ? scopeOf(fallback, latest) : null, sessionUnknown: false };
}

function within(root: string, target: string): boolean {
  const a = resolve(root).toLowerCase().replace(/[/\\]+$/, '');
  const b = resolve(target).toLowerCase().replace(/[/\\]+$/, '');
  if (b === a) return true;
  return b.startsWith(a + (process.platform === 'win32' ? '\\' : sep));
}

async function listDirectory(path: string): Promise<Entry[]> {
  const dirents = await readdir(path, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const dirent of dirents) {
    const full = join(path, dirent.name);
    let size = 0;
    let isDir = dirent.isDirectory();
    try {
      const info = await stat(full);
      isDir = info.isDirectory();
      size = info.size;
    } catch {
      // 权限/断链时仍展示名字
    }
    entries.push({ name: dirent.name, isDir, size });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return entries;
}

export async function handleFsRoots(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const lookup = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
  if (!lookup.scope) {
    sendJson(res, 404, { error: lookup.sessionUnknown ? 'session-not-found' : 'no-workspace' });
    return;
  }
  sendJson(res, 200, {
    sessionId: lookup.scope.sessionId,
    roots: [{ label: lookup.scope.title, path: lookup.scope.path }],
  });
}

export async function handleFsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const target = textOf(url.searchParams.get('path'));
  const lookup = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
  if (!lookup.scope) {
    sendJson(res, 404, { error: lookup.sessionUnknown ? 'session-not-found' : 'no-workspace' });
    return;
  }
  const scope = lookup.scope;
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
  } catch (error) {
    sendJson(res, 404, { error: 'list-failed', path: target, detail: String((error as Error).message) });
  }
}

export async function handleFsFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = textOf(url.searchParams.get('path'));
  const mode = textOf(url.searchParams.get('mode')) || 'auto';
  const scopeLookup = await resolveWorkspaceScope(textOf(url.searchParams.get('session')));
  if (!scopeLookup.scope) {
    sendJson(res, 404, { error: scopeLookup.sessionUnknown ? 'session-not-found' : 'no-workspace' });
    return;
  }
  const scope = scopeLookup.scope;
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
  } catch (error) {
    sendJson(res, 404, { error: 'read-failed', path: raw, detail: String((error as Error).message) });
  }
}

function mimeOf(ext: string): string {
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
