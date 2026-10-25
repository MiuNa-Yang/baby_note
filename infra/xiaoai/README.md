# BabyNote XiaoAI voice gateway

This directory runs the locally checked-out `mi-voice-agent` as a Docker service and points it at the BabyNote Agent on the Windows host.

BabyNote exposes the Agent at `POST /v1/chat/completions` and supports both normal JSON responses and OpenAI-compatible SSE when `stream: true` is sent. Requests may set `reasoning_effort` to `none`, `low`, `medium`, `high` or `max`; the local qwen default is `none` for short voice turns.

## Setup

1. Start the BabyNote server so `http://127.0.0.1:3000/v1/models` is available.
2. Copy `.env.xiaoai.example` to `.env.xiaoai.local`.
3. Fill in `MI_USER`, `MI_PASS_TOKEN` and `MI_DID`.
4. Optionally set `OPENCLAW_TOKEN` to the same value as `BABYNOTE_AGENT_API_TOKEN` in the BabyNote server environment. It can be left empty for a first LAN-only test, but a token is recommended once the gateway is reachable from other devices.
5. Run:

   `powershell -ExecutionPolicy Bypass -File infra/xiaoai/start.ps1`

The L05C/L05B MIoT TTS action starts as `5/3`. If the speaker is silent, verify the model in MiOT and adjust `TTS_SIID`/`TTS_AIID`.

`STREAM_RESPONSE=true` enables sentence-level streaming. If playback overlaps or the speaker only says the first sentence, set it to `false`.

The gateway now polls raw Xiaomi conversation records every 100ms (`MI_POLL_INTERVAL`) and also calls native `abortXiaoAI()` from the MiGPT hook. This reduces the race where XiaoAi speaks before the external Agent. Because the Xiaomi cloud API is polled after speech recognition, this remains best-effort; guaranteed zero-overlap takeover requires device-side control.

## Useful commands

```powershell
# Follow gateway logs
docker compose --env-file infra/xiaoai/.env.xiaoai.local -f infra/xiaoai/docker-compose.yml logs -f

# Stop the gateway
powershell -ExecutionPolicy Bypass -File infra/xiaoai/stop.ps1
```

The gateway's MCP port is mapped to `127.0.0.1:3001` only. Do not expose it to the Internet.

The first adapter version runs the BabyNote Agent turn to completion and then emits the final answer as SSE chunks. This is protocol-compatible with the voice gateway; the next optimization can move streaming into the Ollama/tool loop itself.

The XiaoAI OpenAI-compatible endpoint defaults to local Ollama `qwen3.5:9b` with thinking disabled (`BABYNOTE_LOCAL_THINK=none`). If the local turn fails, it falls back to `gpt-5.6-luna` through the dedicated BabyNote MCP runtime. Set `BABYNOTE_AGENT_ROUTE=cloud-first` to make Luna primary, `BABYNOTE_AGENT_ROUTE=local-only` to disable cloud fallback, or set `BABYNOTE_CLOUD_REASONING_EFFORT=medium` if you prefer more cloud reasoning at the cost of latency.

The cloud route requires the dedicated Codex runtime created by `infra/setup-agent.ps1`, normally at `%LOCALAPPDATA%\babynote-agent\codex-home`. It uses `gpt-5.6-luna` with low reasoning by default, so fallback turns are slower than direct Ollama but have stronger intent and tool selection. The cloud timeout is 45 seconds by default; override it with `BABYNOTE_CLOUD_TIMEOUT_MS` if your network is slower.

The Agent also has dedicated read tools for phrases such as “宝宝上次喝奶啥时候” and “宝宝什么时候醒、醒了多久”. These return structured Beijing time plus elapsed minutes, instead of asking the summary tool to infer an event time.

## Local model evaluation

The local model has a data-driven regression harness covering writes, reads, relative time, multi-item solids, summaries, reminders, safety and follow-up context:

```powershell
npm run agent:eval-harness
$env:BABYNOTE_EVAL_REPEATS = "3"; npm run agent:eval-harness
```

The harness uses an isolated in-memory database per case, so it does not alter the real BabyNote records.

## Multi-turn context

The XiaoAi gateway sends a stable `user` value for each speaker device. The BabyNote server uses that value as the conversation key and keeps recent `user`/`assistant` turns in memory, so follow-up questions can refer to the previous answer. By default, the context keeps the latest 12 messages and expires after 30 minutes of inactivity. A server restart clears the in-memory context.

These limits can be overridden with environment variables:

- `BABYNOTE_AGENT_SESSION_TTL_MS`
- `BABYNOTE_AGENT_MAX_HISTORY_MESSAGES`
- `BABYNOTE_AGENT_HISTORY_TOKEN_BUDGET` (default `6000`, for the 32K local model context)
- `BABYNOTE_AGENT_MAX_SESSIONS`

If a client sends a complete OpenAI `messages` history, that history takes precedence over the server-side cache.
