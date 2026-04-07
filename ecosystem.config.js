module.exports = {
  apps: [
    {
      name: 'number-switcher',
      script: 'server.js',
      instances: 1,          // MUST be 1 — the in-memory queue doesn't support clustering
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      // Auto-restart config
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      // Logs
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Watch (disabled in production)
      watch: false,
    },
  ],
};
