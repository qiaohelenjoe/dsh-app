# AGENTS.md · dsh-app 协作指南

面向在本仓库工作的 AI/工程师。先读本文件，再读相关规格与文档。

## 仓库定位

DeepSeek Harness 移动端远程控制：账号服务 + 桌面出站隧道插件 + Flutter 移动壳 + DSH 客户端适配层。

| 目录 | 技术栈 | 作用 |
|---|---|---|
| `server/` | TypeScript ESM + Fastify 5 + pg + ws + zod | 账号/设备/隧道/代理 API |
| `plugin/` | TypeScript ESM（Cordis 插件，ESM `main/exports` → `dist/index.js`） | 桌面端隧道客户端 + PC 端账号面板（登录态、下载二维码） |
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
cd plugin && npm install && npm run typecheck && npm run test:unit && npm run check:client && npm run build
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
- 插件发布：构建后必须把 `plugin/dist`、`plugin/client`、`package.json` 同步到 DSH profile 的 `node_modules/dsh-mobile-tunnel`（DSH 加载的是 profile 里的副本，只重启不同步仍是旧版）

## 账号面板与 App 下载

- 面板登录走 `POST /v1/auth/panel-login`（邮箱 + 密码）：只建会话、**不登记设备**，因此不占设备配额、也不会出现在设备列表里
- 会话持久化：插件在 DSH 本机 Web 服务注册 `GET/POST/DELETE /plugins/dsh-mobile-tunnel/panel-session`，数据存 `~/.dsh/dsh-mobile-account-panel.json`（0600）；浏览器存储只作接口不可用时的兜底
- 面板登录后展示：账号信息、配额、设备列表、App 下载二维码（内容 `https://dsh.hbzxht.com/download`，中间黑色鲸鱼 logo）与下载链接
- 二维码离线生成：改下载地址或换 logo 后执行 `cd plugin && npm run gen:qr` 重新生成 `src/app-qr.ts`，再 `npm run build`

## 已知限制 / 待办

- 桌面插件设置页卡片依赖 DSH 未公开 UI API；未挂载时用 `plugin/scripts/login.mjs` 兜底
- 插件私钥保存在 0600 凭据文件（系统凭据管理器为后续强化项）
- 移动端真机安装、3 秒首屏、折叠屏实物切换待真机验证（平台发布计划见 README「版本规划」）
- 隧道票据为单实例内存实现（规格 §12 允许），多实例需改共享存储
- 移动端 release 签名读取 `mobile/android/key.properties`（模板 `key.properties.example`，文件已在忽略列表）；未提供时回退 debug 签名，只能自测、不能分发
