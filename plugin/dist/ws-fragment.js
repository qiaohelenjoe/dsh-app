/**
 * wsdata 分片与重组（隧道协议 v2）。
 *
 * 与 server/src/tunnel/ws-fragment.ts 保持同构：插件发布产物不能依赖 server 包，
 * 因此协议字段/限制在这里再实现一份；修改时两侧需要同步。
 *
 * 分片帧在原有字段上追加：
 *   mid   —— 消息 id（同一通道并发多条消息时用于区分）
 *   seq   —— 分片序号（0 起）
 *   total —— 分片总数
 *   more  —— 是否还有后续分片（最后一片为 false）
 *
 * 未携带 mid 的 wsdata 视为完整消息，保持 v1 行为。
 */
/** 首次支持 wsdata 分片的协议版本。 */
export const WS_FRAGMENT_PROTOCOL_VERSION = 2;
/** wsdata 分片大小（base64 编码后约 350 KiB）。 */
export const DEFAULT_WS_CHUNK_BYTES = 256 * 1024;
/** 单条 WS 消息（分片重组后）上限。 */
export const DEFAULT_WS_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** 单连接同时重组的所有半成品总字节上限（多消息并发时的内存兜底）。 */
export const DEFAULT_WS_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
/** 分片重组超时。 */
export const DEFAULT_WS_REASSEMBLY_TIMEOUT_MS = 30_000;
/** 单连接同时进行的分片重组消息数上限。 */
export const DEFAULT_MAX_PENDING_WS_MESSAGES = 64;
/** 单条消息允许的最大分片数（防止零字节分片绕过字节上限撑爆内存）。 */
export const DEFAULT_MAX_WS_FRAGMENTS = 4096;
/**
 * 把一条完整 WS 消息切成 wsdata 帧。
 * 未超过 chunkBytes 时只输出一个不含分片字段的帧（与 v1 完全一致）。
 */
export function* fragmentWsData(input) {
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
    maxMessageBytes;
    timeoutMs;
    maxPendingMessages;
    maxFragments;
    maxBufferedBytes;
    onDrop;
    pending = new Map();
    bytes = 0;
    constructor(options = {}) {
        this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_WS_REASSEMBLY_TIMEOUT_MS;
        this.maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_WS_MESSAGES;
        this.maxFragments = options.maxFragments ?? DEFAULT_MAX_WS_FRAGMENTS;
        this.maxBufferedBytes = options.maxBufferedBytes ?? Math.max(this.maxMessageBytes, DEFAULT_WS_MAX_BUFFERED_BYTES);
        this.onDrop = options.onDrop;
    }
    get pendingCount() {
        return this.pending.size;
    }
    get bufferedBytes() {
        return this.bytes;
    }
    accept(channelId, frame) {
        if (typeof frame.data !== 'string')
            return { status: 'rejected', reason: 'invalid' };
        const mid = frame.mid;
        if (mid === undefined) {
            const data = Buffer.from(frame.data, 'base64');
            if (data.length > this.maxMessageBytes)
                return { status: 'rejected', reason: 'too_large' };
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
            const created = {
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
                if (this.pending.get(key) !== created)
                    return;
                this.discard(key, created, 'timeout');
            }, this.timeoutMs);
            created.timer.unref?.();
            current = created;
        }
        if (total !== undefined) {
            if (current.total === null)
                current.total = total;
            else if (current.total !== total)
                return this.reject(key, current, 'invalid');
        }
        if (more === false) {
            const implied = seq + 1;
            if (current.expectedTotal === null)
                current.expectedTotal = implied;
            else if (current.expectedTotal !== implied)
                return this.reject(key, current, 'invalid');
        }
        if (current.total !== null && current.expectedTotal !== null && current.total !== current.expectedTotal) {
            return this.reject(key, current, 'invalid');
        }
        if (current.chunks.has(seq))
            return { status: 'pending' };
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
    dropChannel(channelId) {
        for (const [key, pending] of [...this.pending]) {
            if (pending.channelId === channelId)
                this.discardSilently(key, pending);
        }
    }
    reset() {
        for (const [key, pending] of [...this.pending]) {
            this.discardSilently(key, pending);
        }
        this.bytes = 0;
    }
    assemble(pending, total) {
        const parts = [];
        for (let index = 0; index < total; index += 1) {
            const part = pending.chunks.get(index);
            if (!part)
                return null;
            parts.push(part);
        }
        return Buffer.concat(parts);
    }
    reject(key, pending, reason) {
        this.discard(key, pending, reason);
        return { status: 'rejected', reason };
    }
    discard(key, pending, reason) {
        this.discardSilently(key, pending);
        this.report({ channelId: pending.channelId, messageId: pending.messageId, reason });
    }
    discardSilently(key, pending) {
        if (this.pending.get(key) !== pending)
            return;
        this.pending.delete(key);
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }
        this.bytes -= pending.bytes;
    }
    report(drop) {
        if (!this.onDrop)
            return;
        try {
            this.onDrop(drop);
        }
        catch {
            // 清理回调异常不能影响帧处理
        }
    }
}
//# sourceMappingURL=ws-fragment.js.map