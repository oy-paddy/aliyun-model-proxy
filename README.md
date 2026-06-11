# 阿里云模型代理

基于 Hono.js 的反向代理服务，同时支持阿里云 DashScope Anthropic 兼容接口和 OpenAI 兼容接口。客户端只需一个代理地址和一个代理密钥，真实 DashScope API Key 和模型池均在服务端隐藏管理。当免费额度耗尽时，代理自动切换模型。

> 阿里云 DashScope 每个模型提供 **1000 万免费 tokens**，通过模型池聚合多个模型，可最大化利用免费额度。

![模型试用明细](image.png)

## 功能

- 对外只暴露一个 API Key
- 隐藏真实 DashScope API Key 和模型池
- Anthropic 协议 `POST /v1/messages` 代理
- OpenAI Chat Completions 协议 `POST /v1/chat/completions` 代理
- OpenAI 协议 `GET /v1/models` 返回本地模型池列表
- 自动替换请求体中的 `model` 字段
- Key 优先故障转移：在当前 Key 下尝试所有可用模型，全部失败后才切换到下一个 Key
- 免费额度耗尽自动重试，触发条件（满足任意一组）：
  - HTTP `403`，`code` 为 `AccessDenied`，且 `message` 同时包含 `free tier` 和 `exhausted`
  - `code` 或 `type` 为 `AllocationQuota.FreeTierOnly`
- 冷却状态按 Key+模型组合持久化到 JSON 文件，重启不丢失
- 上游返回正常状态码后，流式响应直接透传，不做缓冲

## 相关文档

- [使用说明](docs/usage.md)
- [状态文件说明](docs/state-file.md)
- [Q/A 与方案决策记录](docs/qa-and-decisions.md)

## 快速开始

```bash
pnpm install
cp .env.example .env
```

按需修改 `.env`：

```env
PORT=3300

PROXY_API_KEY=sk-001

DASHSCOPE_API_KEYS=sk-your-real-key-1,sk-your-real-key-2
UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
OPENAI_UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

MODEL_IDS=deepseek-v4-flash,deepseek-v4-pro,qwen3.7-max,qwen3.7-plus
MODEL_COOLDOWN_SECONDS=2592000
STATE_PATH=./data/proxy-state.json
UPSTREAM_AUTH_MODE=authorization
CORS_ORIGIN=*
```

开发模式：

```bash
pnpm dev
```

生产模式：

```bash
pnpm build
pnpm start
```

## 客户端调用

### Anthropic 协议

代理地址：

```text
http://localhost:3300
```

请求头二选一：

```http
Authorization: Bearer sk-001
```

或：

```http
x-api-key: sk-001
```

示例：

```bash
curl http://localhost:3300/v1/messages \
  -H "Authorization: Bearer sk-001" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "any-model-name",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "你好"
      }
    ]
  }'
```

### OpenAI 协议

代理 base URL：

```text
http://localhost:3300/v1
```

示例：

```bash
curl http://localhost:3300/v1/chat/completions \
  -H "Authorization: Bearer sk-001" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any-model-name",
    "messages": [
      {
        "role": "user",
        "content": "你好"
      }
    ],
    "stream": true
  }'
```

客户端可以使用 OpenAI SDK 接入 `http://localhost:3300/v1`。服务端本身只是反代，使用原生 `fetch`，不需要 `openai` SDK。

## 服务状态

健康检查：

```bash
curl http://localhost:3300/health
```

模型池状态：

```bash
curl http://localhost:3300/models/status \
  -H "Authorization: Bearer sk-001"
```

## Docker

```bash
docker build -t dashscope-model-proxy .
docker run --env-file .env -p 3300:3300 dashscope-model-proxy
```

## 说明

冷却状态保存在 `STATE_PATH` 指定的 JSON 文件中，存储内容包括 Key 哈希、模型 ID、冷却截止时间、失败次数和最近错误信息，不保存明文 DashScope API Key。

状态文件仅供单进程写入设计。若部署多实例，需各自维护独立状态文件或引入外部协调存储。
