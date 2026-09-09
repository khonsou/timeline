FROM node:22.19.0-bookworm-slim

WORKDIR /app

# 从仓库根目录安装 workspace，确保 @timeline/core 软链存在。
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace @timeline/server --include-workspace-root=false

# core 以 .ts 源码直引，必须保留在 workspace 软链指向的真实路径下。
COPY packages/core packages/core
COPY packages/server packages/server

ENV NODE_ENV=production
ENV API_PORT=8787
ENV BOARD_DB=/data/boards.sqlite

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8787
CMD ["node", "packages/server/index.mjs"]
