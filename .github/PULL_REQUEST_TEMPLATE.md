# Pull Request

## 变更内容

<!-- 说明改了什么、为什么改，关联的 issue 编号（如 #12） -->

## 验证方式

<!-- 贴出你实际跑过的命令与结果；UI 改动请附截图或录屏 -->

## 检查清单

- [ ] 服务端：`cd server && npm run typecheck && npm run test`
- [ ] 插件：`cd dsh-mobile-tunnel && npm run typecheck && npm run test:unit && npm run check:client && npm run build`
- [ ] 移动端：`cd mobile && flutter analyze && flutter test`
- [ ] 适配层（如改动）：`cd mobile-adapt && npm test`
- [ ] 没有提交任何密钥、证书、口令、生产服务器地址
- [ ] 文档同步更新（`AGENTS.md`、`README.md`、`docs/` 相关部分）
- [ ] 数据库变更只新增幂等迁移（`server/migrations/NNNN_*.sql`）
