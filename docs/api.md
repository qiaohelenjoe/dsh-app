# DSH 移动端账号平台 —— API 规范 v1.0

- Base URL: `https://<你的域名>`
- 内容类型: `application/json; charset=utf-8`
- 鉴权: `Authorization: Bearer <access_token>`
- 时间: 全部 ISO 8601 UTC
- ID: UUID v4 字符串

---

## 0. 通用约定

### 0.1 统一错误体

```json
{
  "error": {
    "code": "auth.invalid_credentials",
    "message": "邮箱或密码不正确",
    "requestId": "req_9f2c..."
  }
}
```

| HTTP | code 前缀 | 含义 |
|---|---|---|
| 400 | `request.*` | 参数错误 |
| 401 | `auth.*` | 未认证 / 令牌无效 |
| 403 | `authz.*` | 已认证但无权限（跨账号访问） |
| 404 | `not_found.*` | 资源不存在 |
| 409 | `conflict.*` | 冲突（重复注册、设备名重复） |
| 429 | `rate_limit.*` | 限流 |
| 500 | `internal.*` | 服务端错误 |

### 0.2 限流

| 端点 | 限制 |
|---|---|
| `POST /v1/auth/login` | 5 次/分钟/IP + 10 次/小时/账号 |
| `POST /v1/auth/register` | 3 次/小时/IP |
| `POST /v1/auth/refresh` | 60 次/小时/会话 |
| `POST /v1/devices` | 20 次/小时/账号 |
| `WSS /v1/tunnel` | 10 次/分钟/设备 |

超限返回 429 + `Retry-After` 头。

### 0.3 令牌有效期

| 令牌 | 有效期 |
|---|---|
| access_token | 15 分钟 |
| refresh_token | 30 天（每次刷新轮换） |
| device_code | 10 分钟 |
| user_code | 10 分钟 |
| tunnel_ticket | 60 秒 |

---

## 1. 认证

### 1.1 注册

```http
POST /v1/auth/register
Content-Type: application/json

{
  "email": "me@example.com",
  "password": "至少10位",
  "displayName": "测试用户"
}
```

响应 `201`：

```json
{
  "account": {
    "id": "acc_...",
    "email": "me@example.com",
    "displayName": "测试用户",
    "emailVerified": false
  },
  "verificationRequired": true
}
```

说明：
- 邮箱大小写不敏感
- 密码只存 argon2id 哈希
- `verificationRequired` 为 true 时，登录后部分写操作需先验证邮箱（可配置为不强制）

错误：`409 conflict.email_taken`、`400 request.weak_password`。

### 1.2 登录

```http
POST /v1/auth/login
{
  "email": "me@example.com",
  "password": "......",
  "device": {
    "name": "iPhone 15",
    "platform": "ios",
    "appVersion": "1.0.0",
    "signPublicKey": "base64...",
    "ecdhPublicKey": "base64..."
  },
  "clientType": "mobile"
}
```

响应 `200`：

```json
{
  "account": { "id": "acc_...", "email": "...", "displayName": "..." },
  "device": { "id": "dev_...", "name": "iPhone 15", "kind": "mobile", "platform": "ios" },
  "accessToken": "eyJ...",
  "refreshToken": "rt_...",
  "expiresIn": 900
}
```

- `kind` 由 `clientType` 决定：`mobile` → mobile；`desktop` → desktop
- 首次登录自动创建设备；同设备再次登录（同名同平台）复用已有 device 记录
- 错误：`401 auth.invalid_credentials`、`403 authz.account_suspended`

### 1.3 刷新

```http
POST /v1/auth/refresh
{ "refreshToken": "rt_..." }
```

响应 `200`：

```json
{ "accessToken": "eyJ...", "refreshToken": "rt_新", "expiresIn": 900 }
```

- 旧 refresh 立即作废（轮换）
- **检测到旧令牌被复用**：撤销该会话全部令牌，返回 `401 auth.token_reuse`，并写审计日志

### 1.4 登出

```http
POST /v1/auth/logout
{ "refreshToken": "rt_..." }
```

响应 `204`。仅撤销当前会话，不影响其他设备。

### 1.5 桌面端：申请设备码

```http
POST /v1/auth/device-code
{
  "deviceName": "我的电脑",
  "platform": "win32"
}
```

响应 `200`：

```json
{
  "deviceCode": "dc_opaque_32bytes",
  "userCode": "ABCD-1234",
  "verificationUrl": "https://dsh.example.com/activate",
  "expiresIn": 600,
  "interval": 2
}
```

### 1.6 桌面端：轮询换令牌

```http
POST /v1/auth/device-token
{ "deviceCode": "dc_opaque_32bytes" }
```

| 状态 | 响应 |
|---|---|
| 用户尚未确认 | `202` `{ "status": "pending" }` |
| 用户拒绝 | `403` `{ "error": { "code": "auth.device_code_denied" } }` |
| 已过期 | `410` `{ "error": { "code": "auth.device_code_expired" } }` |
| 用户确认 | `200` 令牌体（同 1.2 响应结构） |

> 轮询间隔不得低于响应里的 `interval` 秒，否则 429。

### 1.7 网页端：用户确认设备码

```http
POST /v1/auth/device-code/approve      （需登录态）
{ "userCode": "ABCD-1234", "decision": "approve" }
```

响应 `200` `{ "status": "approved" }`。

---

## 2. 设备

### 2.1 列表

```http
GET /v1/devices
```

响应 `200`：

```json
{
  "devices": [
    {
      "id": "dev_a",
      "kind": "desktop",
      "name": "我的电脑",
      "platform": "win32",
      "online": true,
      "lastSeenAt": "2026-10-22T06:12:31Z",
      "appVersion": "0.2.1-rc.2",
      "createdAt": "2026-10-20T09:00:00Z"
    },
    {
      "id": "dev_b",
      "kind": "mobile",
      "name": "iPhone 15",
      "platform": "ios",
      "online": true,
      "lastSeenAt": "2026-10-22T06:11:58Z"
    }
  ]
}
```

- `online` = 最近 90 秒内有隧道心跳
- 只返回本账号设备（多用户隔离）

### 2.2 注册（桌面端登录后调用）

```http
POST /v1/devices
{
  "name": "我的电脑",
  "platform": "win32",
  "appVersion": "0.2.1-rc.2",
  "signPublicKey": "base64...",
  "ecdhPublicKey": "base64..."
}
```

响应 `201` `{ "device": { ... } }`。

错误：`409 conflict.device_name_taken`（同账号同平台同名仍存活）、`403 authz.device_quota_exceeded`。

### 2.3 重命名

```http
PATCH /v1/devices/dev_a
{ "name": "工作站" }
```

响应 `200` `{ "device": { ... } }`。

### 2.4 撤销

```http
DELETE /v1/devices/dev_a
```

响应 `204`。

副作用（同事务内）：
1. `devices.revoked_at = now()`
2. 该设备所有 `sessions` 置为 revoked
3. 服务端踢掉该设备的隧道连接
4. 写审计日志 `device.revoke`

> 撤销后该设备的 access/refresh 立即失效。

---

## 3. 隧道（桌面端）

### 3.1 建立连接

```
WSS /v1/tunnel
Header: Authorization: Bearer <access_token>
```

连接后第一条消息必须是注册帧：

```json
{ "t": "register", "deviceId": "dev_a", "protocol": 1 }
```

服务端确认：

```json
{ "t": "registered", "deviceId": "dev_a", "heartbeatSec": 25, "maxInflight": 32 }
```

### 3.2 帧类型

| t | 方向 | 说明 |
|---|---|---|
| `ping` / `pong` | 双向 | 心跳（25 秒） |
| `req` | 服务端→桌面 | HTTP 请求转发 |
| `res` | 桌面→服务端 | HTTP 响应 |
| `wsopen` | 服务端→桌面 | 请求建立 WebSocket 代理 |
| `wsdata` | 双向 | WebSocket 帧数据 |
| `wsclose` | 双向 | 关闭 WebSocket |
| `offline` | 桌面→服务端 | 主动下线 |

HTTP 请求帧：

```json
{
  "t": "req",
  "id": "r_001",
  "method": "GET",
  "path": "/api/session/list",
  "headers": { "accept": "application/json" },
  "body": null
}
```

响应帧（支持分块）：

```json
{
  "t": "res",
  "id": "r_001",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "eyJzZXNzaW9ucyI6W119",
  "more": false
}
```

### 3.3 约束

- 单连接并发未完成请求 ≤ 32
- `path` 必须匹配白名单：`/`、`/api/*`、`/assets/*`、`/favicon*`、`/manifest*`
- 禁止：`/connect`、`/api/pair/*`、`/api/plugin-manager/*`、`/api/update/*`
- 单帧 ≤ 1 MiB；超限断开连接
- 无心跳 90 秒 → 服务端标记离线并关闭

---

## 4. 设备 UI 代理（手机端）

```
GET /t/<deviceId>/<path>
```

- 服务端校验：当前账号拥有该 deviceId 且未撤销、设备在线
- 通过隧道转发到桌面端本地 DSH，回传响应
- 未登录：`302` 跳转登录页
- 设备离线：`503` + 友好页面（JSON 请求返回 `503` 错误体）

**URL 重写**：响应中的绝对路径 `/assets/...` 会被服务端改写为 `/t/<deviceId>/assets/...`，保证 Web UI 在子路径下正常加载。

> 手机 WebView 直接加载 `https://域名/t/<deviceId>/` 即得到完整 DSH Web UI。

---

## 5. 账号自助

### 5.1 修改密码

```http
POST /v1/auth/change-password
{ "currentPassword": "...", "newPassword": "..." }
```

响应 `204`；成功后撤销该账号**除当前会话外**的全部会话。

### 5.2 忘记密码

```http
POST /v1/auth/forgot-password
{ "email": "..." }
```

响应恒为 `202`（防用户枚举），实际行为：
- 若邮箱存在：发送重置链接（`https://域名/reset?t=<token>`），令牌 30 分钟有效
- 若不存在：静默丢弃

### 5.3 重置密码

```http
POST /v1/auth/reset-password
{ "token": "...", "newPassword": "..." }
```

响应 `204`；撤销全部会话。

---

## 6. 账号信息

```http
GET /v1/account
```

```json
{
  "account": {
    "id": "acc_...",
    "email": "me@example.com",
    "displayName": "测试用户",
    "emailVerified": true,
    "createdAt": "2026-10-20T09:00:00Z",
    "limits": { "desktopDevices": 20, "mobileDevices": 10 }
  },
  "usage": { "desktopDevices": 2, "mobileDevices": 1 }
}
```

---

## 7. 错误码总表

| code | HTTP | 说明 |
|---|---|---|
| `request.invalid` | 400 | 参数校验失败 |
| `request.too_large` | 413 | 请求体超限 |
| `auth.invalid_credentials` | 401 | 邮箱或密码错误 |
| `auth.token_expired` | 401 | access token 过期 |
| `auth.token_invalid` | 401 | 令牌无效 |
| `auth.token_reuse` | 401 | refresh 被复用（已撤销全部会话） |
| `auth.device_code_pending` | 202 | 设备码等待确认 |
| `auth.device_code_denied` | 403 | 用户拒绝 |
| `auth.device_code_expired` | 410 | 设备码过期 |
| `authz.forbidden` | 403 | 跨账号访问 |
| `authz.device_quota_exceeded` | 403 | 设备数超限 |
| `authz.account_suspended` | 403 | 账号被停用 |
| `conflict.email_taken` | 409 | 邮箱已注册 |
| `conflict.device_name_taken` | 409 | 同平台设备重名 |
| `not_found.device` | 404 | 设备不存在 |
| `rate_limit.exceeded` | 429 | 限流 |
| `tunnel.device_offline` | 503 | 设备不在线 |
| `tunnel.path_denied` | 403 | 路径不在白名单 |
| `internal.error` | 500 | 服务端异常 |

---

## 8. 调用示例

### 8.1 手机端完整流程

```bash
# 1) 注册
curl -sX POST https://dsh.example.com/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"**********","displayName":"测试用户"}'

# 2) 登录（同时注册手机设备）
curl -sX POST https://dsh.example.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{
    "email":"me@example.com","password":"**********",
    "clientType":"mobile",
    "device":{"name":"iPhone 15","platform":"ios",
              "signPublicKey":"<b64>","ecdhPublicKey":"<b64>"}}'

# 3) 拉设备列表
curl -s https://dsh.example.com/v1/devices \
  -H "authorization: Bearer $ACCESS"

# 4) 打开设备 UI（浏览器/WebView）
#    https://dsh.example.com/t/<deviceId>/
```

### 8.2 桌面端完整流程

```bash
# 1) 申请设备码
curl -sX POST https://dsh.example.com/v1/auth/device-code \
  -H 'content-type: application/json' \
  -d '{"deviceName":"我的电脑","platform":"win32"}'
# → 打开 verificationUrl，输入 userCode 并登录

# 2) 轮询
curl -sX POST https://dsh.example.com/v1/auth/device-token \
  -H 'content-type: application/json' -d '{"deviceCode":"dc_..."}'

# 3) 注册设备
curl -sX POST https://dsh.example.com/v1/devices \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"name":"我的电脑","platform":"win32",
       "signPublicKey":"<b64>","ecdhPublicKey":"<b64>"}'

# 4) 建立隧道（插件内用 ws 库）
#    wss://dsh.example.com/v1/tunnel  + Bearer $ACCESS
```
