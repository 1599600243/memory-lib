# MemoryLib 版本与兼容策略

MemoryLib 有三个彼此独立的版本面。不要用其中一个版本推断另外两个。

## 1. Manifest `specVersion`

`specVersion` 描述 agent manifest 的字段契约，例如 `read`、`write`、`inject` 和 `apply`。它不等于服务版本，也不表示 HTTP 路径版本。

- 增加可选字段或增加旧消费者可忽略的枚举值：向后兼容，可保持当前 `specVersion`。
- 删除字段、把可选字段改为必填、改变既有字段语义：不兼容，提升 `specVersion` major，并提供 manifest 迁移脚本。
- 消费者必须拒绝自己不支持的 major，不能静默猜测。

## 2. HTTP/MCP API v1

`API v1` 是 HTTP 路径和 MCP 方法的线上契约。HTTP 的 `/v1/...` 与对应 MCP 方法可以在服务版本更新时继续保持 v1。

- 增加可选请求字段、增加响应字段：向后兼容；客户端应忽略未知响应字段。
- 删除字段、改变状态码或既有字段语义、把可选输入改为必填：提升 API major（例如 `/v2`），并提供调用方迁移说明或脚本。
- 同一 API major 内不得复用字段表达新语义。

## 3. 服务版本

服务版本遵循 SemVer，用于发布实现、安装器和诊断器。它可以在 `specVersion` 与 API major 均不变化时独立升级。

- patch：修复，不改变已声明契约。
- minor：向后兼容的新能力或可选字段。
- major：不兼容的运行或部署变化；若同时改变 manifest/API，仍必须分别提升对应 major 并提供迁移脚本。

## 兼容矩阵

| 改动 | specVersion | API major | 服务版本 | 迁移要求 |
|---|---:|---:|---:|---|
| 新增可选 manifest 字段 | 不变 | 不变 | minor | 无 |
| 新增可选 HTTP/MCP 字段 | 不变 | 不变 | minor | 无 |
| 纯实现修复 | 不变 | 不变 | patch | 无 |
| 删除/改义 manifest 字段 | major + 1 | 视情况 | major | manifest 迁移脚本 |
| 删除/改义 API 字段 | 视情况 | major + 1 | major | API 迁移脚本或适配器 |

## 版本输出

发布包应以机器可读 JSON 输出三个版本面。例如：

```console
$ node scripts/install.mjs --version
{"serviceVersion":"0.1.0","manifestSpecVersion":1,"apiVersion":"v1"}
```

发布流程必须从实际发布元数据生成服务版本，不得从 `specVersion` 或 `API v1` 推导它。
