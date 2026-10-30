# OpenClaw 插件退役 · 协议桥（第②③步）

> 状态：第①步（业务逻辑搬进 core）已完成；第②步「薄桥」已完成；第③步「切换」**代码已就位**——插件 `src/protocol-bridge.ts`（双轨 helper）+ `src/service.ts` 11 个 knowledge/evidence/recovery handler 已改为「优先协议、未配凭证回退内部」，语法检查通过，未重启 Gateway。
> 原则：**不破坏现有 OpenClaw 插件行为**，先验证、后切换、再删除。
> 切换动作（待执行）：给 Gateway 进程设 `MEMORY_LIB_CRED_REF` + `MEMORY_LIB_SECRET` 环境变量 → 重启 Gateway → 这 11 个工具即走 memory-lib 协议。

## 现状

| 能力 | openclaw 插件（内部文件操作） | memory-lib core（协议） |
|---|---|---|
| knowledge | `knowledge_import_put` / `approve_put` / `quarantine_put` / `get` | `POST /v1/knowledge/import` · `approve` · `get` |
| evidence | `evidence_import_put` / `get` / `list` | `POST /v1/evidence/import` · `get` · `list` |
| recovery | `recovery_plan_get/put` · `status_get` · `restore_validate_get` | `POST /v1/recovery/*` |

落点一致（knowledge/quarantine、approved、memory/evidence、project-state/openclaw），切换后文件真相不变。

## 第②步：薄桥（已完成）

`sdk/openclaw-bridge.mjs` —— 几十行适配层，方法名对齐插件工具名：

```js
import { createOpenClawBridge } from "memory-lib/sdk/openclaw-bridge.mjs";
const bridge = createOpenClawBridge({
  credentialRef: process.env.MEMORY_LIB_CRED_REF,
  secret: process.env.MEMORY_LIB_SECRET,
  role: "steward",  // approve 需 promote 权限
});
await bridge.knowledge_import_put({ id, content });
await bridge.knowledge_approve_put({ id });
```

## 第③步：切换插件（待执行，需谨慎）

1. **凭证**：给 openclaw 单独建一个凭证（或复用 deepseek-harness）：
   ```bash
   node memory-lib/scripts/onboard-framework.mjs --framework-id openclaw --agent openclaw-01 --role steward \
     --scope "layer=memory,visibility=shared" --scope "layer=knowledge,visibility=shared" \
     --action search,get,propose,review,promote,deprecate --wincred
   # 或走协议：POST /v1/admin/framework/create（admin 身份）
   ```

2. **替换 handler**：openclaw 插件 `src/service.ts` 里，把
   `createKnowledgeImportPutTool` / `createKnowledgeApprovePutTool` / `createKnowledgeQuarantinePutTool` /
   `createKnowledgeGetTool` / `createEvidenceImportPutTool` / `createEvidenceGetTool` / `createEvidenceListTool` /
   `createRecoveryPlanGetTool` / `createRecoveryPlanPutTool` / `createRecoveryStatusGetTool` / `createRecoveryRestoreValidateGetTool`
   这 11 个 handler 的内部 `writeKnowledgeFile` / `readEvidenceFile` 等，改为调用 `bridge.xxx`。

3. **注入凭证**：插件启动时从环境变量读 `MEMORY_LIB_CRED_REF` / `MEMORY_LIB_SECRET`（或 wincred）。

4. **验证**：跑插件 parity（`scripts/parity-probe.mjs`）确认行为一致，再跑 memory-lib 全量测试。

5. **归档删除**：验证无回归后，删插件内 knowledge/evidence/recovery 的直接文件操作实现，保留工具壳转发到协议。

## 注意事项

- 插件切换是**活体改动**，需在非生产环境先验证。
- 凭证不硬编码进插件源码（env/wincred）。
- 协议调用会走 core 的审计 + 权限门控（切换后插件操作也留痕，比内部直接写文件更安全）。
