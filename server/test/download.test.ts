import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerDownloadRoutes } from '../src/http/download-routes.js';

async function createApp(apkDir: string): Promise<FastifyInstance> {
  const app = Fastify();
  registerDownloadRoutes(app, { apkDir });
  await app.ready();
  return app;
}

async function createApkDir(files: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-apk-'));
  for (const [name, size] of Object.entries(files)) {
    await writeFile(join(dir, name), Buffer.alloc(size, 1));
  }
  return dir;
}

test('下载页展示最新正式版，latest.apk 跳过测试包并重定向', async () => {
  const apkDir = await createApkDir({
    'dsh-mobile-0.1.9.apk': 1024,
    'dsh-mobile-0.1.22.apk': 2 * 1024 * 1024,
    'dsh-mobile-0.1.22-test.apk': 3 * 1024 * 1024,
  });
  const app = await createApp(apkDir);
  try {
    const page = await app.inject({ method: 'GET', url: '/download' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.ok(page.body.includes('v0.1.22'), '页面应显示最新正式版版本号');
    assert.ok(page.body.includes('2.0 MB'), '页面应显示安装包大小');
    assert.ok(!page.body.includes('v0.1.22-test'), '测试包不应作为最新版展示');
    assert.ok(page.body.includes('/download/latest.apk'), '页面应指向 latest.apk');

    const latest = await app.inject({ method: 'GET', url: '/download/latest.apk' });
    assert.equal(latest.statusCode, 302);
    assert.equal(latest.headers.location, '/download/dsh-mobile-0.1.22.apk');

    const file = await app.inject({ method: 'GET', url: '/download/dsh-mobile-0.1.22.apk' });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(file.headers['content-length'], String(2 * 1024 * 1024));
    assert.match(file.headers['content-disposition'] ?? '', /attachment; filename="dsh-mobile-0\.1\.22\.apk"/);
    assert.equal(file.rawPayload.length, 2 * 1024 * 1024);

    const older = await app.inject({ method: 'GET', url: '/download/dsh-mobile-0.1.9.apk' });
    assert.equal(older.statusCode, 200);
  } finally {
    await app.close();
    await rm(apkDir, { recursive: true, force: true });
  }
});

test('目录不存在时页面降级为“暂未上传”，latest.apk 返回 404', async () => {
  const app = await createApp(join(tmpdir(), 'dsh-apk-missing-does-not-exist'));
  try {
    const page = await app.inject({ method: 'GET', url: '/download' });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('安装包尚未上传'));
    assert.ok(!page.body.includes('<a class="button"'));

    const latest = await app.inject({ method: 'GET', url: '/download/latest.apk' });
    assert.equal(latest.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('只有测试包时兜底展示测试包', async () => {
  const apkDir = await createApkDir({ 'dsh-mobile-0.1.22-test.apk': 512 });
  const app = await createApp(apkDir);
  try {
    const latest = await app.inject({ method: 'GET', url: '/download/latest.apk' });
    assert.equal(latest.statusCode, 302);
    assert.equal(latest.headers.location, '/download/dsh-mobile-0.1.22-test.apk');
  } finally {
    await app.close();
    await rm(apkDir, { recursive: true, force: true });
  }
});

test('拒绝目录穿越与非 apk 文件名', async () => {
  const apkDir = await createApkDir({ 'dsh-mobile-0.1.22.apk': 16 });
  const app = await createApp(apkDir);
  try {
    for (const url of [
      '/download/..%2F..%2Fsecret.apk',
      '/download/secret.apk',
      '/download/dsh-mobile-0.1.22.txt',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, `应拒绝：${url}`);
    }
  } finally {
    await app.close();
    await rm(apkDir, { recursive: true, force: true });
  }
});
