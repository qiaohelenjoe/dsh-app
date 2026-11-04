/**
 * 假隧道客户端（开发/联调用）：
 *   node --import tsx scripts/fake-tunnel.ts <baseUrl> <accessToken> <deviceId> [targetBaseUrl]
 *
 * 连接 /v1/tunnel → register → 收到 req 时：
 *   - 提供 targetBaseUrl 时转发到该地址（用于模拟桌面端本地 DSH）
 *   - 否则回显一个 200 空响应
 * 超过 256 KiB 的响应按 more 分块发送。
 */
import { WebSocket } from 'ws';

const [baseUrl, accessToken, deviceId, targetBaseUrl] = process.argv.slice(2);
if (!baseUrl || !accessToken || !deviceId) {
  console.error('用法: node --import tsx scripts/fake-tunnel.ts <baseUrl> <accessToken> <deviceId> [targetBaseUrl]');
  process.exit(2);
}

const CHUNK_BYTES = 256 * 1024;

const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/tunnel`, {
  headers: { authorization: `Bearer ${accessToken}` },
});

function send(frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame));
}

async function handleRequest(frame: {
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
}): Promise<void> {
  const requestBody = frame.body ? Buffer.from(frame.body, 'base64') : null;
  let status = 200;
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  let body = Buffer.from(JSON.stringify({ ok: true, path: frame.path }));

  if (targetBaseUrl) {
    try {
      const response = await fetch(`${targetBaseUrl.replace(/\/$/, '')}${frame.path}`, {
        method: frame.method,
        headers: frame.headers,
        body: requestBody && requestBody.length > 0 ? requestBody : undefined,
      });
      status = response.status;
      headers = Object.fromEntries(response.headers.entries());
      body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      status = 502;
      headers = { 'content-type': 'text/plain; charset=utf-8' };
      body = Buffer.from(`fake-tunnel upstream error: ${(error as Error).message}`);
    }
  }

  if (body.length <= CHUNK_BYTES) {
    send({ t: 'res', id: frame.id, status, headers, body: body.toString('base64'), more: false });
    return;
  }
  for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
    const chunk = body.subarray(offset, offset + CHUNK_BYTES);
    const isLast = offset + CHUNK_BYTES >= body.length;
    send({ t: 'res', id: frame.id, status, headers, body: chunk.toString('base64'), more: !isLast });
  }
}

socket.on('open', () => {
  console.log('[fake-tunnel] 已连接，发送 register');
  send({ t: 'register', deviceId, protocol: 1 });
});

socket.on('message', (data) => {
  const frame = JSON.parse(data.toString()) as { t: string; [key: string]: unknown };
  if (frame.t === 'registered') {
    console.log('[fake-tunnel] 已注册', JSON.stringify(frame));
    return;
  }
  if (frame.t === 'ping') {
    send({ t: 'pong' });
    return;
  }
  if (frame.t === 'req') {
    void handleRequest(
      frame as unknown as {
        id: string;
        method: string;
        path: string;
        headers?: Record<string, string>;
        body?: string | null;
      },
    ).catch((error) => {
      send({ t: 'res', id: frame['id'] as string, status: 500, body: null, more: false });
      console.error('[fake-tunnel] 处理请求失败', error);
    });
  }
});

socket.on('close', (code, reason) => {
  console.log(`[fake-tunnel] 连接关闭 code=${code} reason=${reason.toString()}`);
  process.exit(0);
});

socket.on('error', (error) => {
  console.error('[fake-tunnel] 错误', error);
  process.exit(1);
});
