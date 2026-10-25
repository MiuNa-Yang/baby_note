# BabyNote 微信 Agent 部署

## Agent 看板与自动启动

### 当前模型：本地 GPT 中转站

当前 GPT 路径支持自主多轮调用现有 BabyNote 工具：多个查询、多个明确要求的记录动作、记录后查询均可。每次最多 12 轮工具请求、24 次工具调用，总超时沿用模型配置，避免无限循环。相同消息中相同写入参数去重，每个动作使用独立幂等标识；失败结果传回模型说明部分完成情况。看板保留全部工具步骤。旧 `legacy` 的本地小模型仍保留单工具限制，Codex/MCP 路径支持多个动作。

工具还包括 `get_baby_profile`（生日、最新测量及食材状态）、`record_growth`（体重公斤/身长厘米，可同时记录）、`get_growth_history`（历史测量）、`list_solid_foods`、`set_food_status`（批量登记或修改食材排敏状态）。成长数据沿用现有体重/身高记录，食材状态沿用辅食页面；存量排敏清单无需克数，不生成进食记录，也不推断同类食材或混合食品组成成分的状态。体重单位不明先询问，明确的斤按除以2转换为公斤。修改工具代码后需重启 BabyNote 主服务，小爱 API 与主服务同进程。

小爱和微信统一读取 `infra/agent-model.json`：默认通过 `http://127.0.0.1:8787/v1/chat/completions` 调用 `gpt-5.6-luna`，显式传入 `reasoning_effort=low`。支持 none、low、medium、high、xhigh、max；小爱 API 可按请求覆盖，微信使用配置默认值。接口按 [OpenAI Chat Completions 工具调用格式](https://developers.openai.com/api/reference/cli/resources/chat) 传递工具及 `tool_call_id`，由 BabyNote 执行工具。

密钥在服务端按配置从 `C:/ai/codex-gateway/config/.env` 的 `GATEWAY_API_KEY_TEST` 读取，不复制到前端或仓库。中转失败会明确报错，不绕过中转直连 Codex；将 provider 改为 `legacy` 可恢复此前的本地模型/云端路由。配置每次请求读取，变更无需重启。现有业务工具、北京时间确认、辅食克数规则和看板采集共用原实现。

Agent 看板通过 `http://localhost:3000/agent` 直接访问，不在底部导航显示入口。看板显示小爱和微信的请求历史、完整回复、模型与思考深度、调用耗时、回退原因、工具输入输出及 Token 用量。支持按宝宝、最近 1/7/30/90 天、渠道、状态和正文筛选，每 15 秒刷新。

历史保存于现有 SQLite 的 `agent_requests` 表，从启用采集后开始；旧日志未保存完整正文，不能补全。Token 是供应方实际返回的输入/输出数，包含已返回结果的重试；超时未返回用量时标记不完整，不估算。看板沿用 BabyNote 的局域网访问范围，请求正文和工具结果会持久保存。

运行 `powershell -ExecutionPolicy Bypass -File infra/install-agent-persistence.ps1`，将微信桥接作为 `babynote-agent` 加入现有 PM2，并保存恢复列表。它沿用 BabyNote 的 Windows 登录自启动机制，异常退出 5 秒后重启。停止使用 `pm2 stop babynote-agent`，恢复使用 `pm2 restart babynote-agent`。不要同时手动启动第二个微信桥接进程。

小爱 Agent API 与 BabyNote 主服务同进程；语音网关继续由 Docker 的 `unless-stopped` 策略恢复（需要 Docker 启动），Ollama 使用已有 `BabyNote-Ollama-KeepAlive` 登录守护任务。

当前项目使用个人微信 ilink 通道，不要求安装企业微信。群聊只有以数字 `0` 开头的消息会进入 Agent；私聊不要求前缀。

## 一次性准备

1. 已构建的 Windows 程序位于 `infra/cc-connect/bin/cc-connect.exe`。需要重建时运行：

   `powershell -ExecutionPolicy Bypass -File infra/cc-connect/build-cc-connect.ps1`

2. 生成本机专用配置。脚本会从现有 SQLite 自动识别宝宝档案，也可用 `-BabyId` 显式指定：

   `powershell -ExecutionPolicy Bypass -File infra/setup-agent.ps1`

3. 如果还没有 ilink token，在手机微信中完成一次扫码：

   `infra\cc-connect\bin\cc-connect.exe weixin setup -config "$env:LOCALAPPDATA\babynote-agent\cc-connect.toml" -project babynote-agent`

4. 启动服务后把机器人加入目标微信群，在群里发送 `0 测试`。运行

   `infra\cc-connect\bin\cc-connect.exe sessions list --data-dir "$env:LOCALAPPDATA\babynote-agent\cc-data"`

   复制形如 `weixin:dm:123456@chatroom` 的会话标识，填入网页“设置 → 个人 Agent”。同时把运行配置中的 `allow_from` 从 `*` 收紧为允许使用的个人微信 ID，并把 `chat_id` 设为目标群 ID。

## 启停与日志

- 启动：`powershell -ExecutionPolicy Bypass -File infra/start-agent.ps1`
- 停止：`powershell -ExecutionPolicy Bypass -File infra/stop-agent.ps1`
- 日志：`%LOCALAPPDATA%\babynote-agent\logs`

网页保存 Agent 设置后，每日辅食提醒会同步到 cc-connect。个人微信 ilink 存在发送频率限制；当前配置按低频家庭场景限制为每天 8 条，正式使用前建议完成一天真机测试。

## BabyNote 专用本地 Agent 与云端兜底

以下为 `provider=legacy` 时的旧路由。微信消息进入 BabyNote 专用 Agent，向 Ollama 提供固定育儿指令和 BabyNote 工具；所有非空消息都交给模型判断，闲聊正常简短回复，涉及宝宝数据时才调用工具。数据操作由程序注入消息 ID 和发送者信息。模型不可用、超时或执行失败时回退到 Codex。首次配置示例：

`powershell -ExecutionPolicy Bypass -File infra/setup-agent.ps1 -LocalModel "qwen3.5:9b" -FallbackModel "gpt-5.6-luna"`

路由只记录所用模型、耗时和回退原因，不记录微信正文。运行日志位于 `%LOCALAPPDATA%\babynote-agent\logs\model-router.log`。

下载模型后可运行真实的隔离数据库验收，不会修改现有宝宝数据：

`npm run agent:eval-local`

查询日期不传时默认是今天；传 `date` 查询单日；传 `start_date` 和 `end_date` 查询包含首尾日期的范围，最多 31 天。

## Ollama 持久运行

Windows 上可安装用户级守护任务，让 Ollama 在登录后自动启动，异常退出后自动拉起，并预热 `qwen3.5:9b`：

`powershell -ExecutionPolicy Bypass -File infra/ollama/install-persistence.ps1 -Model "qwen3.5:9b"`

任务名为 `BabyNote-Ollama-KeepAlive`，日志位于 `%LOCALAPPDATA%\babynote-agent\logs`。如需移除自动守护：

`powershell -ExecutionPolicy Bypass -File infra/ollama/uninstall-persistence.ps1`
