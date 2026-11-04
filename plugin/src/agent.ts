import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  loginWithDeviceCode,
  refreshTokens,
  requestTunnelTicket,
  type DeviceAuthOptions,
} from './auth.js';
import type { PluginConfig } from './config.js';
import {
  createLocalDshForwarder,
  LaunchTokenCookieProvider,
  type DshCookieProvider,
  type LocalRequestInput,
  type LocalResponseResult,
} from './dsh-credentials.js';
import type { AccountCardState } from './settings-card.js';
import type { CredentialStore, StoredCredentials } from './storage.js';
import { TunnelClient, type LocalWsHandle, type LocalWsOpenInput, type TunnelStatus } from './tunnel.js';

/** mux 连接生命周期日志路径：DSH 不落盘 `[api-gateway]` 输出，排障只能靠插件侧记录。 */
const MUX_LOG_PATH = join(tmpdir(), 'dsh-mobile-tunnel-mux.log');
const MUX_LOG_LIMIT_BYTES = 512 * 1024;

export function muxLogPath(): string {
  return MUX_LOG_PATH;
}

function muxLog(line: string): void {
  try {
    try {
      if (statSync(MUX_LOG_PATH).size > MUX_LOG_LIMIT_BYTES) writeFileSync(MUX_LOG_PATH, '');
    } catch {
      // 日志文件尚不存在
    }
    appendFileSync(MUX_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 日志写入失败不影响隧道主流程
  }
}

/** ws 的 RawData 可能是 Buffer、Buffer[] 或 ArrayBuffer，统一取字节数。 */
function rawDataSize(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

export interface TunnelAgentDeps {
  store: CredentialStore;
  authOptions?: Partial<DeviceAuthOptions> & {
    openBrowser?: (url: string) => Promise<void> | void;
    onUserCode?: (info: { userCode: string; verificationUrl: string }) => void;
  };
  cookieProvider?: DshCookieProvider;
  fetchImpl?: typeof fetch;
  onStateChange?: (state: AccountCardState) => void;
  log?: (message: string) => void;
  backoffBaseMs?: number;
}

/** 插件运行时：登录/登出、凭据恢复、隧道生命周期与状态卡片。 */
export class TunnelAgent {
  private credentials: StoredCredentials | null = null;
  private tunnel: TunnelClient | null = null;
  private state: AccountCardState;
  private stopped = false;

  constructor(
    private readonly config: PluginConfig,
    private readonly deps: TunnelAgentDeps,
  ) {
    this.state = { status: 'logged-out', deviceName: config.deviceName };
  }

  getState(): AccountCardState {
    return this.state;
  }

  get tunnelStatus(): TunnelStatus {
    return this.tunnel ? (this.tunnel.isOnline ? 'online' : 'reconnecting') : 'stopped';
  }

  /** 冷启动：有本地凭据则静默恢复隧道（spec §6.3）。 */
  async autostart(): Promise<void> {
    const stored = await this.deps.store.load();
    if (!stored) {
      this.setState({ status: 'logged-out', deviceName: this.config.deviceName });
      return;
    }
    this.credentials = stored;
    this.startTunnel();
  }

  async login(): Promise<AccountCardState> {
    this.stopped = false;
    this.setState({ status: 'logging-in', deviceName: this.config.deviceName });
    try {
      const credentials = await loginWithDeviceCode({
        serverBaseUrl: this.config.serverBaseUrl,
        deviceName: this.config.deviceName,
        platform: this.config.platform,
        fetchImpl: this.deps.fetchImpl,
        ...this.deps.authOptions,
        onUserCode: (info) => {
          this.setState({
            status: 'logging-in',
            deviceName: this.config.deviceName,
            userCode: info.userCode,
          });
          this.deps.log?.(`[dsh-mobile-tunnel] 请在浏览器确认设备码 ${info.userCode}：${info.verificationUrl}`);
          this.deps.authOptions?.onUserCode?.(info);
        },
      });
      this.credentials = credentials;
      await this.deps.store.save(credentials);
      this.startTunnel();
      return this.state;
    } catch (error) {
      this.setState({
        status: 'error',
        deviceName: this.config.deviceName,
        message: (error as Error).message,
      });
      return this.state;
    }
  }

  async logout(): Promise<void> {
    this.tunnel?.sendOfflineAndStop();
    this.tunnel = null;
    this.credentials = null;
    await this.deps.store.clear();
    this.setState({ status: 'logged-out', deviceName: this.config.deviceName });
  }

  stop(): void {
    this.stopped = true;
    this.tunnel?.stop();
    this.tunnel = null;
  }

  private setState(state: AccountCardState): void {
    this.state = state;
    this.deps.onStateChange?.(state);
  }

  private startTunnel(): void {
    if (!this.credentials) return;
    const credentials = this.credentials;
    const resolveBase = this.config.resolveDshBaseUrl ?? (() => this.config.dshBaseUrl);
    const cookieProvider =
      this.deps.cookieProvider ??
      new LaunchTokenCookieProvider({
        dshBaseUrl: resolveBase,
        launchToken: this.config.launchToken ?? (async () => null),
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const forwardLocalRequest = createLocalDshForwarder({
      dshBaseUrl: resolveBase,
      cookieProvider,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });

    this.tunnel = new TunnelClient({
      serverBaseUrl: this.config.serverBaseUrl,
      deviceId: credentials.deviceId,
      getAccessToken: async () => this.credentials?.accessToken ?? null,
      refreshAccessToken: async () => {
        const current = this.credentials;
        if (!current) return null;
        try {
          const refreshed = await refreshTokens(this.config.serverBaseUrl, current.refreshToken, fetchImpl);
          this.credentials = {
            ...current,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          };
          await this.deps.store.save(this.credentials);
          return refreshed.accessToken;
        } catch (error) {
          this.deps.log?.(`[agent] 刷新令牌失败：${(error as Error).message}`);
          return null;
        }
      },
      forwardLocalRequest,
      openLocalWebSocket: (input) => this.openLocalWebSocket(input, cookieProvider),
      getTunnelTicket: async (accessToken) => {
        try {
          return await requestTunnelTicket(this.config.serverBaseUrl, accessToken, fetchImpl);
        } catch (error) {
          this.deps.log?.(`[agent] 申请隧道票据失败：${(error as Error).message}`);
          return null;
        }
      },
      backoffBaseMs: this.deps.backoffBaseMs ?? 1000,
      backoffMaxMs: 30_000,
      ...(this.deps.log ? { log: this.deps.log } : {}),
      onStatusChange: (status) => {
        if (status === 'online') {
          this.setState({
            status: 'online',
            deviceName: this.config.deviceName,
            ...(this.credentials?.accountEmail ? { accountEmail: this.credentials.accountEmail } : {}),
          });
        } else if (status === 'reconnecting' || status === 'connecting') {
          this.setState({
            status: 'offline',
            deviceName: this.config.deviceName,
            ...(this.credentials?.accountEmail ? { accountEmail: this.credentials.accountEmail } : {}),
          });
        }
      },
    });
    this.tunnel.start();
  }

  private async openLocalWebSocket(
    input: LocalWsOpenInput,
    cookieProvider: DshCookieProvider,
  ): Promise<LocalWsHandle> {
    const startedAt = Date.now();
    const cookie = await cookieProvider.getCookie();
    const resolveBase = this.config.resolveDshBaseUrl ?? (() => this.config.dshBaseUrl);
    const dshBaseUrl = resolveBase();
    const base = dshBaseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    const origin = new URL(dshBaseUrl).origin;
    const headers: Record<string, string> = { ...input.headers, origin };
    if (cookie) headers.cookie = cookie;
    const url = `${base}${input.path}`;
    const hasSubprotocol = Boolean(headers['sec-websocket-protocol']);

    return new Promise<LocalWsHandle>((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      let recv = 0;
      let sent = 0;
      let sawBinary = false;

      socket.once('open', () => {
        muxLog(`open url=${url} ms=${Date.now() - startedAt} subprotocol=${hasSubprotocol}`);
        resolve({
          send: (data, binary) => {
            sent += 1;
            socket.send(data, { binary });
          },
          close: (code, reason) => {
            try {
              socket.close(code, reason);
            } catch {
              // 忽略
            }
          },
        });
      });
      socket.once('unexpected-response', (_request, response) => {
        // 409 = DSH 认为该 peer 已有 mux socket（admitConnection 的 peer 独占）
        const reason = `local ws unexpected response ${response.statusCode} ${url}`;
        muxLog(
          `upgrade-rejected status=${response.statusCode} ms=${Date.now() - startedAt} url=${url} subprotocol=${hasSubprotocol}`,
        );
        this.deps.log?.(reason);
        reject(new Error(reason));
        try {
          socket.terminate();
        } catch {
          // 忽略
        }
      });
      socket.once('error', (error) => {
        const detail = error as NodeJS.ErrnoException;
        const reason = `local ws error ${detail.code ?? ''} ${detail.message ?? ''} ${url}`.replace(/\s+/g, ' ').trim();
        muxLog(
          `error ms=${Date.now() - startedAt} code=${detail.code ?? ''} msg=${(detail.message ?? '').slice(0, 120)}`,
        );
        this.deps.log?.(reason);
        reject(new Error(reason));
      });
      socket.on('message', (data, isBinary) => {
        recv += 1;
        if (isBinary) sawBinary = true;
        if (recv === 1) {
          muxLog(`first-frame bytes=${rawDataSize(data)} binary=${isBinary} ms=${Date.now() - startedAt}`);
        }
        input.onMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), isBinary);
      });
      socket.on('close', (code, reason) => {
        // 1006 = DSH 侧 terminate（心跳连续缺失或 socket error）；1001 = peer 释放
        muxLog(
          `close code=${code} reason=${reason.toString().slice(0, 80)} ms=${Date.now() - startedAt} sent=${sent} recv=${recv} binary=${sawBinary}`,
        );
        input.onClose(code, reason.toString());
      });
    });
  }
}

export type { LocalRequestInput, LocalResponseResult };
