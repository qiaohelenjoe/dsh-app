import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewriteHtml } from '../src/http/proxy.js';

const PAGE = '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>';

test('/t/<id> 模式：注入的 Remote mux 基址是绝对 URL（含设备前缀）', () => {
  const out = rewriteHtml(PAGE, '/t/abc-123');
  assert.match(out, /window\.__DSH_TRANSPORT__/);
  // 必须是 location.origin + 路径：相对路径会让 new URL(...) 抛 Invalid URL
  assert.match(out, /t\.streamBaseUrl=location\.origin\+"\/t\/abc-123\/"/);
  assert.ok(!/streamBaseUrl="\/t\/abc-123\/"/.test(out), '不能注入相对路径基址');
  // 仍然注入 WebView polyfill
  assert.match(out, /Promise\.withResolvers/);
});

test('/t/<id> 模式：base href 仍保持根路径（DSH 前端按根路径拼 HTTP 请求）', () => {
  const out = rewriteHtml('<html><head><base href="/x/"></head></html>', '/t/abc-123');
  assert.match(out, /<base href="\/">/);
});

test('根路径模式：基址为 location.origin + /', () => {
  const out = rewriteHtml(PAGE, '');
  assert.match(out, /t\.streamBaseUrl=location\.origin\+"\/"/);
});

test('前缀末尾带斜杠时 streamBaseUrl 不会出现双斜杠', () => {
  const out = rewriteHtml(PAGE, '/t/abc-123/');
  assert.match(out, /t\.streamBaseUrl=location\.origin\+"\/t\/abc-123\/"/);
  assert.ok(!out.includes('location.origin+"/t/abc-123//"'));
});
