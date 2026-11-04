import type { FastifyInstance } from 'fastify';
import { authHeader, type AccountSession } from './auth.js';

/** 通过 HTTP 接口申请一次性隧道票据（R06：/v1/tunnel 升级必须携带票据）。 */
export async function issueTunnelTicket(app: FastifyInstance, session: AccountSession): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tunnel/ticket',
    headers: authHeader(session),
  });
  if (response.statusCode !== 200) {
    throw new Error(`申请隧道票据失败（${response.statusCode}）：${response.body}`);
  }
  const body = response.json() as { ticket?: string; expiresIn?: number };
  if (!body.ticket) throw new Error('申请隧道票据失败：响应缺少 ticket');
  return body.ticket;
}

/** 携带票据的隧道升级 URL（测试用 ws://，生产为 wss://）。 */
export function tunnelSocketUrl(port: number, ticket: string): string {
  return `ws://127.0.0.1:${port}/v1/tunnel?ticket=${encodeURIComponent(ticket)}`;
}
