# 贡献指南

感谢你愿意参与 `dsh-app`。这是一个 DeepSeek Harness 的移动端远程控制项目：账号服务 + 桌面出站隧道插件 + Flutter Android 壳。

## 环境要求

| 工具 | 版本 |
|---|---|
| Node.js | ≥ 22 |
| npm | ≥ 10 |
| Flutter | 3.24.x（Dart ≥ 3.4） |
| PostgreSQL | 16（测试用，端口 55432） |
| Docker | 可选，用于本地起测试库与部署验证 |

## 开发命令

```bash
# 服务端（测试需要本地 PostgreSQL：127.0.0.1:55432，库 postgres/postgres）
cd server && npm install
npm run typecheck && npm run test
npm run migrate && npm run dev

# 桌面插件（单元测试与客户端 UI 检查不依赖数据库）
cd dsh-mobile-tunnel && npm install
npm run typecheck && npm run test:unit && npm run check:client && npm run build

# 移动端
cd mobile && flutter pub get
flutter analyze && flutter test

# 窄屏适配层
cd mobile-adapt && npm install && npm test
```

测试库可以用 Docker 起：

```bash
docker run -d --name dsh-pg-test -p 55432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
  postgres:16-alpine
```

## 提交规范

- 提交信息用中文或英文均可，推荐 `type(scope): 简述`，type 取 `feat/fix/docs/chore/refactor/test`；
- 一次提交只做一件事，不把无关改动混在一起；
- 代码风格：TypeScript strict、ESM、相对导入带 `.js` 后缀；Flutter 以 `flutter analyze` 为准。

## Pull Request

1. 从 `main` 切分支：`git checkout -b feat/your-change`；
2. 完成改动并**本地跑通**与改动相关的验证命令（见上）；
3. 提交 PR，模板里写清：改了什么、怎么验证的、风险点；UI 改动附截图；
4. CI（`.github/workflows/ci.yml`）必须通过；
5. 由维护者 review 并合并，合并后自动删除分支。

## 红线

- **不要提交任何密钥、证书、口令、Token、生产服务器 IP**；本地配置放 `.env` / `key.properties`（均已忽略）；
- 数据库变更只能新增 `server/migrations/NNNN_*.sql`，且必须幂等（`IF NOT EXISTS`）；
- 不要为“让测试通过”修改断言；优先修实现；
- 不要提交构建产物以外的临时文件、截图缓存、编排工具的本地记录。

## 安全问题

发现安全漏洞请**不要**开公开 issue，按 [SECURITY.md](SECURITY.md) 的方式私下上报。
