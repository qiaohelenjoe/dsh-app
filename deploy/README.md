# DSH 账号服务 · Docker Compose 一键部署

## 目录结构

```
deploy/
  docker-compose.yml          # postgres + dsh-account（自动迁移 + 健康检查）
  .env.example                # 复制为 .env 并填随机密钥
  nginx/example.com.conf      # 宿主机 nginx 站点模板（TLS + WSS + 安全响应头；替换域名后部署）
server/
  Dockerfile                  # Node 22 多阶段构建（构建 + 运行时）
```

## 本机一键部署（验证用）

```powershell
cd deploy
Copy-Item .env.example .env
# 修改 .env：POSTGRES_PASSWORD / AUTH_JWT_SECRET / AUTH_REFRESH_PEPPER 填随机值；
# 本机测试把 SERVER_PORT 改成 18787（避免占用）、PUBLIC_BASE_URL 改 http://127.0.0.1:18787
docker compose up -d --build
docker compose ps
curl.exe -s http://127.0.0.1:18787/healthz
```

预期：`docker compose ps` 中 db 为 healthy、server 为 healthy；`/healthz` 返回 200（数据库与 schema 版本均正常）。

停止并清理：

```powershell
docker compose down -v
```

## 生产服务器部署

前置：已安装 Docker + Compose（生产为 Docker 26 / Compose v2.27），nginx 已有 `*.hbzxht.com` 泛域名证书。

```bash
# 0) 备份 nginx 配置（发布前必须）
TS=$(date +%Y%m%d_%H%M%S)
tar czf /root/nginx-BACKUP-$TS.tar.gz /etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/snippets

# 1) 上传代码到 /opt/dsh-account（server/ 与 deploy/）
#    可用 tar 上传后在服务器解压，例如：
#    tar czf dsh-account.tar.gz server deploy -C <workspace>
#    scp dsh-account.tar.gz root@<生产服务器IP>:/tmp/ && ssh ... 'tar xzf /tmp/dsh-account.tar.gz -C /opt/dsh-account'

# 2) 生成 .env（随机密钥）
cd /opt/dsh-account/deploy
cp .env.example .env
sed -i "s|change-me-strong-random-password|$(openssl rand -hex 24)|" .env
sed -i "s|change-me-random-32-chars-secret|$(openssl rand -hex 32)|" .env
sed -i "s|change-me-random-pepper|$(openssl rand -hex 24)|" .env
chmod 600 .env

# 3) 启动（首次会构建镜像并自动跑迁移）
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8787/healthz

# 4) nginx 站点（从模板生成：替换域名与证书片段路径）
sed 's/example.com/dsh.hbzxht.com/g; s#/etc/nginx/snippets/ssl.conf#/etc/nginx/snippets/ssl-wildcard.conf#' \
  /opt/dsh-account/deploy/nginx/example.com.conf > /etc/nginx/conf.d/dsh.hbzxht.com.conf
/usr/local/nginx/sbin/nginx -t && /usr/local/nginx/sbin/nginx -s reload

# 5) 外网验证（健康检查只允许本机访问，外网应为 403）
curl -sI https://dsh.hbzxht.com/download
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.hbzxht.com/healthz   # 期望 403
curl -s http://127.0.0.1:8787/healthz                                    # 本机 200
```

## 手机 App 下载页

`dsh-account` 内置下载页，链接固定为 `https://dsh.hbzxht.com/download`（PC 端「移动端」面板的二维码就指向它）。

安装包放宿主机 `/opt/dsh-account/downloads/`（与 `deploy/` 同级；容器内只读挂载为 `/app/apk`），按版本命名：

```bash
# 正式版：dsh-mobile-<version>.apk；测试版：dsh-mobile-<version>-test.apk
scp dist/dsh-mobile-<version>.apk root@<生产服务器IP>:/opt/dsh-account/downloads/
```

- `/download`：手机友好的下载页，自动选**版本号最大**的正式版（没有正式版才用测试版）。
- `/download/latest.apk`：永远重定向到当前正式版，上传新包后无需改配置。
- nginx 站点整站反代到 Node（不要再加 `/download/` 静态 `alias`）。
- 上传后刷新页面确认版本号与大小；不需要重启容器（每次请求现读目录）。
- 这是该下载页的首次正式部署：正式版安装包统一以 `dsh-mobile-<version>.apk` 命名上传，页面只展示当前正式版。

## 回滚

```bash
cd /opt/dsh-account/deploy && docker compose down
rm -f /etc/nginx/conf.d/dsh.hbzxht.com.conf
/usr/local/nginx/sbin/nginx -t && /usr/local/nginx/sbin/nginx -s reload
# 如需恢复 nginx：tar xzf /root/nginx-BACKUP-<TS>.tar.gz -C /
# 数据在 docker volume dsh-account_db-data（down 不会删除；down -v 才删除）
```

## 常用运维

```bash
docker compose logs -f server          # 服务日志（含启动时 schema 校验）
docker compose exec db psql -U dsh -d dsh_account   # 进库
docker compose exec db pg_dump -U dsh dsh_account > backup-$(date +%F).sql  # 备份
```

## 环境变量

见 `.env.example`。生产必须：`AUTH_JWT_SECRET`（≥32）、`AUTH_REFRESH_PEPPER`（≥16）、`POSTGRES_PASSWORD` 为随机值；`ALLOW_TUNNEL_BEARER` 在 compose 中固定为 `false`（隧道必须使用一次性票据）。
