# LLM 接入说明

这个项目启动后提供本地模型代理。客户端不要使用真实 DashScope key，只使用 `.env` 里的 `PROXY_API_KEY`。

## 服务地址

默认端口来自 `.env`：

```env
PORT=3300
PROXY_API_KEY=sk-001
```

本地代理地址：

```text
http://127.0.0.1:3300
```

客户端 API Key：

```text
sk-001
```

请求认证可以使用：

```http
Authorization: Bearer sk-001
```

或：

```http
x-api-key: sk-001
```

## Anthropic 协议客户端

用于 Claude Code CLI 或其他 Anthropic Messages 兼容客户端：

```text
base URL: http://127.0.0.1:3300
api key:  sk-001
```

Messages endpoint：

```text
POST http://127.0.0.1:3300/v1/messages
```

## OpenAI 协议客户端

用于 Pi CLI 或其他 OpenAI Chat Completions 兼容客户端：

```text
base URL: http://127.0.0.1:3300/v1
api key:  sk-001
```

Chat Completions endpoint：

```text
POST http://127.0.0.1:3300/v1/chat/completions
```

Models endpoint：

```text
GET http://127.0.0.1:3300/v1/models
```

## Pi CLI

在 Pi CLI 的 provider 配置里使用：

```json
{
  "baseUrl": "http://127.0.0.1:3300/v1",
  "api": "openai-completions",
  "apiKey": "sk-001"
}
```

## Claude Code CLI

在 Claude Code CLI 里按 Anthropic 兼容接口配置：

```text
base URL: http://127.0.0.1:3300
api key:  sk-001
```

如果使用环境变量方式，核心值仍然是：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:3300
ANTHROPIC_API_KEY=sk-001
```

## 模型

客户端传入的 `model` 会被代理替换为 `.env` 里的 `MODEL_IDS` 中当前可用模型。

启动日志会打印实际应用的模型 ID：

```text
[proxy] applied model ids:
[proxy]   - <model-id>
```
