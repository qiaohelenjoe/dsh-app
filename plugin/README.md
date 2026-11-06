# dsh-mobile-tunnel · 安装与登录

DSH 桌面端插件：账号设备码登录 → 注册设备 → 出站 WSS 隧道 → 把手机 `/t/<deviceId>/*` 请求转发到本机 DSH。

## 前置（只需一次）

插件源码在本仓库的 `plugin/` 目录，`package.json` 的 `main/exports` 指向构建产物 `dist/index.js`；安装前先构建：

```bash
cd plugin && npm install && npm run build
```

> **不要**用 `dsh plugin --profile desktop ...` 安装：DSH 桌面端的 `desktop` profile 由 Electron 专属管理，CLI 会直接报
> `profile "desktop" is managed exclusively by the Electron application`。

## 安装方式一：DSH 设置页「插件」（推荐）

1. 打开 DSH → 设置 → **插件 / Plugins**（`dsh-client-ui-settings-plugins`）。
2. 选择安装，填入本地绝对路径（本仓库 `plugin/` 目录的绝对路径）：
   ```
   <本仓库绝对路径>\plugin
   ```
   （插件管理器支持本地绝对路径；安装后会自动把 `dsh-mobile-tunnel` 加入 profile 的 `dsh.profile.bundles`。）
3. 按提示重启 DSH。

## 安装方式二：npm 包（插件市场同款）

插件已发布为 npm 包 `dsh-mobile-tunnel`，也可以在 **设置 → 插件** 里直接填包名安装：

```bash
# 仅查看包内容（不会安装）
npm view dsh-mobile-tunnel
```

装完重启 DSH。`web` profile 可用 `dsh plugin --profile web add dsh-mobile-tunnel`；`desktop` profile 仍按上面的设置页方式安装。

## 安装方式三：手工写入 profile（UI 不支持本地路径时）

先**完全退出 DSH**，并备份 profile：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$profile\package.json" "$profile\package.json.bak-$(Get-Date -Format yyyyMMdd_HHmmss)"
Copy-Item "$profile\pnpm-lock.yaml" "$profile\pnpm-lock.yaml.bak-$(Get-Date -Format yyyyMMdd_HHmmss)"
```

编辑 `$profile\package.json`，做两处修改：

```jsonc
{
  "dependencies": {
    // ...原有依赖
    "dsh-mobile-tunnel": "file:<本仓库绝对路径>\\plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...原有 bundles
        "dsh-mobile-tunnel"
      ]
    }
  }
}
```

然后在 profile 目录安装依赖：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

最后启动 DSH。

## 登录

- 设置页出现「账号」卡片：点登录 → 浏览器打开 `https://dsh.hbzxht.com/activate` → 确认 → 卡片变「已登录 · 在线」。
- 若卡片未出现（宿主设置 API 版本差异），用兜底脚本（在仓库 `plugin/` 目录执行）：
  ```powershell
  node scripts/login.mjs --server https://dsh.hbzxht.com --name "我的电脑"
  ```
  浏览器确认后凭据写入 `$DSH_HOME\mobile-tunnel.json`（或 `~/.dsh/mobile-tunnel.json`），重启 DSH 后插件 autostart 自动上线。
- PC 端「移动端」面板的登录走 `POST /v1/auth/panel-login`（网页会话，不登记设备），会话存 `~/.dsh/dsh-mobile-account-panel.json`，重启 DSH 不需要重新登录。

## 验证

- 手机 App 登录同一账号 → 设备列表出现该电脑（`kind=desktop`、在线）。
- `https://dsh.hbzxht.com/v1/devices` 可见设备；手机点设备打开 `/t/<deviceId>/`。

## 移动端文件面板（1.1.0+）

手机 App 的右侧面板里，官方「工作区文件」入口由本插件接管，点开是自己的文件面板：

- **树形浏览**：每层缩进、按需加载（点开目录才请求该层），只允许浏览当前会话的工作区
- **多页签**：根页签「工作区文件」+ 每个文件一个预览页签，`×` 关闭
- **预览**：Markdown 渲染、JSON 美化、代码高亮 + 行号、图片点击放大；可执行文件/压缩包/媒体等二进制不可预览（点击无反应）
- **仅移动端生效**：桌面端不挂载、不插节点，也没有悬浮按钮

数据来源是插件自己在 DSH 本机 Web 服务上注册的只读接口：

```
GET /plugins/dsh-mobile-tunnel/fs-roots       当前会话工作区
GET /plugins/dsh-mobile-tunnel/fs?path=<绝对路径>   列目录（越界 403）
GET /plugins/dsh-mobile-tunnel/fs-file?path=<绝对路径>  读文件
```

排错：客户端会把关键步骤自报到宿主日志 `~/.dsh/dsh-mobile-tunnel-diag.log`
（`POST /plugins/dsh-mobile-tunnel/diag`），日志里带面板版本号。

> 改动这部分后必须 `npm run build` + `pnpm install`（profile）+ 重启 DSH；
> 宿主新增路由只在启动时注册，只重启不重装仍是旧版。
## 卸载 / 回滚

- UI：设置 → 插件 → 卸载 `dsh-mobile-tunnel`，重启。
- 手工：退出 DSH，删除 `package.json` 里的依赖与 bundles 条目，`pnpm install`，或用备份覆盖后 `pnpm install`。

## 已知限制

- 文件面板只预览文本与图片；可执行文件、压缩包、PDF/Office、音视频、字体等二进制点击无反应（有意为之）。

- 设置页卡片挂载依赖 DSH 宿主未公开的 UI API，已做特性检测；未挂载时用兜底登录脚本。
- 插件私钥当前保存在 0600 权限的凭据文件中（系统凭据管理器接入为后续强化项）。
- 若插件加载失败导致 DSH 无法启动：用上面的 profile 备份覆盖 `package.json`，`pnpm install` 后重启。
