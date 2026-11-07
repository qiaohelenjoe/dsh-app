# dsh-account-server

DSH 移动端账号平台服务端（当前覆盖 T01 数据层 + T02 认证 API）。

技术栈：TypeScript + Fastify + PostgreSQL 16 + argon2id + JWT（规格 §15）。

## 本地准备 PostgreSQL 16

```powershell
docker run -d --name dsh-account-pg-test `
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres `
  -p 55432:5432 pgvector/pgvector:pg16
```

## 配置

```powershell
copy .env.example .env
# 或直接设置环境变量（服务启动必填 DATABASE_URL / AUTH_JWT_SECRET / AUTH_REFRESH_PEPPER）
$env:DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55432/postgres'
$env:AUTH_JWT_SECRET = '<至少 32 位随机串>'
$env:AUTH_REFRESH_PEPPER = '<至少 16 位随机串>'
```

## 迁移

```powershell
npm install
npm run migrate     # 执行未应用的迁移（幂等，可重复执行）
npm run db:version  # 查看结构版本是否与代码一致
```

## 启动与健康检查

```powershell
npm start
curl.exe -i http://127.0.0.1:8787/healthz
```

- 数据库可用且结构版本一致：`200 {"status":"ok","db":"up","schemaVersion":"0001"}`
- 数据库不可用：`503 {"status":"error","db":"down","reason":"..."}`
- 结构版本落后/超前：`503 {"status":"error","db":"up","reason":"数据库结构落后：..."}`

## 认证 API（T02）

统一错误体：`{"error":{"code","message","requestId"}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/register` | 注册（201；弱口令 400 `request.weak_password`；重复 409 `conflict.email_taken`） |
| POST | `/v1/auth/login` | 登录并登记设备（200，返回 access/refresh/device） |
| POST | `/v1/auth/refresh` | 刷新并轮换（复用旧令牌 401 `auth.token_reuse` 并撤销会话） |
| POST | `/v1/auth/logout` | 登出当前会话（204） |
| POST | `/v1/auth/change-password` | 改密（需 Bearer；撤销其他会话；204） |
| POST | `/v1/auth/forgot-password` | 忘记密码（恒 202，防枚举） |
| POST | `/v1/auth/reset-password` | 一次性令牌重置（撤销全部会话；204） |

实现要点：

- 密码 argon2id（m=64MiB, t=3, p=4），只存哈希；弱口令拒绝 `server/data/weak-passwords.txt`（前 10 万）
- access JWT 15 分钟（HS256，含 `sub`=账号、`sid`=会话）；refresh 30 天轮换，只存 `SHA-256(secret+pepper)`
- 限流（单实例内存）：登录 5 次/分钟/IP + 10 次/小时/账号；注册 3 次/小时/IP；刷新 60 次/小时/会话；超限 429 + `Retry-After`
- 邮件端口 `Mailer` 默认写日志（开发模式），部署时替换真实 SMTP（T12）

```powershell
# 最小冒烟
curl.exe -s -X POST http://127.0.0.1:8787/v1/auth/register -H 'content-type: application/json' `
  --data-binary '{"email":"me@example.com","password":"Str0ng-Passw0rd-2026"}'
```


## 设备 API（T03）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/devices` | 本账号设备列表（含 `online`，90 秒判定；在线优先排序） |
| POST | `/v1/devices` | 登记设备（201；同类配额 桌面 20 / 移动 10；同平台同名 409；超配 403） |
| PATCH | `/v1/devices/:id` | 重命名（200；跨账号 403 `authz.forbidden`） |
| DELETE | `/v1/devices/:id` | 撤销（204；设备+会话+审计同事务；通知隧道断开钩子） |

设备类型由平台推断：`android/ios/harmony` → mobile，`win32/darwin/linux` → desktop。
隧道断开钩子接口见 `src/devices/tunnel-hooks.ts`，T05 注入真实实现。
## 设备码授权（T04，桌面端登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/auth/device-code` | 申请设备码（`userCode` 形如 `ABCD-1234`，600 秒有效，`interval` 秒轮询） |
| POST | `/v1/auth/device-token` | 轮询换令牌（pending 202；批准 200；拒绝 403；过期 410；过快 429） |
| POST | `/v1/auth/device-code/approve` | 网页端确认/拒绝（需登录态；`decision: approve|deny`） |
| GET | `/activate` | 最小确认页（登录 + 输入用户码 + 批准/拒绝） |

流程：插件申请码 → 浏览器打开 `/activate` 登录并输入用户码确认 → 插件轮询拿令牌 →
用该令牌 `POST /v1/devices` 登记真实公钥（服务端把占位设备升级为真实设备）。
轮询间隔由 `DEVICE_CODE_POLL_INTERVAL_SECONDS` 控制（默认 2 秒）。
## 隧道服务（T05）

桌面端 **出站** 连接 `WSS /v1/tunnel`（`Authorization: Bearer <access_token>` 或 `?token=`），
首帧 `register` 后才算在线；服务端通过 `req`/`res` 帧转发 HTTP 请求（`more` 支持分块）。

- 心跳：服务端按 `heartbeatSec` 发 `ping`，客户端回 `pong`；超过离线阈值判定离线并关闭
- 路径白名单：`/`、`/api/*`、`/assets/*`、`/favicon*`、`/manifest*`；黑名单 `/connect`、`/api/pair/*`、`/api/plugin-manager/*`、`/api/update/*`（403 `tunnel.path_denied` + 审计）
- 单帧上限 1 MiB；单设备并发未完成请求上限 32；重复连接踢掉旧连接；设备撤销立即断连
- 联调脚本：`node --import tsx scripts/fake-tunnel.ts <baseUrl> <accessToken> <deviceId> [targetBaseUrl]`
## WebSocket 代理（T06）

客户端（浏览器/手机 WebView）对 `ws(s)://<域名>/t/<deviceId>/<path>?token=<access_token>` 发起升级：

- 服务端鉴权后通过隧道向桌面端发 `wsopen`，桌面端在本机建立 WS 并确认后，客户端才收到 101
- 之后 `wsdata` 双向转发，任一端关闭时 `wsclose` 传播关闭码（1005/1006 等保留码在发送侧规范化为 1000）
- WS 通道不计入 HTTP 并发窗口；每设备上限 8（`tunnel.ws_limit_exceeded`）
- 未注册/离线设备 503；路径白名单外 403 + 审计；单帧 >1 MiB 断开并审计 `tunnel.frame_too_large`
## 设备 UI 代理（T07）

浏览器/WebView 直接访问 `http(s)://<域名>/t/<deviceId>/`：

- 鉴权：cookie `dsh_access=<access_token>`（也支持 `Authorization: Bearer` 与 `?token=`）；未登录 HTML 请求 302 到 `/login?next=…`，JSON 请求 401
- 校验：设备归属（他人设备 403）、在线状态（离线 503 + 友好页 / JSON `tunnel.device_offline`）
- 转发：经隧道到桌面端本机 DSH；剥离 `/t/<id>` 前缀；不转发 Cookie/Authorization（凭据由 T08 在隧道侧注入）
- 重写：HTML/CSS 的根绝对路径加 `/t/<id>` 前缀；`Location` 同理；`Set-Cookie` 的 `Path` 改为 `/t/<id>`；`Content-Length` 按实际 body 重新生成
- 安全：原始 URL 上做两层解码的 `..`/反斜杠/NUL 检查（400），路径白名单由隧道层执行
- `/t/<id>`（无尾斜杠）302 到 `/t/<id>/`
## 桌面插件（T08，`dsh-mobile-tunnel/`）

DSH Cordis 插件 `dsh-mobile-tunnel`：设备码登录 → 注册设备 → 出站 WSS 隧道 → 把 `/t/<id>/*` 请求转发到本机 DSH。

```powershell
cd dsh-mobile-tunnel
npm install
npm run typecheck
npm test          # 6 条端到端测试（真实服务端 + 模拟本机 DSH）
```

- 登录：申请设备码 → 打开 `/activate` → 轮询换令牌 → 生成 Ed25519/X25519 密钥 → `POST /v1/devices`
- 凭据：默认文件 `$DSH_HOME/mobile-tunnel.json`（0600），接口可替换为系统凭据管理器
- DSH Cookie：用启动令牌走 `/connect?token=…&interactions=none` 换取，缓存后注入每个转发请求（401 自动换一次）
- 隧道：`req/res`（分块）+ `wsopen/wsdata/wsclose`，心跳，指数退避重连（1s→30s），4000 关闭则停止重连
- 设置页「账号」卡片：状态模型 + HTML 渲染；真实宿主挂载 API 未知，`index.ts` 做特性检测与降级（需真机验证）
## 移动壳（T09，`mobile/`）

Flutter 工程（Android/iOS 骨架已生成）：登录 → 设备列表 → WebView 加载 `/t/<deviceId>/`。

```powershell
cd mobile
flutter pub get
flutter analyze
flutter test          # 23 条 widget/单元测试
```

- 形态判定：短边 ≥ 600dp 保持桌面布局；< 600dp 注入 `data-dsh-layout="mobile"` 标记（T10 适配层使用）
- 折叠屏：展开/折叠只重新注入布局标记，**不重载 WebView**
- Cookie：登录后以 `dsh_access` 写入 `/t/<deviceId>` 作用域；冷启动有会话+上次设备则直接进 WebView
- 返回键：先回 WebView 历史，再退出；外链交给系统浏览器；加载失败可重试
- Flutter SDK 安装在仓库外（不随仓库分发），三端发布计划见根 README「版本规划」
## 移动适配层（T10，`mobile-adapt/`）

DSH 客户端插件：窄屏（< 900px）抽屉侧栏、消息区全宽、输入吸底、按钮 ≥44px、终端面板可折叠；宽屏零副作用。

```powershell
cd mobile-adapt
npm install
npm run typecheck
npm test              # jsdom：7 条
npm run test:browser  # playwright-core + 本机 Edge：真实 390×844 / 1024×768 布局断言
```

- 取证：DSH 前端 CSS 全文件只有 `prefers-reduced-motion` 媒体查询（无响应式断点），类名为 CSS Modules 哈希
- 实现：语义选择器 + 几何启发式给侧栏/主区/输入/面板打 `data-dsh-adapt` 标记，CSS 只在窄屏作用域内生效
- 控制：`window.__DSH_MOBILE_ADAPT__.enable()/disable()/toggle()/refresh()`，关闭后清除全部样式与标记
- 手势：左缘右滑开抽屉、Esc 关闭、点遮罩关闭；终端面板按钮折叠
## 测试

集成测试会自行创建/删除一次性数据库（前缀 `dsh_test_`），连接串默认
`postgres://postgres:postgres@127.0.0.1:55432/postgres`，可用 `TEST_DATABASE_ADMIN_URL` 覆盖。

```powershell
npm test        # 数据层 7 + /healthz 4 + 认证 API 12 = 23 条
npm run test:db # 仅数据层
npm run typecheck
```

## 目录约定

```text
server/
├── data/weak-passwords.txt  # 前 10 万弱口令（来源：SecLists xato-net top-100000）
├── migrations/              # 按序号组织的迁移 SQL（0001_init.sql）
├── src/
│   ├── app.ts               # Fastify 组装（健康检查 + 认证路由 + 统一错误体）
│   ├── config.ts            # 环境变量读取（含认证密钥）
│   ├── health.ts            # GET /healthz
│   ├── index.ts             # 启动入口（校验结构版本 → 监听）
│   ├── auth/                # 认证服务、邮件端口、仓储（账号/会话/令牌/审计/登录设备）
│   ├── http/                # 路由、zod 校验、鉴权守卫、统一错误体
│   ├── security/            # argon2id、JWT/refresh、限流
│   └── db/                  # 连接池、迁移执行器、CLI
└── test/                    # 集成测试（真 Postgres）
```
