module.exports = {
  apps: [
    {
      name: "websmiths-chatapp",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3000,
        DATABASE_URL: process.env.DATABASE_URL || "file:./prod.db",
        ADMIN_EMAILS: process.env.ADMIN_EMAILS || "",
        UPLOAD_DIR: process.env.UPLOAD_DIR || "./uploads",
        TRUST_PROXY: "1"
      },
      max_memory_restart: "300M",
      error_file: "logs/error.log",
      out_file: "logs/output.log",
      time: true
    }
  ]
};
