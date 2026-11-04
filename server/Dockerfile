# DSH 账号服务镜像（多阶段构建）
# 构建上下文：server/
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY data ./data
COPY public ./public
# 迁移与静态文件路径（与 defaultMigrationsDir / public 读取保持一致）
ENV MIGRATIONS_DIR=/app/migrations
USER node
EXPOSE 8787
# 启动前自动执行数据库迁移（等价于 npm run migrate），再启动服务
ENTRYPOINT ["sh", "-c", "node dist/db/cli.js migrate && exec node dist/index.js"]
