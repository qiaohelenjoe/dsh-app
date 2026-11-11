import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  bindOwnMachineName,
  claimDeviceByMachineName,
  generateDeviceKeys,
  loginWithDeviceCode,
  refreshTokens,
  registerDevice,
  requestDeviceSession,
  requestTunnelTicket,
  type DeviceAuthOptions,
  type DeviceKeys,
  type DeviceSessionTokens,
} from './auth.js';
import { computeMachineName } from './machine-name.js';
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
import { TunnelClient, type LocalWsHandle, type LocalWsOpenInput, type TunnelDiagnostics, type TunnelStatus } from './tunnel.js';

/** mux 连接生命周期日志路径：DSH 不落盘 `[api-gateway]` 输出，排障只能靠插件侧记录。 */
const MUX_LOG_PATH = join(tmpdir(), 'dsh-mobile-tunnel-mux.log');
const MUX_LOG_LIMIT_BYTES = 512 * 1024;

/** 读取正整数环境变量（毫秒参数），非法值回落到默认。 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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
  private readonly listeners = new Set<(event: unknown) => void>();

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

  /** 隧道诊断快照（只读，排障接口与状态卡片使用）。 */
  getTunnelDiagnostics(): TunnelDiagnostics | null {
    return this.tunnel?.getDiagnostics() ?? null;
  }

  /** 本机当前登记的 deviceId（未登录为 null）。 */
  get deviceId(): string | null {
    return this.credentials?.deviceId ?? null;
  }

  /** 隧道快照（诊断对象本身已含 deviceId）；隧道未启动时为 null。 */
  getTunnelSnapshot(): TunnelDiagnostics | null {
    return this.getTunnelDiagnostics();
  }

  /** 面板状态快照：卡片状态 + 隧道诊断（SSE 与首帧都发这个）。 */
  snapshot(): { state: AccountCardState; tunnel: TunnelDiagnostics | null } {
    return { state: this.state, tunnel: this.getTunnelSnapshot() };
  }

  /**
   * 订阅状态快照：注册时立即回调一次当前值，之后每次状态变化再回调。
   * 面板据此用 SSE 拿在线状态，不再轮询。
   */
  onStatus(cb: (event: unknown) => void): () => void {
    this.listeners.add(cb);
    try {
      cb({ type: 'tunnel', ...this.snapshot() });
    } catch {
      // 忽略
    }
    return () => {
      this.listeners.delete(cb);
    };
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
    // 老设备补码：设备行还没有计算机名称时，用现有设备会话把本机计算机名称补上（失败不影响连接）
    void this.reportMachineCode(stored);
  }

  /** 本机计算机名称（如 PC-3F7A-91C2）；读不到系统标识时返回 null。 */
  machineName(): string | null {
    return computeMachineName();
  }

  /** 把本机计算机名称补绑到当前设备行（仅当该行还没有码，服务端幂等）。 */
  async reportMachineCode(credentials: StoredCredentials = this.credentials as StoredCredentials): Promise<boolean> {
    const code = this.machineName();
    if (!code || !credentials?.accessToken) return false;
    try {
      await bindOwnMachineName(
        this.config.serverBaseUrl,
        credentials.accessToken,
        code,
        this.deps.fetchImpl ?? fetch,
      );
      return true;
    } catch {
      // 老服务端没有该接口、或该行已绑定不同码：都不影响隧道
      return false;
    }
  }

  async login(): Promise<AccountCardState> {
    this.stopped = false;
    this.setState({ status: 'logging-in', deviceName: this.config.deviceName });
    try {
      const credentials = await loginWithDeviceCode({
        serverBaseUrl: this.config.serverBaseUrl,
        deviceName: this.config.deviceName,
        platform: this.config.platform,
        machineName: this.machineName(),
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

  /**
   * 用「移动端」面板的登录会话把本机登记为受控设备，并启动隧道。
   *
   * 面板登录（邮箱+密码）只建网页会话、不登记设备；多台电脑要各自出现在手机的
   * 设备列表里，必须在登录后把本机登记成独立设备。幂等：同名同平台已存在则复用。
   */
  async adoptPanelSession(session: {
    accessToken: string;
    refreshToken: string;
    email: string;
  }): Promise<{ deviceId: string; reused: boolean; online: boolean; deviceName: string; platform: string }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const base = this.config.serverBaseUrl.replace(/\/$/, '');
    this.stopped = false;

    const resolveDevice = async (
      preferStored: boolean,
    ): Promise<{ deviceId: string; keys: DeviceKeys; reused: boolean; name?: string }> => {
      const stored = await this.deps.store.load();
      if (preferStored && stored && stored.deviceId && stored.accountEmail === session.email) {
        return {
          deviceId: stored.deviceId,
          keys: {
            signPublicKey: stored.signPublicKey,
            ecdhPublicKey: stored.ecdhPublicKey,
            signPrivateKeyPem: stored.signPrivateKeyPem,
            ecdhPrivateKeyPem: stored.ecdhPrivateKeyPem,
          },
          reused: true,
        };
      }
      const listResponse = await fetchImpl(`${base}/v1/devices`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      }).catch(() => null);
      const devices =
        listResponse && listResponse.ok
          ? (
              (await listResponse.json()) as {
                devices?: Array<{
                  id: string;
                  name: string;
                  platform: string;
                  kind: string;
                  machineName?: string | null;
                }>;
              }
            ).devices ?? []
          : [];
      // 身份只认计算机名称：设备名称可随时修改，不能参与判定
      const machineName = this.machineName();
      const existing = machineName
        ? devices.find(
            (device) =>
              device.kind === 'desktop' &&
              device.platform === this.config.platform &&
              device.machineName === machineName,
          )
        : undefined;
      if (existing) {
        // 复用已有设备时拿不到私钥（服务端只存公钥）；隧道握手只用 deviceId，不影响连接
        return {
          deviceId: existing.id,
          keys: { signPublicKey: '', ecdhPublicKey: '', signPrivateKeyPem: '', ecdhPrivateKeyPem: '' },
          reused: true,
          name: existing.name,
        };
      }
      const keys = generateDeviceKeys();
      const device = await registerDevice({
        serverBaseUrl: this.config.serverBaseUrl,
        accessToken: session.accessToken,
        deviceName: this.config.deviceName,
        platform: this.config.platform,
        keys,
        machineName,
        fetchImpl,
      });
      return { deviceId: device.id, keys, reused: false, name: device.name };
    };

    let resolved = await resolveDevice(true);
    let tokens: DeviceSessionTokens;
    try {
      // 面板会话是网页会话（无设备），不能长期直接用于隧道：换一条绑定该设备的会话
      tokens = await requestDeviceSession(
        this.config.serverBaseUrl,
        session.accessToken,
        resolved.deviceId,
        fetchImpl,
      );
    } catch (error) {
      // 本地记着的设备可能已在手机端被移除：忽略旧凭据，按名称复用或重新登记一台
      if (!/HTTP 403/.test(String((error as Error).message))) throw error;
      resolved = await resolveDevice(false);
      tokens = await requestDeviceSession(
        this.config.serverBaseUrl,
        session.accessToken,
        resolved.deviceId,
        fetchImpl,
      );
    }

    this.credentials = {
      deviceId: resolved.deviceId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountEmail: session.email,
      ...resolved.keys,
    };
    await this.deps.store.save(this.credentials);
    this.tunnel?.stop();
    this.tunnel = null;
    this.startTunnel();
    void this.reportMachineCode();
    return {
      deviceId: resolved.deviceId,
      reused: resolved.reused,
      online: this.getTunnelDiagnostics()?.online ?? false,
      // 服务端认的设备名（自动接管老设备时是那台的原名），与本地 COMPUTERNAME 无关
      deviceName: resolved.name ?? this.config.deviceName,
      platform: this.config.platform,
    };
  }

  /**
   * 一次性认领历史设备：把"从没记过计算机名称"的旧设备认成当前这台机器。
   * 认领后按计算机名称复用，不再依赖设备名称；不新建设备、不消耗名额。
   */
  async claimDevice(
    deviceId: string,
    session: { accessToken: string; refreshToken: string; email: string },
  ): Promise<{ deviceId: string; deviceName: string; online: boolean }> {
    const machineName = this.machineName();
    if (!machineName) throw new Error('无法读取本机计算机名称，不能认领设备');
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const claimed = await claimDeviceByMachineName(
      this.config.serverBaseUrl,
      session.accessToken,
      deviceId,
      machineName,
      fetchImpl,
    );
    const tokens = await requestDeviceSession(
      this.config.serverBaseUrl,
      session.accessToken,
      claimed.id,
      fetchImpl,
    );
    this.stopped = false;
    this.credentials = {
      deviceId: claimed.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountEmail: session.email,
      signPublicKey: '',
      ecdhPublicKey: '',
      signPrivateKeyPem: '',
      ecdhPrivateKeyPem: '',
    };
    await this.deps.store.save(this.credentials);
    this.tunnel?.stop();
    this.tunnel = null;
    this.startTunnel();
    return {
      deviceId: claimed.id,
      deviceName: claimed.name,
      online: this.getTunnelDiagnostics()?.online ?? false,
    };
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
    const event = { type: 'tunnel', ...this.snapshot() };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不影响其它订阅者
      }
    }
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
          return await requestTunnelTicket(this.config.serverBaseUrl, accessToken, fetchImpl, this.credentials?.deviceId);
        } catch (error) {
          this.deps.log?.(`[agent] 申请隧道票据失败：${(error as Error).message}`);
          return null;
        }
      },
      backoffBaseMs: this.deps.backoffBaseMs ?? 1000,
      backoffMaxMs: envMs('DSH_MT_BACKOFF_MAX_MS', 10_000),
      connectTimeoutMs: envMs('DSH_MT_CONNECT_TIMEOUT_MS', 10_000),
      keepaliveMs: envMs('DSH_MT_KEEPALIVE_MS', 25_000),
      deadAfterMs: envMs('DSH_MT_DEAD_AFTER_MS', 75_000),
      networkWatchMs: envMs('DSH_MT_NETWORK_WATCH_MS', 10_000),
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
