import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * 手机 App 下载页。
 *
 * - `GET /download`：手机友好的下载页（版本 / 大小 / 更新时间 / 下载按钮）
 * - `GET /download/latest.apk`：永远指向最新正式版安装包
 * - `GET /download/<file>`：按文件名下载（只接受 `dsh-mobile-*.apk`）
 *
 * 安装包由部署目录提供（容器内挂载，默认 /app/apk），按 `dsh-mobile-<version>.apk`
 * 命名；`-test` 结尾的测试包只在没有正式版时兜底，不会成为“最新版”。
 */
export interface DownloadRouteDeps {
  /** 安装包目录（不存在时页面显示“暂未上传”） */
  apkDir: string;
}

interface ApkRelease {
  file: string;
  version: string;
  size: number;
  updatedAt: Date;
  test: boolean;
}

const FILE_PATTERN = /^dsh-mobile-[0-9A-Za-z][0-9A-Za-z.-]*\.apk$/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 版本号比较：按数字段对齐，`0.1.9` < `0.1.22`。 */
function compareVersion(a: string, b: string): number {
  const partsA = a.split(/[.-]/);
  const partsB = b.split(/[.-]/);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const left = partsA[index] ?? '';
    const right = partsB[index] ?? '';
    const leftNumber = /^\d+$/.test(left) ? Number(left) : Number.NaN;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : Number.NaN;
    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      const diff = left.localeCompare(right);
      if (diff !== 0) return diff;
      continue;
    }
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  }
  return 0;
}

async function listReleases(apkDir: string): Promise<ApkRelease[]> {
  let entries: string[];
  try {
    entries = await readdir(apkDir);
  } catch {
    return [];
  }
  const releases: ApkRelease[] = [];
  for (const file of entries) {
    if (!FILE_PATTERN.test(file)) continue;
    const version = file.replace(/^dsh-mobile-/, '').replace(/\.apk$/, '');
    let info;
    try {
      info = await stat(path.join(apkDir, file));
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    releases.push({ file, version, size: info.size, updatedAt: info.mtime, test: version.endsWith('-test') });
  }
  releases.sort((left, right) => compareVersion(right.version, left.version));
  return releases;
}

function pickLatest(releases: ApkRelease[]): ApkRelease | null {
  return releases.find((release) => !release.test) ?? releases[0] ?? null;
}

function pageHtml(latest: ApkRelease | null, fallbackVersion: string): string {
  const title = 'DSH 移动端';
  const versionText = latest ? `v${escapeHtml(latest.version.replace(/-test$/, ''))}` : fallbackVersion;
  const meta = latest
    ? `<p class="meta">${versionText} · ${formatSize(latest.size)} · 更新于 ${escapeHtml(latest.updatedAt.toISOString().slice(0, 16).replace('T', ' '))}</p>`
    : '<p class="meta">安装包尚未上传，请稍后再试。</p>';
  const action = latest
    ? `<a class="button" href="/download/latest.apk">下载安装包</a>`
    : '<span class="button disabled">暂未上传安装包</span>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · 下载</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#1c2330;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#14161b;color:#e8ecf4}}
.card{width:min(420px,100%);background:#fff;border-radius:18px;padding:30px 24px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.10)}
@media (prefers-color-scheme:dark){.card{background:#1b1e26;box-shadow:0 10px 40px rgba(0,0,0,.5)}}
h1{font-size:20px;margin:0 0 6px}
.sub{color:#7a8494;font-size:13px;margin:0 0 18px}
.meta{color:#6b7484;font-size:13px;margin:0 0 22px}
.button{display:block;border-radius:12px;padding:14px 0;background:linear-gradient(135deg,#4f7cff,#7a5cff);color:#fff;text-decoration:none;font-weight:600;font-size:15px}
.button.disabled{background:#c9ced8;color:#fff}
.note{margin:18px 0 0;color:#8a93a3;font-size:12px;line-height:1.6}
</style>
</head>
<body>
<main class="card">
<h1>${title}</h1>
<p class="sub">手机远控电脑上的 DSH</p>
${meta}
${action}
<p class="note">安装后登录同一账号，即可远程打开这台电脑的 DSH。</p>
</main>
</body>
</html>`;
}

export function registerDownloadRoutes(app: FastifyInstance, deps: DownloadRouteDeps): void {
  app.get('/download', async (_request, reply) => {
    const latest = pickLatest(await listReleases(deps.apkDir));
    return reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(pageHtml(latest, '最新版本'));
  });

  app.get('/download/latest.apk', async (_request, reply) => {
    const latest = pickLatest(await listReleases(deps.apkDir));
    if (!latest) return reply.code(404).type('text/plain; charset=utf-8').send('暂未上传安装包');
    // 每次都现算：上传新版本后不需要改任何配置
    return reply
      .code(302)
      .header('cache-control', 'no-store')
      .header('location', `/download/${encodeURIComponent(latest.file)}`)
      .send();
  });

  app.get<{ Params: { file: string } }>('/download/:file', async (request, reply) => {
    const file = request.params.file;
    if (!FILE_PATTERN.test(file)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('文件不存在');
    }
    const absPath = path.resolve(deps.apkDir, file);
    if (path.dirname(absPath) !== path.resolve(deps.apkDir)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('文件不存在');
    }
    let info;
    try {
      info = await stat(absPath);
    } catch {
      return reply.code(404).type('text/plain; charset=utf-8').send('文件不存在');
    }
    if (!info.isFile()) {
      return reply.code(404).type('text/plain; charset=utf-8').send('文件不存在');
    }
    return reply
      .code(200)
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-length', String(info.size))
      .header('content-disposition', `attachment; filename="${file}"`)
      .header('cache-control', 'public, max-age=300')
      .send(createReadStream(absPath));
  });
}
