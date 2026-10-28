# vector 生产启用验收报告

日期：2026-08-23
状态：**通过 —— vector 检索可正式依赖（graph 维持关闭）**

## 生产配置（~\.openclaw\openclaw.json，首次定位成功）

```jsonc
"openclaw-memory": {
  "enabled": true,
  "config": {
    "dataRoot": "I:\\OpenClaw\\memory-data\\memory",   // ← 与 memory-lib 生产目标一致
    "dreaming": { "enabled": false },
    "vector": { "enabled": true, "endpoint": "http://127.0.0.1:11434", "model": "nomic-embed-text", "dimension": 768, "timeoutMs": 15000 },
    "graph": { "enabled": true }                        // 配置开，但代码生产门禁仍关（见下）
  }
}
```

## 验收项

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 生产配置 vector.enabled | ✅ true + 真实 Ollama endpoint | openclaw.json |
| 2 | Ollama 可达且模型就位 | ✅ API 200，`nomic-embed-text:latest` 在列 | /api/tags |
| 3 | embeddings 数据 | ✅ **1361 条，active 1345（98.8%）**，全部 ollama/nomic-embed-text/768 | ledger 只读查询 |
| 4 | hybrid 路由 smoke | ✅ pass（fixture provider 被拒、可信 hybrid 3 命中、损坏降级 FTS、shadow 不变） | smoke-hybrid-search-routing |
| 5 | Ollama provider 边界 | ✅ pass（descriptor/request/parse/维度/超时/错误 9 项） | smoke-ollama-embedding-provider-boundary |
| 6 | ledger 健康/引用完整性 | ✅ pass（8 项完整性检查，liveUntouched） | smoke-ledger-vector-graph-health-boundary |
| 7 | vector-store 边界 | ✅ ok（8 断言：插入/幂等/更新/过滤/损坏 fail-closed/stale/元数据/重建标记） | smoke-vector-store-boundary |
| 8 | **真实 hybrid 检索（生产数据副本 + 真实 Ollama）** | ✅ **"记忆库" hybrid=5 / FTS=0；"审批" hybrid=5 / FTS=0** —— vector lane 端到端生效，命中 FTS 检索不到的语义结果 | hybrid-probe.mjs |
| 9 | graph 状态 | 🔒 `productionSearchEnabled=false`（代码级）+ **0 edges** | smoke-graph-store-boundary + ledger 查询 |

## 结论与建议

- **vector：正式可依赖**。生产配置已启用、数据就绪、全部插件验收通过、真实检索生效（语义召回补充 FTS）。
  默认 `memory_search` 仍为 file-first；显式 `memory_search_ledger` mode=hybrid 时走 RRF 融合（FTS+vector）。
- **graph：维持关闭**。配置虽开了 graph.enabled，但代码生产边界 `GRAPH_STORE_PRODUCTION_BOUNDARY.productionSearchEnabled=false`
  且 edges=0、无自动产边流程（automaticExtraction:false）。启用无收益，需先定义显式产边/审核流程。

## 备注

- 验收全程只读（生产 ledger 用副本探测，未触碰生产数据）
- 生产 openclaw.json 已定位：`~\.openclaw\openclaw.json`（此前扫描遗漏 home 目录）
