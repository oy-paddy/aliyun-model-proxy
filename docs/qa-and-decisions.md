# Q/A 与方案决策记录

本文记录本地 DashScope 反代服务的需求讨论、关键 Q/A、方案选择和最终共识，方便后续继续维护。

## 1. 初始需求

用户有多个 DashScope Anthropic 兼容模型 ID，希望对外只暴露一个固定 URL 和一个代理 key。

上游地址：

```text
https://dashscope.aliyuncs.com/apps/anthropic
```

典型免费额度耗尽错误：

```json
{
  "request_id": "xxx",
  "code": "AccessDenied",
  "message": "The free tier of the model has been exhausted. If you wish to continue access the model on a paid basis, please disable the \"use free tier only\" mode in the management console."
}
```

判断条件：

```text
HTTP 状态码 = 403
code = AccessDenied
message 包含 free tier 和 exhausted
```

最终目标：

1. 客户端只配置一个本地代理 URL。
2. 客户端只使用一个代理 key。
3. 真实 DashScope API Key 不暴露给客户端。
4. 模型进入冷却时自动切换，不需要手动改 model。

## 2. 技术选型

### Q：用什么框架搭建？

A：用户指定使用 Hono.js。

最终方案：

```text
Node.js + TypeScript + Hono.js
```

原因：

- 项目小，Hono 足够轻量。
- Node 20+ 原生支持 `fetch` 和 Web Stream。
- 适合做 Anthropic 兼容 HTTP 反代。

## 3. 项目位置

### Q：放在哪里？

A：单独新建项目，不放到原 uni-app 项目里。

最终路径：

```text
proxy-server
```

## 4. 对外接口

### Q：本地对外 URL 是什么？

A：默认根据 `.env` 的 `PORT` 决定。

当前给 Pi CLI 使用的配置：

```env
PORT=3300
PROXY_API_KEY=sk-001
```

本地 URL：

```text
http://localhost:3300
```

Anthropic Messages 接口：

```text
http://localhost:3300/v1/messages
```

客户端请求头二选一：

```http
Authorization: Bearer sk-001
```

或：

```http
x-api-key: sk-001
```

## 5. 代理是否修改 Prompt

### Q：代理有没有加提示词、改 system 或 messages？

A：没有。

当前代理只修改请求体里的：

```json
"model"
```

不会修改：

```text
system
messages
tools
tool_choice
thinking
max_tokens
temperature
任何 prompt 内容
```

Pi CLI 中模型回答“我是 Claude，由 Anthropic 开发”不代表代理加了提示词。更可能来自：

1. Pi CLI 自己的系统提示词和代理框架上下文。
2. DashScope Anthropic 兼容接口下模型的身份回答习惯。

## 6. 单个真实 key + 多模型阶段

### Q：最早版本怎么切换？

A：最早版本只有一个真实 DashScope key，多个 `MODEL_IDS`。现在即使只有一个真实 key，也统一写在 `DASHSCOPE_API_KEYS` 里。

配置示例：

```env
DASHSCOPE_API_KEYS=sk-xxx
MODEL_IDS=qwen3.7-max,qwen-plus,qwen-max
```

切换逻辑：

1. 使用当前模型转发。
2. 如果命中免费额度耗尽 403，冷却这个模型。
3. 同一个请求改用下一个模型重试。
4. 所有模型都不可用时返回 `503`。

## 7. 多 Key + 多模型阶段

### Q：多 key 的情况下怎么切？

A：所有 key 共用同一组 `MODEL_IDS`。切换规则是 key 优先。

最终配置：

```env
DASHSCOPE_API_KEYS=sk-key-1,sk-key-2,sk-key-3
MODEL_IDS=model-a,model-b,model-c
```

最终切换规则：

1. 优先使用当前 key。
2. 当前 key 下某个模型触发免费额度耗尽 403，只冷却这个 `key + model` 组合。
3. 继续尝试当前 key 下的下一个模型。
4. 只有当前 key 下所有模型都不可用，才切换到下一个 key。
5. 所有 key+model 组合都不可用时返回 `503`。

这是本项目最重要的调度共识。

## 8. 冷却时间

### Q：冷却多久？

A：用户确认冷却时间为 1 个月。

最终配置：

```env
MODEL_COOLDOWN_SECONDS=2592000
```

说明：

```text
2592000 秒 = 30 天
```

## 9. 状态持久化选择

### Q：为什么引入持久化状态？

A：服务重启后不能丢失冷却状态。

如果只用内存，重启后所有模型都会重新变成可用，可能继续打到已经进入免费额度冷却期的 key+model。

### Q：选什么存储？

A：最终选 JSON 状态文件。

原因：

- 本地部署，不需要额外安装 MySQL/Postgres/Redis。
- 只有冷却状态和调度游标，不需要关系型查询能力。
- 一个文件即可持久化，适合本地工具。
- 避免 `better-sqlite3` 原生 binding 在 Windows 上安装或打包失败。
- 默认路径清晰，方便备份和检查。

最终配置：

```env
STATE_PATH=./data/proxy-state.json
```

## 10. 状态文件隐私原则

### Q：状态文件会存真实 DashScope key 吗？

A：不会。

状态文件只存：

```text
SHA-256(key)
```

也就是 `key_hash`。

真实 key 只存在 `.env` 里。

## 11. 状态文件结构

### Q：`modelState` 存什么？

A：每条记录对应一个 DashScope key 与 `MODEL_ID` 组合。

例如：

```env
DASHSCOPE_API_KEYS=key1,key2
MODEL_IDS=modelA,modelB,modelC
```

会生成：

```text
2 * 3 = 6 条 modelState 记录
```

字段详见：

```text
docs/state-file.md
```

### Q：`runtimeState` 存什么？

A：只存调度游标，不存 key、不存 prompt、不存错误详情。

当前记录类型：

```text
key_cursor
model_cursor:<key_hash>
```

含义：

- `key_cursor`：当前优先使用 `.env` 里第几个 `DASHSCOPE_API_KEYS` 条目。
- `model_cursor:<key_hash>`：某个 key 下当前优先使用 `MODEL_IDS` 里的第几个模型。

## 12. 游标策略共识

### Q：为什么 `model_cursor` 不直接存 modelId？

A：当前版本先按顺序来，使用游标绑定 `.env` 中的配置顺序。

共识：

1. 当前版本保持 `key_cursor` 和 `model_cursor:<key_hash>`。
2. 它们都依赖 `.env` 中 `DASHSCOPE_API_KEYS` 和 `MODEL_IDS` 的顺序。
3. 不要随便调整这两个列表的顺序。
4. 如果后续调整顺序，建议同时删除或重置 `data/proxy-state.json`。
5. 后续如果需要更稳，再升级为 `current_key_hash` 和 `current_model_id:<key_hash>`。

## 13. Pi CLI 接入

### Q：怎么让 Pi CLI 使用本地代理？

A：在 `~/.pi/agent/models.json` 增加本地 provider。

Provider 名称：

```text
local-dashscope-proxy
```

Base URL：

```text
http://127.0.0.1:3300
```

API 类型：

```text
anthropic-messages
```

代理 key：

```text
sk-001
```

同时在 `~/.pi/agent/settings.json` 设置默认 provider：

```text
defaultProvider = local-dashscope-proxy
defaultModel = qwen3.7-max
```

使用方式：

```bash
pi
```

或：

```bash
pi --provider local-dashscope-proxy --model qwen3.7-max
```

## 14. 清理旧 Pi Provider

### Q：为什么删除 `dashscope` provider 下的两个模型？

A：用户希望 Pi CLI 里不再出现旧的直接 DashScope provider：

```text
qwen3.7-max [dashscope]
qwen3.7-max[1M] [dashscope]
```

已删除 `~/.pi/agent/models.json` 中的 `dashscope` provider，保留本地代理 provider。

## 15. 当前模型列表

当前 `MODEL_IDS` 共 14 个：

```text
qwen3.7-max-2026-06-08
qwen3.7-plus-2026-05-26
qwen3.7-plus
qwen3.7-max-preview
qwen3.7-max-2026-05-17
qwen3.7-max
qwen3.7-max-2026-05-20
qwen3.6-27b
qwen3.6-max-preview
qwen3.6-flash
qwen3.6-35b-a3b
qwen3.6-flash-2026-04-16
qwen3.6-plus
qwen3.6-plus-2026-04-02
```

数据库已同步初始化这些模型状态。

## 16. 请求日志

### Q：Hono 是否打印请求日志？

A：已增加统一请求日志中间件。

日志示例：

```text
[request] GET /health status=200 duration=2ms bytes=- proxyKey=- model=- attempts=- ua="curl/8.7.1"
```

成功代理 `/v1/messages` 时会打印：

```text
proxyKey=<key hash 前缀>
model=<实际使用的模型 ID>
attempts=<本次请求尝试次数>
```

不会打印：

```text
Authorization
x-api-key
DASHSCOPE_API_KEYS
请求 body
messages / prompt
```

## 17. 当前文档

使用说明：

```text
docs/usage.md
```

状态文件说明：

```text
docs/state-file.md
```

Q/A 与方案决策记录：

```text
docs/qa-and-decisions.md
```

## 18. OpenAI Chat Completions 入口

### Q：为什么又增加 OpenAI 协议入口？

A：Pi CLI 的官方 DeepSeek provider 使用 `openai-completions`，说明 Pi 对 OpenAI Chat Completions 兼容链路支持成熟。为了让本地代理也能按同一类方式接入 Qwen，新增：

```text
POST /v1/chat/completions
GET /v1/models
```

上游默认使用：

```text
OPENAI_UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

当前保留原有 Anthropic Messages 入口：

```text
POST /v1/messages
```

两条链路共用同一套 DashScope key 池、模型池、冷却状态和免费额度耗尽切换逻辑。

服务端是反代转发，不需要安装 `openai` SDK；`openai` SDK 只适合客户端调用代理时使用。
