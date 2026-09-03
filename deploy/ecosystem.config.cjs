// 拾光轴 · Timeline Board —— pm2 托管配置（v15 多用户看板 API server）
// 用法：pm2 start deploy/ecosystem.config.cjs && pm2 save
// 详细部署步骤见 docs/deployment.md
//
// ⚠ BOARD_SECRET 必须设置为固定随机串（ token 签名密钥）：
//    不设置则每次启动随机生成，server 重启后所有已发 token 失效（用户需重新输密码）。
//    生成：openssl rand -hex 32
module.exports = {
  apps: [
    {
      name: 'timeline-board-api',
      script: 'server/index.mjs',
      // node:sqlite 需要 Node ≥ 22.5（建议 24 LTS）；零 native 依赖，无需构建
      env: {
        API_PORT: 8787,
        // BOARD_SECRET: '换成 openssl rand -hex 32 生成的固定值',
        // BOARD_DB: '/var/lib/timeline-board/boards.sqlite', // 缺省 server/boards.sqlite
        // BOARD_TOKEN_HOURS: 12,   // token 有效期（小时）
        // BOARD_LOCK_SECONDS: 60,  // 同板连续 5 次密码失败锁定时长（秒）
      },
      // 单实例即可：node:sqlite 同步驱动 + WAL，看板量级无并发瓶颈
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      out_file: 'logs/api-out.log',
      error_file: 'logs/api-error.log',
      time: true,
    },
  ],
}
