# AGENTS.md · dsh-app 协作指南

面向在本仓库工作的 AI/工程师。先读本文件，再读相关规格与文档。

## 仓库定位

DeepSeek Harness 移动端远程控制：账号服务 + 桌面出站隧道插件 + Flutter 移动壳 + DSH 客户端适配层。

| 目录 | 技术栈 | 作用 |
|---|---|---|
| `server/` | TypeScript ESM + Fastify 5 + pg + ws + zod | 账号/设备/隧道/代理 API |
| `dsh-mobile-tunnel/` | TypeScript ESM（Cordis 插件，ESM `main/exports` → `dist/index.js`） | 桌面端隧道客户端 + PC 端账号面板（登录态、下载二维码） |
| `mobile/` | Flutter 3.24 / Dart 3.5 | 移动壳（WebView） |
| `mobile-adapt/` | TypeScript（浏览器注入）+ jsdom/Playwright 测试 | 窄屏适配层 |
| `deploy/` | Docker Compose + nginx + bash | 一键部署、备份 |
| `docs/` | Markdown / SQL | API 契约、数据库结构、方案 |

> 内部规格与实施记录（`.spec-workflow/`）不随公开仓库发布。

## 常用命令

```bash
# 服务端（需要 PostgreSQL；测试用 127.0.0.1:55432）
cd server && npm install
npm run typecheck && npm run test
npm run migrate && npm run dev

# 桌面插件（test 需要本地 Postgres 55432；仅改面板/协议时可只跑 test:unit + check:client）
cd dsh-mobile-tunnel && npm install && npm run typecheck && npm run test:unit && npm run check:client && npm run build
# 完整集成测试（需要 Postgres）
npm run test

# 移动端（Flutter 未在 PATH 时）
$env:FLUTTER_STORAGE_BASE_URL='https://storage.flutter-io.cn'
$env:PUB_HOSTED_URL='https://pub.flutter-io.cn'
$env:FLUTTER_SUPPRESS_ANALYTICS='true'
$flutter='G:\tools\flutter-sdk-extract\flutter\bin\flutter.bat'
cd mobile && & $flutter --no-version-check pub get
& $flutter --no-version-check analyze
& $flutter --no-version-check test

# 适配层
cd mobile-adapt && npm install && npm test && npm run test:browser

# Docker 一键部署（本机验证）
cd deploy && cp .env.example .env && docker compose up -d --build
```

## 验证要求

- 修改服务端：`npm run typecheck` + `npm run test`（真 Postgres，测试自建临时库并清理）
- 修改插件：`npm run typecheck` + `npm run test:unit` + `npm run check:client`（不依赖数据库）；改动隧道/代理时再加 `npm run test`（需要 Postgres 55432）
- 修改移动端：`flutter analyze` 无问题 + `flutter test` 全绿
- 修改适配层：jsdom 测试 + 真实浏览器布局测试（`test:browser`）
- 不为了“过测试”改断言；发现实现缺陷优先修实现

## 代码约定

- TypeScript：strict、ESM、相对导入必须带 `.js` 后缀；错误统一 `{ error: { code, message, requestId } }`
- 服务端数据库变更：只新增 `server/migrations/NNNN_*.sql`，必须幂等（`IF NOT EXISTS`）；不直接改 `docs/schema.sql` 作为线上变更
- 插件：`package.json` 的 `main/exports` 必须指向 `dist/index.js`，`cordis.patch.yml` 负责注册 `mobile-tunnel` 条目；改动源码后必须 `npm run build`
- Flutter：状态与平台适配分离（`form_factor.dart`/`webview_bridge.dart` 纯函数，便于 widget test）；令牌只进安全存储
- 测试：Node 用 `node --import tsx --test`；Flutter 用 `flutter test`；适配层真实布局用 `playwright-core` 本机 Edge/Chrome
- 文档：中文；路径引用使用相对路径；文档迁移后全局替换引用并 grep 校验

## 安全红线

- 不提交任何真实密钥/口令/证书；根 `.gitignore` 已忽略 `.env`、`*.local`、构建产物（`dist/`、`build/`）、本地预览与运维残留（`.acl-reports/`、`.screenshots/`、`.tmp-*/`、`docs/preview/`）
- 生产发布前必须备份（nginx 配置、数据库 pg_dump、关键 `.env`），备份带时间戳并保留
- 生产操作走内部运维流程（堡垒机 / 运维技能连生产服务器），不臆造流程
- 不修改生产已有数据；验证删除/更新类接口只用自建测试数据并清理
- 桌面 `desktop` profile 归 Electron 管理：`dsh plugin --profile desktop ...` 会被拒绝，安装插件走 DSH 设置页

## 部署要点

- `deploy/docker-compose.yml`：`postgres:16-alpine` + `dsh-account`，仅绑 `127.0.0.1:8787`，由宿主机 nginx 终止 TLS；`server` 额外只读挂载 `../downloads:/app/apk`（安装包目录，`APK_DIR=/app/apk`）
- nginx 站点：模板 `deploy/nginx/example.com.conf`，部署时替换域名与证书片段路径后放到 `/etc/nginx/conf.d/<域名>.conf`；模板已含 HSTS、安全响应头、`server_tokens off`，`/healthz` 仅允许本机；注意 ssl snippet 已含 `http2 on`，站点块不要重复
- 下载页（由 Node 提供，nginx 整站反代，不要再加 `/download/` 静态 alias）：`/download` 页面、`/download/latest.apk`（302 到当前正式版）；安装包放 `downloads/`，命名 `dsh-mobile-<version>.apk`（测试包 `-test` 后缀，只在没有正式版时兜底）
- 备份：`/etc/cron.d/dsh-account` 每日 03:30 执行 `deploy/backup.sh`（pg_dump，保留 14 天）；日志 json-file 20m×5
- 回滚：`docker compose down` + 删除站点 conf + 恢复 nginx 备份 tar + reload；数据库用当次备份 `psql` 还原（迁移 0004 只放开 `sessions.device_id` 可空，回滚代码不必回滚数据）
- 插件发布：构建后必须把 `dsh-mobile-tunnel/dist`、`dsh-mobile-tunnel/client`、`package.json` 同步到 DSH profile 的 `node_modules/dsh-mobile-tunnel`（DSH 加载的是 profile 里的副本，只重启不同步仍是旧版）

## 账号面板与 App 下载

- 面板登录走 `POST /v1/auth/panel-login`（邮箱 + 密码）：服务端只建会话、不登记设备；1.1.2 起插件在登录成功后自动调用 `POST /plugins/dsh-mobile-tunnel/register-device` 把**本机**登记为受控设备（同名同平台复用），因此每台电脑都会作为独立设备出现在手机列表里
- 会话持久化：插件在 DSH 本机 Web 服务注册 `GET/POST/DELETE /plugins/dsh-mobile-tunnel/panel-session`，数据存 `~/.dsh/dsh-mobile-account-panel.json`（0600）；浏览器存储只作接口不可用时的兜底
- 面板登录后展示：账号信息、配额、设备列表、App 下载二维码（内容 `https://dsh.hbzxht.com/download`，中间黑色鲸鱼 logo）与下载链接
- 二维码离线生成：改下载地址或换 logo 后执行 `cd dsh-mobile-tunnel && npm run gen:qr` 重新生成 `src/app-qr.ts`，再 `npm run build`

## 移动端文件面板（1.1.0+）

- 入口：右侧面板 Guide 的「工作区文件」行被插件**原样克隆替换**（文字/样式不变，只换点击行为）；仅移动端，桌面端不挂载、不插任何节点，也**没有悬浮按钮**
- 数据：宿主只读 HTTP `GET /plugins/dsh-mobile-tunnel/fs-roots | fs?path= | fs-file?path=`，工作区由 `~/.dsh/storages/workspace.json` + 最近活跃会话反查，越界返回 403；客户端 `fetch` 直读
- **不要**改回 `ctx.resources` / `remote.workspaceFiles`：客户端插件声明该服务会让整个插件延迟启动（连带移动端 UI 修正停摆），`ctx.inject([...])` 反应式注入也会被 Cordis 拒绝
- 预览能力：Markdown 渲染、JSON 美化、代码高亮+行号、图片点击放大；黑名单只挡可执行/压缩包/媒体等二进制
- 排错：`POST /plugins/dsh-mobile-tunnel/diag` 追加写 `~/.dsh/dsh-mobile-tunnel-diag.log`，客户端自报日志（版本号、入口替换、关闭、目录加载等）

## 网络与在线状态（1.1.1+）

- 在线判定：服务端 `GET /v1/devices` 的 `online` = **隧道活跃会话真值** `registry.isOnline(deviceId)`，没有会话时才回落到 `last_seen_at` 时间窗；另有 `connected` 字段表示会话真值
- 服务端参数走环境变量（改配置不用改代码）：`TUNNEL_HEARTBEAT_SEC`（默认 25）、`TUNNEL_OFFLINE_SEC`（默认 150）、`TUNNEL_RECONNECT_GRACE_SEC`（默认 15，断连后延迟标记离线的宽限）、`DEVICE_SEEN_THROTTLE_SEC`（默认 10，入站帧刷新 last_seen 的节流）
- 插件重连策略：连接超时 10s、保活 25s、75s 无入站帧判定死连接、网卡地址变化立即重连、退避封顶 10s + 抖动；参数可用 `DSH_MT_CONNECT_TIMEOUT_MS`、`DSH_MT_KEEPALIVE_MS`、`DSH_MT_DEAD_AFTER_MS`、`DSH_MT_NETWORK_WATCH_MS`、`DSH_MT_BACKOFF_MAX_MS` 调整
- 排障接口：`GET /plugins/dsh-mobile-tunnel/tunnel-status`（只读，回环 DSH 内可访问）返回 `status / online / attempts / lastConnectedAt / lastFrameAt / lastError / protocolVersion` 等，不包含任何凭据
- 手机端：前台 10s / 后台 30s 轮询设备列表；离线设备显示「最后在线 x 分钟前」，点击会先刷新并自动重试约 20s，再提示离线

## 已知限制 / 待办

- 桌面插件设置页卡片依赖 DSH 未公开 UI API；未挂载时用 `dsh-mobile-tunnel/scripts/login.mjs` 兜底
- 插件私钥保存在 0600 凭据文件（系统凭据管理器为后续强化项）
- 移动端真机安装、3 秒首屏、折叠屏实物切换待真机验证（平台发布计划见 README「版本规划」）
- 隧道票据为单实例内存实现（规格 §12 允许），多实例需改共享存储
- 移动端 release 签名读取 `mobile/android/key.properties`（模板 `key.properties.example`，文件已在忽略列表）；未提供时回退 debug 签名，只能自测、不能分发

## 多设备与配额（1.1.5+）

- 每台电脑在「移动端」面板登录后，插件自动把本机登记为独立受控设备并启动隧道（同名同平台复用，不重复占额度）；手机设备列表按 `kind=desktop` 只显示可连接的电脑，点哪台连哪台。
- 设备配额按账号配置：桌面默认 **2** 台、移动默认 **2** 台（`accounts.desktop_device_limit` / `mobile_device_limit`；迁移 0005 起移动端默认 2）。配额满时登记返回 `403 authz.device_quota_exceeded`，面板显示具体原因。
- 面板登录（`/v1/auth/panel-login`）只建网页会话、不登记设备；登记由宿主接口 `POST /plugins/dsh-mobile-tunnel/register-device` 完成（仅本机同源可调）。
- 登记后插件调用 `POST /v1/devices/:id/session` 换一条**绑定该设备**的会话再建隧道：网页会话 access token 只有 15 分钟且刷新有限流，直接拿来跑隧道会反复 `no-ticket` 掉线。
- 换会话返回 `403`（设备已在手机端移除/撤销）时，插件忽略旧凭据、按名称复用或重新登记一台，再换会话（1.1.5+）。
- 隧道票据 `POST /v1/tunnel/ticket` 允许带 `{ deviceId }`：网页会话必须带且设备需属于本账号；设备会话不带则用会话自身的设备。
