import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { requestTunnelTicket } from '../src/auth.js';

describe('隧道票据请求', () => {
  test('带 deviceId 时请求体包含 deviceId（网页会话也能签发票据）', async () => {
    const captured: { url: string; body: string } = { url: '', body: '' };
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      captured.url = String(input);
      captured.body = String(init?.body ?? '');
      return new Response(JSON.stringify({ ticket: 'tk_test', expiresIn: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const ticket = await requestTunnelTicket('https://example.com', 'access-token', fetchImpl, 'device-1');
    assert.equal(ticket, 'tk_test');
    assert.equal(captured.url, 'https://example.com/v1/tunnel/ticket');
    assert.deepEqual(JSON.parse(captured.body), { deviceId: 'device-1' });
  });

  test('没有 deviceId 时请求体为空对象（设备会话保持旧行为）', async () => {
    let body = '';
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({ ticket: 'tk_test', expiresIn: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await requestTunnelTicket('https://example.com', 'access-token', fetchImpl);
    assert.deepEqual(JSON.parse(body), {});
  });
});
