import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// API server 端口：与 scripts/dev.mjs 同源（环境变量 API_PORT，默认 8787）
const API_TARGET = `http://localhost:${process.env.API_PORT || 8787}`
const configuredBase = process.env.VITE_BASE_PATH || '/'
const BASE_PATH =
  configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`
const API_PREFIX = BASE_PATH === '/' ? '' : `${BASE_PATH.replace(/\/$/, '')}/api`
const API_PROXY = API_PREFIX
  ? {
      '/api': API_TARGET,
      [API_PREFIX]: {
        target: API_TARGET,
        rewrite: (requestPath: string) => `/api${requestPath.slice(API_PREFIX.length)}`,
      },
    }
  : { '/api': API_TARGET }

// https://vite.dev/config/
export default defineConfig({
  base: BASE_PATH,
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: API_PROXY,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
