import { WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';
import { DEFAULT_WS_CHUNK_BYTES, DEFAULT_WS_MAX_MESSAGE_BYTES, DEFAULT_WS_REASSEMBLY_TIMEOUT_MS, DEFAULT_MAX_PENDING_WS_MESSAGES, WS_FRAGMENT_PROTOCOL_VERSION, WsFragmentReassembler, fragmentWsData, } from './ws-fragment.js';
/** 桌面端当前实现的隧道协议版本（v2：wsdata 分片）。 */
const TUNNEL_PROTOCOL_VERSION = 2;
/**
 * 桌面端隧道客户端：出站 WSS、register 握手、心跳、req/res 转发、
 * wsopen/wsdata/wsclose 双向代理、指数退避重连（封顶 10 秒、带抖动）。
 */
export class TunnelClient {
    options;
    socket = null;
    stopped = false;
    online = false;
    attempts = 0;
    reconnectTimer = null;
    connectTimer = null;
    keepaliveTimer = null;
    networkTimer = null;
    status = 'stopped';
    channels = new Map();
    backoffBaseMs;
    backoffMaxMs;
    connectTimeoutMs;
    keepaliveMs;
    deadAfterMs;
    deadAfterConfigured;
    networkWatchMs;
    chunkBytes;
    wsMessageMaxBytes;
    reassembler;
    /** 协商后的协议版本：连接旧服务端（4006）时回落到 v1，关闭分片。 */
    protocolVersion = TUNNEL_PROTOCOL_VERSION;
    messageCounter = 0;
    /** 每次建链自增，用于丢弃旧 socket 的迟到事件。 */
    connectGeneration = 0;
    lastInboundAt = 0;
    lastFrameAt = 0;
    lastConnectedAt = 0;
    lastError = null;
    lastNetworkSignature = '';
    constructor(options) {
        this.options = options;
        this.backoffBaseMs = options.backoffBaseMs ?? 1000;
        this.backoffMaxMs = options.backoffMaxMs ?? 10_000;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
        this.keepaliveMs = options.keepaliveMs ?? 25_000;
        this.deadAfterMs = options.deadAfterMs ?? 75_000;
        this.deadAfterConfigured = options.deadAfterMs !== undefined;
        this.networkWatchMs = options.networkWatchMs ?? 10_000;
        this.chunkBytes = options.chunkBytes ?? DEFAULT_WS_CHUNK_BYTES;
        this.wsMessageMaxBytes = options.wsMessageMaxBytes ?? DEFAULT_WS_MAX_MESSAGE_BYTES;
        this.reassembler = new WsFragmentReassembler({
            maxMessageBytes: this.wsMessageMaxBytes,
            timeoutMs: options.wsFragmentTimeoutMs ?? DEFAULT_WS_REASSEMBLY_TIMEOUT_MS,
            maxPendingMessages: options.wsMaxPendingMessages ?? DEFAULT_MAX_PENDING_WS_MESSAGES,
            onDrop: (drop) => this.handleFragmentDrop(drop),
        });
    }
    get isOnline() {
        return this.online;
    }
    /** 诊断快照（供宿主只读接口 / 状态卡片使用）。 */
    getDiagnostics() {
        return {
            status: this.status,
            online: this.online,
            attempts: this.attempts,
            protocolVersion: this.protocolVersion,
            deviceId: this.options.deviceId,
            serverBaseUrl: this.options.serverBaseUrl,
            lastConnectedAt: this.lastConnectedAt ? new Date(this.lastConnectedAt).toISOString() : null,
            lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
            lastError: this.lastError,
            connectTimeoutMs: this.connectTimeoutMs,
            keepaliveMs: this.keepaliveMs,
            deadAfterMs: this.deadAfterMs,
            backoffMaxMs: this.backoffMaxMs,
        };
    }
    start() {
        this.stopped = false;
        this.startNetworkWatch();
        this.connect();
    }
    stop(reason = 'plugin-stop') {
        this.stopped = true;
        this.online = false;
        this.stopReconnectTimer();
        this.clearConnectTimer();
        this.stopKeepalive();
        this.stopNetworkWatch();
        for (const channel of this.channels.values())
            channel.close(1001, reason);
        this.channels.clear();
        this.reassembler.reset();
        try {
            this.socket?.close(1000, reason);
        }
        catch {
            // 忽略
        }
        this.socket = null;
        this.setStatus('stopped');
    }
    /** 主动告知服务端下线（登出 / 退出前）。 */
    sendOfflineAndStop() {
        try {
            this.socket?.send(JSON.stringify({ t: 'offline' }));
        }
        catch {
            // 忽略
        }
        this.stop('offline');
    }
    setStatus(status, detail) {
        if (this.status === status)
            return;
        this.status = status;
        this.options.onStatusChange?.(status, detail);
    }
    log(message) {
        this.options.log?.(`[tunnel] ${message}`);
    }
    wsUrl(ticket) {
        const base = this.options.serverBaseUrl.replace(/\/$/, '');
        const url = `${base.replace(/^http/, 'ws')}/v1/tunnel`;
        return ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url;
    }
    async connect() {
        if (this.stopped)
            return;
        const generation = ++this.connectGeneration;
        this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
        let token = await this.options.getAccessToken().catch(() => null);
        if (!token)
            token = await this.options.refreshAccessToken().catch(() => null);
        if (!token) {
            this.log('没有可用的 access token，稍后重试');
            this.scheduleReconnect('no-token');
            return;
        }
        // 票据一次性（R06）：每次建链前重新申请；申请失败时刷新令牌再试一次
        let ticket = null;
        if (this.options.getTunnelTicket) {
            ticket = await this.options.getTunnelTicket(token).catch(() => null);
            if (!ticket) {
                const refreshed = await this.options.refreshAccessToken().catch(() => null);
                if (refreshed)
                    ticket = await this.options.getTunnelTicket(refreshed).catch(() => null);
            }
            if (!ticket) {
                this.log('申请隧道票据失败，稍后重试');
                this.scheduleReconnect('no-ticket');
                return;
            }
        }
        if (this.stopped || generation !== this.connectGeneration)
            return;
        // 分片帧大小 = base64(chunkBytes) + JSON 头；按配置留足余量，默认仍远小于 2 MiB。
        const frameBudget = Math.ceil((this.chunkBytes * 4) / 3) + 64 * 1024;
        const socket = new WebSocket(this.wsUrl(ticket), {
            ...(ticket ? {} : { headers: { authorization: `Bearer ${token}` } }),
            maxPayload: Math.max(2 * 1024 * 1024, frameBudget),
        });
        this.socket = socket;
        // 连接超时：握手/注册迟迟不完成（弱网、NAT 黑洞）时强制重建，避免永远卡在 connecting
        const timer = setTimeout(() => {
            if (generation !== this.connectGeneration)
                return;
            this.log(`连接超时（${this.connectTimeoutMs}ms 未完成注册），强制重建`);
            this.hardReconnect(socket, generation, 'connect-timeout');
        }, this.connectTimeoutMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.connectTimer = timer;
        socket.on('open', () => {
            if (generation !== this.connectGeneration)
                return;
            this.log(`已连接，发送 register（protocol=${this.protocolVersion}）`);
            socket.send(JSON.stringify({ t: 'register', deviceId: this.options.deviceId, protocol: this.protocolVersion }));
        });
        socket.on('message', (data) => {
            if (generation !== this.connectGeneration)
                return;
            const now = Date.now();
            this.lastInboundAt = now;
            this.lastFrameAt = now;
            void this.handleFrame(data.toString());
        });
        socket.on('unexpected-response', (_request, response) => {
            if (generation !== this.connectGeneration)
                return;
            this.clearConnectTimer();
            response.resume();
            if (response.statusCode === 401) {
                this.log('隧道鉴权失败（401），重新申请票据后重连');
                void (async () => {
                    const refreshed = await this.options.refreshAccessToken().catch(() => null);
                    // 票据模式下即使刷新失败也应重试（可能只是票据过期/已消费）
                    if (refreshed || this.options.getTunnelTicket) {
                        this.scheduleReconnect('auth-refreshed', 0);
                    }
                    else {
                        this.setStatus('fatal', 'unauthorized');
                    }
                })();
                return;
            }
            this.scheduleReconnect(`http-${response.statusCode}`);
        });
        socket.on('close', (code, reason) => {
            if (generation !== this.connectGeneration)
                return;
            this.clearConnectTimer();
            this.stopKeepalive();
            this.online = false;
            this.reassembler.reset();
            for (const channel of this.channels.values())
                channel.close(1001, 'tunnel-closed');
            this.channels.clear();
            // 旧服务端只接受 protocol=1：回落一次，关闭 wsdata 分片（大帧仍受对端限制）。
            if (code === 4006 && this.protocolVersion >= WS_FRAGMENT_PROTOCOL_VERSION) {
                this.log('服务端不支持隧道协议 v2，回落到 v1（wsdata 分片不可用）');
                this.protocolVersion = 1;
                this.scheduleReconnect('protocol-downgrade', 0);
                return;
            }
            if (code === 4000) {
                // 被新连接踢掉 / 设备被撤销：停止重连，等待重新登录
                this.log(`隧道被服务端关闭（${reason.toString() || code}），停止重连`);
                this.setStatus('fatal', reason.toString() || 'replaced');
                this.stop('closed-by-server');
                return;
            }
            if (this.stopped)
                return;
            this.scheduleReconnect(`close-${code}`);
        });
        socket.on('error', (error) => {
            this.lastError = `socket-error: ${error.message}`;
            // 交给 close 处理
        });
    }
    /** 丢弃当前 socket 并立即重连（连接超时、死连接、网络变化时用）。 */
    hardReconnect(socket, generation, reason) {
        if (generation !== this.connectGeneration)
            return;
        this.lastError = reason;
        this.clearConnectTimer();
        this.stopKeepalive();
        this.online = false;
        this.connectGeneration += 1;
        try {
            socket?.terminate();
        }
        catch {
            // 忽略
        }
        this.socket = null;
        if (this.stopped)
            return;
        this.scheduleReconnect(reason, 0);
    }
    clearConnectTimer() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }
    stopReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    /** 客户端保活：定期 ping，并在长时间无入站数据时判定连接已死。 */
    startKeepalive() {
        this.stopKeepalive();
        this.lastInboundAt = Date.now();
        const timer = setInterval(() => this.checkKeepalive(), this.keepaliveMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.keepaliveTimer = timer;
    }
    stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }
    checkKeepalive() {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN || !this.online)
            return;
        if (this.deadAfterMs > 0 && Date.now() - this.lastInboundAt > this.deadAfterMs) {
            this.log(`超过 ${this.deadAfterMs}ms 未收到任何数据，判定连接已死，强制重连`);
            this.hardReconnect(socket, this.connectGeneration, 'keepalive-timeout');
            return;
        }
        try {
            socket.send(JSON.stringify({ t: 'ping' }));
        }
        catch (error) {
            this.lastError = `ping-failed: ${error.message}`;
            this.hardReconnect(socket, this.connectGeneration, 'ping-send-failed');
        }
    }
    /** 网卡地址变化（切 Wi-Fi、插拔网线、VPN 起停、休眠唤醒）时立即重连。 */
    startNetworkWatch() {
        if (this.networkTimer)
            return;
        this.lastNetworkSignature = this.networkSignature();
        const timer = setInterval(() => {
            const signature = this.networkSignature();
            if (signature === this.lastNetworkSignature)
                return;
            this.lastNetworkSignature = signature;
            this.log('检测到网络变化，立即重连');
            this.attempts = 0;
            const socket = this.socket;
            if (!socket) {
                this.stopReconnectTimer();
                void this.connect();
                return;
            }
            this.hardReconnect(socket, this.connectGeneration, 'network-changed');
        }, this.networkWatchMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.networkTimer = timer;
    }
    stopNetworkWatch() {
        if (this.networkTimer) {
            clearInterval(this.networkTimer);
            this.networkTimer = null;
        }
    }
    networkSignature() {
        const addresses = this.options.listNetworkAddresses
            ? this.options.listNetworkAddresses()
            : defaultNetworkAddresses();
        return addresses.slice().sort().join(',');
    }
    scheduleReconnect(reason, overrideDelayMs) {
        if (this.stopped || this.reconnectTimer)
            return;
        this.online = false;
        this.lastError = reason;
        // 抖动：避免多台设备在同一时刻集中重连
        const base = overrideDelayMs ??
            Math.min(this.backoffMaxMs, this.backoffBaseMs * Math.pow(2, Math.min(this.attempts, 10)));
        const jitter = overrideDelayMs === undefined ? 0.7 + Math.random() * 0.6 : 1;
        const delay = Math.max(0, Math.round(base * jitter));
        this.attempts += 1;
        this.log(`将在 ${delay}ms 后重连（${reason}）`);
        this.setStatus('reconnecting', reason);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }
    async handleFrame(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        }
        catch {
            return;
        }
        switch (frame.t) {
            case 'registered': {
                this.clearConnectTimer();
                this.online = true;
                this.attempts = 0;
                this.lastConnectedAt = Date.now();
                this.lastInboundAt = Date.now();
                const heartbeatSec = typeof frame['heartbeatSec'] === 'number' ? frame['heartbeatSec'] : null;
                if (heartbeatSec && heartbeatSec > 0 && !this.deadAfterConfigured) {
                    // 未显式配置时，死连接阈值取心跳间隔的 3 倍（不低于默认 75 秒的语义）
                    this.deadAfterMs = Math.max(this.deadAfterMs, heartbeatSec * 1000 * 3);
                }
                this.startKeepalive();
                this.setStatus('online');
                this.log('隧道已上线');
                break;
            }
            case 'ping':
                this.socket?.send(JSON.stringify({ t: 'pong' }));
                break;
            case 'req':
                await this.handleRequest(frame);
                break;
            case 'wsopen':
                await this.handleWsOpen(frame);
                break;
            case 'wsdata': {
                const id = frame['id'];
                const channel = this.channels.get(id);
                if (!channel)
                    break;
                const result = this.reassembler.accept(id, frame);
                if (result.status === 'complete') {
                    channel.send(result.data, result.binary);
                }
                else if (result.status === 'rejected') {
                    this.log(`wsdata 分片重组失败（${result.reason}），关闭通道 ${id}`);
                    this.reassembler.dropChannel(id);
                    this.closeLocalChannel(id, result.reason === 'invalid' ? 1002 : 1009, `wsdata ${result.reason}`);
                }
                break;
            }
            case 'wsclose': {
                const id = frame['id'];
                const channel = this.channels.get(id);
                if (channel)
                    channel.close(frame['code'] ?? 1000, frame['reason'] ?? '');
                this.channels.delete(id);
                this.reassembler.dropChannel(id);
                break;
            }
            default:
                break;
        }
    }
    async handleRequest(frame) {
        let result;
        try {
            result = await this.options.forwardLocalRequest({
                method: frame.method,
                path: frame.path,
                headers: frame.headers ?? {},
                body: frame.body ? Buffer.from(frame.body, 'base64') : null,
            });
        }
        catch (error) {
            result = {
                status: 502,
                headers: { 'content-type': 'text/plain; charset=utf-8' },
                body: Buffer.from(`local forward error: ${error.message}${error?.cause ? " / " + String(error.cause) : ""}`),
            };
        }
        this.sendResponse(frame.id, result);
    }
    sendResponse(id, result) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return;
        const body = result.body ?? Buffer.alloc(0);
        if (body.length <= this.chunkBytes) {
            socket.send(JSON.stringify({
                t: 'res',
                id,
                status: result.status,
                headers: result.headers,
                body: body.toString('base64'),
                more: false,
            }));
            return;
        }
        for (let offset = 0; offset < body.length; offset += this.chunkBytes) {
            const chunk = body.subarray(offset, offset + this.chunkBytes);
            const isLast = offset + this.chunkBytes >= body.length;
            socket.send(JSON.stringify({
                t: 'res',
                id,
                status: result.status,
                headers: result.headers,
                body: chunk.toString('base64'),
                more: !isLast,
            }));
        }
    }
    async handleWsOpen(frame) {
        try {
            const channel = await this.options.openLocalWebSocket({
                path: frame.path,
                headers: frame.headers ?? {},
                onMessage: (data, binary) => {
                    this.sendWsMessage(frame.id, data, binary);
                },
                onClose: (code, reason) => {
                    this.channels.delete(frame.id);
                    this.reassembler.dropChannel(frame.id);
                    this.socket?.send(JSON.stringify({ t: 'wsclose', id: frame.id, code, reason }));
                },
            });
            this.channels.set(frame.id, channel);
            this.socket?.send(JSON.stringify({ t: 'wsopen', id: frame.id, ok: true }));
        }
        catch (error) {
            this.socket?.send(JSON.stringify({
                t: 'wsopen',
                id: frame.id,
                ok: false,
                status: 502,
                reason: error.message,
            }));
        }
    }
    /** 本机 DSH → 服务端：按协商版本切分大消息（v1 服务端保持单帧旧行为）。 */
    sendWsMessage(channelId, data, binary) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN)
            return;
        if (data.length > this.wsMessageMaxBytes) {
            this.log(`WS 消息超过上限（${data.length} > ${this.wsMessageMaxBytes}），关闭通道 ${channelId}`);
            this.closeLocalChannel(channelId, 1009, 'message too large');
            return;
        }
        try {
            if (this.protocolVersion >= WS_FRAGMENT_PROTOCOL_VERSION) {
                const messageId = `m_${++this.messageCounter}`;
                for (const frame of fragmentWsData({
                    channelId,
                    messageId,
                    data,
                    binary,
                    chunkBytes: this.chunkBytes,
                })) {
                    socket.send(JSON.stringify(frame));
                }
            }
            else {
                socket.send(JSON.stringify({ t: 'wsdata', id: channelId, data: data.toString('base64'), binary }));
            }
        }
        catch {
            this.closeLocalChannel(channelId, 1011, 'send-failed');
        }
    }
    handleFragmentDrop(drop) {
        if (drop.reason !== 'timeout')
            return;
        this.log(`wsdata 分片重组超时，关闭通道 ${drop.channelId}`);
        this.closeLocalChannel(drop.channelId, 1009, 'ws fragment timeout');
    }
    closeLocalChannel(channelId, code, reason) {
        const channel = this.channels.get(channelId);
        if (!channel)
            return;
        try {
            channel.close(code, reason);
        }
        catch {
            // 忽略已关闭连接；onClose 会向服务端发 wsclose
        }
    }
}
/** 非回环网卡地址集合：用于检测 Wi-Fi/有线的切换与断开。 */
function defaultNetworkAddresses() {
    const result = [];
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const info of interfaces[name] ?? []) {
            if (info.internal)
                continue;
            if (!info.address)
                continue;
            result.push(`${name}:${info.address}`);
        }
    }
    return result;
}
//# sourceMappingURL=tunnel.js.map