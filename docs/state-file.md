# 状态文件说明

本服务使用 JSON 文件保存模型冷却状态。这样服务重启后，已经进入冷却期的 DashScope key 与 `MODEL_ID` 组合不会丢失。

默认状态文件路径：

```env
STATE_PATH=./data/proxy-state.json
```

状态文件不会保存明文 DashScope API Key。代码会对每个 key 计算 SHA-256，并把结果写入 `modelState`。

## 文件结构

状态文件是一个版本化 JSON 对象：

```json
{
  "version": 1,
  "modelState": {},
  "runtimeState": {}
}
```

## modelState

`modelState` 保存每个 DashScope key 与 `MODEL_ID` 组合的状态。

例如配置：

```env
DASHSCOPE_API_KEYS=key1,key2
MODEL_IDS=modelA,modelB,modelC
```

那么 `modelState` 会有 `2 * 3 = 6` 条记录。

字段说明：

| 字段 | 说明 |
| --- | --- |
| `keyHash` | DashScope API Key 的 SHA-256 hash。用于区分不同 key，但不保存明文 key。 |
| `modelId` | 模型 ID，来自 `MODEL_IDS`。 |
| `cooldownUntil` | 冷却截止时间，Unix 毫秒时间戳。`0` 表示没有冷却。如果这个值大于当前时间，该 key+model 组合不可用。 |
| `failureCount` | 该 key+model 组合触发免费额度耗尽 403 的次数。 |
| `lastError` | 最近一次免费额度耗尽时，上游返回的错误信息。 |
| `lastUsedAt` | 最近一次成功使用该 key+model 组合的时间，Unix 毫秒时间戳。 |
| `updatedAt` | 最近一次状态更新时间，Unix 毫秒时间戳。 |

## runtimeState

`runtimeState` 保存调度游标，避免服务每次重启后都从第一个 key、第一条 model 开始打。

当前会使用的记录：

| `name` | 说明 |
| --- | --- |
| `key_cursor` | 当前优先使用的 DashScope API Key 下标。 |
| `model_cursor:<key_hash>` | 某个 key 当前优先使用的模型下标。 |

每条记录包含：

| 字段 | 说明 |
| --- | --- |
| `value` | 状态值。当前主要保存数字游标，但统一用文本存储。 |
| `updatedAt` | 最近一次更新时间，Unix 毫秒时间戳。 |

## 写入策略

状态变更会同步写入文件。写入时先写临时文件，再用 `rename` 替换正式状态文件，降低进程中断时写坏文件的风险。

如果启动时发现状态文件不是有效 JSON，或结构不符合当前版本，服务会把原文件重命名为：

```text
proxy-state.json.bak.<timestamp>
```

然后创建新的空状态。

## 调度规则

当前实现是“key 优先”的切换策略：

1. 先使用 `key_cursor` 指向的 key。
2. 在这个 key 内部，从该 key 的 `model_cursor` 指向的模型开始尝试。
3. 如果某个模型返回免费额度耗尽 403，只冷却这个 `keyHash + modelId` 组合。
4. 继续尝试同一个 key 下的下一个可用模型。
5. 只有当前 key 下所有模型都不可用时，才切换到下一个 key。
6. 如果所有 key+model 组合都不可用，服务返回 `503`。

## 冷却规则

默认冷却时间是 1 个月：

```env
MODEL_COOLDOWN_SECONDS=2592000
```

当某个 key+model 组合进入冷却：

```text
cooldownUntil = 当前时间 + MODEL_COOLDOWN_SECONDS
failureCount = failureCount + 1
lastError = 上游错误信息
updatedAt = 当前时间
```

当某个 key+model 组合成功返回：

```text
lastUsedAt = 当前时间
lastError = null
updatedAt = 当前时间
```

成功返回不会清零 `failureCount`，这个字段保留历史失败次数。
