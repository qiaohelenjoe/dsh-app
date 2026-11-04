/**
 * wsdata 分片与重组（隧道协议 v2）。
 *
 * 分片帧在原有字段上追加：
 *   mid   —— 消息 id（同一通道并发多条消息时用于区分）
 *   seq   —— 分片序号（0 起）
 *   total —— 分片总数
 *   more  —— 是否还有后续分片（最后一片为 false）
 *
 * 未携带 mid 的 wsdata 视为完整消息，保持 v1 行为。
 *
 * 注意：plugin/src/ws-fragment.ts 有同构实现（插件发布产物不能依赖 server 包），
 * 两侧协议字段/限制需要同步修改。
 */
import {
  DEFAULT_MAX_PENDING_WS_MESSAGES,
  DEFAULT_MAX_WS_FRAGMENTS,
  DEFAULT_WS_CHUNK_BYTES,
  DEFAULT_WS_MAX_BUFFERED_BYTES,
  DEFAULT_WS_MAX_MESSAGE_BYTES,
  DEFAULT_WS_REASSEMBLY_TIMEOUT_MS,
  type WsDataFrame,
} from './protocol.js';

export type WsFragmentDropReason = 'timeout' | 'too_large' | 'too_many_pending' | 'invalid';

export interface WsFragmentDrop {
  channelId: string;
  messageId: string;
  reason: WsFragmentDropReason;
}

export interface WsFragmentReassemblerOptions {
  /** 单条消息重组后的最大字节数，默认 64 MiB。 */
  maxMessageBytes?: number;
  /** 半成品消息超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 单连接同时重组中的消息数上限，默认 64。 */
  maxPendingMessages?: number;
  /** 单条消息的最大分片数，默认 4096。 */
  maxFragments?: number;
  /** 单连接半成品总字节上限，默认 128 MiB。 */
  maxBufferedBytes?: number;
  /** 丢弃半成品时回调（超时清理 / 超限 / 非法）。 */
  onDrop?: (drop: WsFragmentDrop) => void;
}

export type WsReassemblyResult =
  | { status: 'complete'; data: Buffer; binary: boolean }
  | { status: 'pending' }
  | { status: 'rejected'; reason: WsFragmentDropReason };

export interface FragmentWsDataInput {
  channelId: string;
  messageId: string;
  data: Buffer;
  binary: boolean;
  chunkBytes?: number;
}

interface PendingMessage {
  channelId: string;
  messageId: string;
  total: number | null;
  expectedTotal: number | null;
  binary: boolean;
  chunks: Map<number, Buffer>;
  bytes: number;
  timer: NodeJS.Timeout | null;
}

/**
 * 把一条完整 WS 消息切成 wsdata 帧。
 * 未超过 chunkBytes 时只输出一个不含分片字段的帧（与 v1 完全一致）。
 */
export function* fragmentWsData(input: FragmentWsDataInput): Generator<WsDataFrame, void, unknown> {
  const chunkBytes = Math.max(1, Math.floor(input.chunkBytes ?? DEFAULT_WS_CHUNK_BYTES));
  const { channelId, messageId, data, binary } = input;
  if (data.length <= chunkBytes) {
    yield { t: 'wsdata', id: channelId, data: data.toString('base64'), binary };
    return;
  }

  const total = Math.ceil(data.length / chunkBytes);
  for (let seq = 0; seq < total; seq += 1) {
    const start = seq * chunkBytes;
    yield {
      t: 'wsdata',
      id: channelId,
      data: data.subarray(start, start + chunkBytes).toString('base64'),
      binary,
      mid: messageId,
      seq,
      total,
      more: seq < total - 1,
    };
  }
}

/** 按 (通道 id, mid) 并发重组的接收端状态机。 */
export class WsFragmentReassembler {
  private readonly maxMessageBytes: number;
  private readonly timeoutMs: number;
  private readonly maxPendingMessages: number;
  private readonly maxFragments: number;
  private readonly maxBufferedBytes: number;
  private readonly onDrop: ((drop: WsFragmentDrop) => void) | undefined;
  private readonly pending = new Map<string, PendingMessage>();
  private bytes = 0;

  constructor(options: WsFragmentReassemblerOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WS_REASSEMBLY_TIMEOUT_MS;
    this.maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_WS_MESSAGES;
    this.maxFragments = options.maxFragments ?? DEFAULT_MAX_WS_FRAGMENTS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? Math.max(this.maxMessageBytes, DEFAULT_WS_MAX_BUFFERED_BYTES);
    this.onDrop = options.onDrop;
  }

  /** 当前重组中的消息数（测试/观测用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 当前已缓存的半成品字节数（测试/观测用）。 */
  get bufferedBytes(): number {
    return this.bytes;
  }

  accept(channelId: string, frame: WsDataFrame): WsReassemblyResult {
    if (typeof frame.data !== 'string') return { status: 'rejected', reason: 'invalid' };

    const mid = frame.mid;
    // 未分片：与 v1 相同，一帧一条完整消息（同样受单条消息上限约束）。
    if (mid === undefined) {
      const data = Buffer.from(frame.data, 'base64');
      if (data.length > this.maxMessageBytes) return { status: 'rejected', reason: 'too_large' };
      return { status: 'complete', data, binary: frame.binary === true };
    }
    if (typeof mid !== 'string' || mid.length === 0 || mid.length > 200) {
      return { status: 'rejected', reason: 'invalid' };
    }

    const seq = frame.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      return { status: 'rejected', reason: 'invalid' };
    }

    const total = frame.total;
    if (total !== undefined) {
      if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0 || seq >= total) {
        return { status: 'rejected', reason: 'invalid' };
      }
      if (total > this.maxFragments) {
        this.report({ channelId, messageId: mid, reason: 'too_large' });
        return { status: 'rejected', reason: 'too_large' };
      }
    }

    const more = frame.more;
    if (more !== undefined && typeof more !== 'boolean') {
      return { status: 'rejected', reason: 'invalid' };
    }

    const chunk = Buffer.from(frame.data, 'base64');
    const key = `${channelId}\u0000${mid}`;
    let current = this.pending.get(key);

    if (!current) {
      if (this.pending.size >= this.maxPendingMessages) {
        this.report({ channelId, messageId: mid, reason: 'too_many_pending' });
        return { status: 'rejected', reason: 'too_many_pending' };
      }
      const created: PendingMessage = {
        channelId,
        messageId: mid,
        total: total ?? null,
        expectedTotal: more === false ? seq + 1 : null,
        binary: frame.binary === true,
        chunks: new Map(),
        bytes: 0,
        timer: null,
      };
      this.pending.set(key, created);
      created.timer = setTimeout(() => {
        if (this.pending.get(key) !== created) return;
        this.discard(key, created, 'timeout');
      }, this.timeoutMs);
      created.timer.unref?.();
      current = created;
    }

    if (total !== undefined) {
      if (current.total === null) current.total = total;
      else if (current.total !== total) return this.reject(key, current, 'invalid');
    }
    if (more === false) {
      const implied = seq + 1;
      if (current.expectedTotal === null) current.expectedTotal = implied;
      else if (current.expectedTotal !== implied) return this.reject(key, current, 'invalid');
    }
    if (current.total !== null && current.expectedTotal !== null && current.total !== current.expectedTotal) {
      return this.reject(key, current, 'invalid');
    }

    // 重复分片直接忽略（弱网/重发不应让重组失败）。
    if (current.chunks.has(seq)) return { status: 'pending' };

    // 没有 total 时按已收到的分片数兜底，防止零字节分片无限占用内存。
    if (current.chunks.size >= this.maxFragments) {
      return this.reject(key, current, 'too_large');
    }

    if (current.bytes + chunk.length > this.maxMessageBytes) {
      return this.reject(key, current, 'too_large');
    }
    if (this.bytes + chunk.length > this.maxBufferedBytes) {
      return this.reject(key, current, 'too_large');
    }

    current.chunks.set(seq, chunk);
    current.bytes += chunk.length;
    this.bytes += chunk.length;

    const completeTotal = current.total ?? current.expectedTotal;
    if (completeTotal !== null && current.chunks.size === completeTotal) {
      const data = this.assemble(current, completeTotal);
      if (data) {
        const binary = current.binary;
        this.discardSilently(key, current);
        return { status: 'complete', data, binary };
      }
    }
    return { status: 'pending' };
  }

  /** 通道关闭时丢弃该通道下所有半成品。 */
  dropChannel(channelId: string): void {
    for (const [key, pending] of [...this.pending]) {
      if (pending.channelId === channelId) this.discardSilently(key, pending);
    }
  }

  /** 连接关闭时清理全部状态。 */
  reset(): void {
    for (const [key, pending] of [...this.pending]) {
      this.discardSilently(key, pending);
    }
    this.bytes = 0;
  }

  private assemble(pending: PendingMessage, total: number): Buffer | null {
    const parts: Buffer[] = [];
    for (let index = 0; index < total; index += 1) {
      const part = pending.chunks.get(index);
      if (!part) return null;
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  private reject(key: string, pending: PendingMessage, reason: WsFragmentDropReason): WsReassemblyResult {
    this.discard(key, pending, reason);
    return { status: 'rejected', reason };
  }

  private discard(key: string, pending: PendingMessage, reason: WsFragmentDropReason): void {
    this.discardSilently(key, pending);
    this.report({ channelId: pending.channelId, messageId: pending.messageId, reason });
  }

  private discardSilently(key: string, pending: PendingMessage): void {
    if (this.pending.get(key) !== pending) return;
    this.pending.delete(key);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.bytes -= pending.bytes;
  }

  private report(drop: WsFragmentDrop): void {
    if (!this.onDrop) return;
    try {
      this.onDrop(drop);
    } catch {
      // 清理回调异常不能影响帧处理
    }
  }
}
