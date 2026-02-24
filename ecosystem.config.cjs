module.exports = {
  apps: [
    {
      name: "babynote-service",
      // 直接执行 node，不再通过 cmd/bat，这是隐藏窗口的关键
      script: "server/index.js", 
      cwd: "E:\\projects\\babynote",
      // 这里的 env 对应你之前在 .bat 里的 set TZ=Asia/Shanghai
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai" 
      },
      watch: false,
      autorestart: true,
      // 限制内存占用，如果超过 500M 自动重启（可选）
      max_memory_restart: "500M",
      // 日志存放位置，这样即便没有窗口，你也能去这里看日志
      error_file: "E:\\projects\\babynote\\logs\\err.log",
      out_file: "E:\\projects\\babynote\\logs\\out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
}