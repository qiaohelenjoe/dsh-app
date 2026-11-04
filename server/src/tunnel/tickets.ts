import { createHash, randomBytes } from 'node:crypto';

/** 票据绑定的身份：账号 + 会话 + 设备（规格 §11）。 */
export interface TunnelTicketIdentity {
  accountId: string;
  sessionId: string;
  deviceId: string;
}

export interface IssuedTunnelTicket {
  ticket: string;
  expiresIn: number;
}

interface TicketRecord extends TunnelTicketIdentity {
  expiresAt: number;
}

export const TUNNEL_TICKET_PREFIX = 'tk_';
/** 一次性票据默认有效期：60 秒。 */
export const DEFAULT_TUNNEL_TICKET_TTL_MS = 60_000;

export function hashTunnelTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}

/**
 * 隧道一次性票据存储（规格 §11）：32 字节随机票据，内存 Map 只保存 sha256，
 * 消费即删、默认 60 秒过期（过期项在签发/消费时惰性清理）。
 *
 * 单实例内存实现（规格 §12 允许）：进程重启或多实例部署时票据不共享，
 * 客户端重连会重新申请票据，因此不影响重连语义。票据明文不落库、不写日志。
 */
export class TunnelTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TUNNEL_TICKET_TTL_MS;
  }

  /** 票据有效期的秒数（用于 `expiresIn` 响应字段）；默认 60。 */
  get ttlSeconds(): number {
    return Math.ceil(this.ttlMs / 1000);
  }

  /** 当前未过期票据数量（测试/观测用）。 */
  get size(): number {
    this.prune();
    return this.tickets.size;
  }

  issue(identity: TunnelTicketIdentity): IssuedTunnelTicket {
    this.prune();
    const ticket = `${TUNNEL_TICKET_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.tickets.set(hashTunnelTicket(ticket), {
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      deviceId: identity.deviceId,
      expiresAt: Date.now() + this.ttlMs,
    });
    return { ticket, expiresIn: this.ttlSeconds };
  }

  /** 消费票据：成功返回绑定身份并立即失效；无效/过期/已用返回 null。 */
  consume(ticket: string): TunnelTicketIdentity | null {
    if (!ticket.startsWith(TUNNEL_TICKET_PREFIX)) return null;
    this.prune();
    const key = hashTunnelTicket(ticket);
    const record = this.tickets.get(key);
    if (!record) return null;
    this.tickets.delete(key);
    return { accountId: record.accountId, sessionId: record.sessionId, deviceId: record.deviceId };
  }

  clear(): void {
    this.tickets.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(key);
    }
  }
}
