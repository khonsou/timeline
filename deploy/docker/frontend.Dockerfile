FROM node:22.19.0-bookworm-slim AS builder

ARG BASE_PATH=/aVoSaywtHjXCA

WORKDIR /app

# 前端同样从仓库根目录安装 workspace，构建时需要 @timeline/core。
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace @timeline/web --include-workspace-root=false

COPY packages/core packages/core
COPY web web
ENV VITE_BASE_PATH=${BASE_PATH}/
RUN npm run build -w @timeline/web

FROM nginx:1.27-alpine

ARG BASE_PATH=/aVoSaywtHjXCA

COPY deploy/docker/frontend.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html
RUN sed -i "s|__BASE_PATH__|${BASE_PATH}|g" /etc/nginx/conf.d/default.conf
