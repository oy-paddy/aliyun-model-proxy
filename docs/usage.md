# 使用说明

这个项目是一个本地 DashScope Anthropic 兼容反代服务。客户端只需要配置一个本地 URL 和一个代理 key，真实 DashScope key 和模型池都放在服务端。

## 1. 安装依赖

```bash
pnpm install
```

运行时依赖不包含原生编译模块，Windows 上首次安装不需要额外安装 C++ 编译环境。

## 2. 配置 .env

复制配置模板：

```bash
cp .env.example .env
```

核心配置：

```env
PORT=3300

PROXY_API_KEY=sk-001

DASHSCOPE_API_KEYS=sk-key-1,sk-key-2,sk-key-3
UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
OPENAI_UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

MODEL_IDS=qwen3.7-max,qwen-plus,qwen-max
MODEL_COOLDOWN_SECONDS=2592000

STATE_PATH=./data/proxy-state.json
UPSTREAM_AUTH_MODE=authorization
CORS_ORIGIN=*
```

说明：

| 配置 | 说明 |
| --- | --- |
| `PORT` | 本地服务端口。你当前给 Pi CLI 用的是 `3300`。 |
| `PROXY_API_KEY` | 客户端调用本地代理时使用的 key。 |
| `DASHSCOPE_API_KEYS` | 多个真实 DashScope API Key，英文逗号分隔。 |
| `UPSTREAM_BASE_URL` | DashScope Anthropic 兼容接口上游地址。 |
| `OPENAI_UPSTREAM_BASE_URL` | DashScope OpenAI Chat Completions 兼容接口上游地址。 |
| `MODEL_IDS` | 所有 key 共用的模型 ID 列表，英文逗号分隔。 |
| `MODEL_COOLDOWN_SECONDS` | 触发免费额度耗尽后冷却多久。当前默认 `2592000` 秒，也就是 30 天。 |
| `STATE_PATH` | JSON 状态文件路径。用于保存冷却状态和调度游标。 |

## 3. 初始化状态文件

启动服务时会自动创建状态文件。

也可以手动初始化：

```bash
pnpm build
node dist/index.js
```

看到服务启动成功后按 `Ctrl+C` 停止即可。状态文件默认会生成在：

```text
data/proxy-state.json
```

状态文件结构见：

```text
docs/state-file.md
```

## 4. 启动服务

开发模式：

```bash
pnpm dev
```

生产模式：

```bash
pnpm build
pnpm start
```

启动成功后会看到类似日志：

```text
[proxy] listening on http://localhost:3300
[proxy] upstream base: https://dashscope.aliyuncs.com/apps/anthropic
[proxy] openai upstream base: https://dashscope.aliyuncs.com/compatible-mode/v1
[proxy] api keys loaded: 3
[proxy] models per key: 3
[proxy] applied model ids:
[proxy]   - qwen3.7-max
[proxy]   - qwen-plus
[proxy]   - qwen-max
[proxy] reminder: 请在 DashScope/百炼控制台为以上模型开启“模型用完即停”。
[proxy] state file: ./data/proxy-state.json
```

## 5. 客户端调用

本地代理地址：

```text
http://localhost:3300
```

Anthropic Messages 接口：

```text
http://localhost:3300/v1/messages
```

请求头可以用二选一：

```http
Authorization: Bearer sk-001
```

或：

```http
x-api-key: sk-001
```

测试请求：

```bash
curl http://localhost:3300/v1/messages \
  -H "Authorization: Bearer sk-001" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "client-model-will-be-overwritten",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "你好"
      }
    ]
  }'
```

请求体里的 `model` 会被代理覆盖成当前可用模型。

OpenAI Chat Completions 接口：

```text
http://localhost:3300/v1/chat/completions
```

OpenAI-compatible base URL：

```text
http://localhost:3300/v1
```

测试请求：

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Authorization: Bearer sk-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "client-model-will-be-overwritten",
    "messages": [
      {
        "role": "user",
        "content": "你好"
      }
    ],
    "stream": true
  }'
```

查看 OpenAI 风格模型列表：

```bash
curl http://localhost:3300/v1/models \
  -H "Authorization: Bearer sk-001"
```

本服务端只是反代转发，使用 Node 原生 `fetch` 即可，不需要安装 `openai` SDK。`openai` SDK 是客户端接入时才需要的。

## 6. Pi CLI 接入

Pi CLI 的 provider 已配置为：

```text
local-dashscope-proxy
```

指向：

```text
http://127.0.0.1:3300
```

默认使用：

```text
provider: local-dashscope-proxy
model: qwen3.7-max
```

使用前先启动代理服务：

```bash
pnpm dev
```

然后运行：

```bash
pi
```

也可以显式指定：

```bash
pi --provider local-dashscope-proxy --model qwen3.7-max
```

查看 Pi 是否识别 provider：

```bash
pi --list-models local --offline
```

如果想让 Pi CLI 按 OpenAI Chat Completions 协议接入，可以在 `~/.pi/agent/models.json` 增加类似 provider：

```json
{
  "providers": {
    "local-dashscope-openai-proxy": {
      "baseUrl": "http://127.0.0.1:3300/v1",
      "api": "openai-completions",
      "apiKey": "sk-001",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens",
        "thinkingFormat": "qwen"
      },
      "models": [
        {
          "id": "qwen3.7-max",
          "name": "Qwen 3.7 Max (Local OpenAI Proxy)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 32768,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "high"
          },
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

## 7. 查看服务状态

健康检查：

```bash
curl http://localhost:3300/health
```

模型池状态：

```bash
curl http://localhost:3300/models/status \
  -H "Authorization: Bearer sk-001"
```

返回中重要字段：

| 字段 | 说明 |
| --- | --- |
| `totalKeys` | 当前加载的 DashScope key 数量。 |
| `modelsPerKey` | 每个 key 下的模型数量。 |
| `totalSlots` | key+model 总组合数。 |
| `availableSlots` | 当前可用的 key+model 组合数。 |
| `models[].keyHash` | key hash 前缀，用于区分 key，不是明文 key。 |
| `models[].id` | 模型 ID。 |
| `models[].available` | 当前组合是否可用。 |
| `models[].cooldownUntil` | 冷却截止时间。 |
| `models[].failureCount` | 累计触发免费额度耗尽次数。 |

## 8. 切换规则

服务按这个规则自动切换：

1. 优先使用当前 key。
2. 当前 key 下某个模型触发免费额度耗尽 403，只冷却这个 key+model。
3. 继续尝试当前 key 的下一个模型。
4. 当前 key 下所有模型都冷却后，才切换到下一个 key。
5. 所有 key+model 都冷却时，返回 `503`。

## 9. 常见操作

重新生成状态文件：

```bash
rm data/proxy-state.json
pnpm dev
```

只想清空冷却状态，也可以删除状态文件后重新启动。注意这会丢失所有历史冷却和失败计数。

查看状态文件：

```text
data/proxy-state.json
```

状态文件和自动备份文件不需要提交。
