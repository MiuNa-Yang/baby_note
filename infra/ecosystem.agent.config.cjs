const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runtime = path.join(process.env.LOCALAPPDATA, 'babynote-agent');
const environment = {};
for (const line of fs.readFileSync(path.join(root, '.env.agent.local'), 'utf8').split(/\r?\n/)) {
  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) environment[match[1]] = match[2];
}
fs.mkdirSync(path.join(runtime, 'logs'), { recursive: true });
module.exports = { apps: [{
  name: 'babynote-agent',
  script: path.join(__dirname, 'cc-connect', 'bin', 'cc-connect.exe'),
  interpreter: 'none',
  args: ['-config', path.join(runtime, 'cc-connect.toml')],
  cwd: root,
  env: { ...environment, TZ: 'Asia/Shanghai' },
  autorestart: true,
  restart_delay: 5000,
  min_uptime: '10s',
  max_restarts: 100000,
  kill_timeout: 10000,
  out_file: path.join(runtime, 'logs', 'cc-connect-pm2.out.log'),
  error_file: path.join(runtime, 'logs', 'cc-connect-pm2.err.log'),
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
}] };
