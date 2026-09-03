import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// API server 端口：与 scripts/dev.mjs 同源（环境变量 API_PORT，默认 8787）
const API_TARGET = `http://localhost:${process.env.API_PORT || 8787}`

// https://vite.dev/config/
export default defineConfig({
  base: '/', // v15 history 路由（/b/:id）：资源必须绝对路径，否则深层路径下 404
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: {
      // v15 多用户看板：/api 反代到 node server（server/index.mjs）
      '/api': API_TARGET,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
