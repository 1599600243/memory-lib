// openclaw-bridge.mjs — 通用 OpenClaw 协议桥（薄，几十行）。
// 让 openclaw 插件通过 library.v1 协议访问 memory-lib core 的 knowledge/evidence/recovery，
// 替代插件内部直接文件操作（writeKnowledgeFile / readEvidenceFile 等）。
//
// 第③步（停用→归档→删除插件内实现）：把 openclaw 插件 service.ts 里
//   createKnowledgeImportPutTool / createEvidenceListTool / ... 的 handler
//   改为调用本桥的同名方法即可；凭证经环境变量注入。
//
// 用法：
//   import { createOpenClawBridge } from "memory-lib/sdk/openclaw-bridge.mjs";
//   const bridge = createOpenClawBridge({
//     credentialRef: process.env.MEMORY_LIB_CRED_REF,
//     secret: process.env.MEMORY_LIB_SECRET,
//     role: "steward",   // approve 需 promote 权限
//   });
//   await bridge.knowledge_import_put({ id, content });
import { MemoryClient } from "./memory-client.mjs";

export function createOpenClawBridge({ url = "http://127.0.0.1:8787", credentialRef, secret, agent = "pilot-01", role = "steward" } = {}) {
  if (!credentialRef || !secret) throw new Error("createOpenClawBridge requires credentialRef and secret");
  const client = new MemoryClient({ url, credentialRef, secret, agent, role });
  return {
    // 方法名对齐 openclaw 插件工具名，插件 handler 可直接替换
    knowledge_import_put: ({ id, content }) => client.knowledgeImport(id, content),
    knowledge_approve_put: ({ id }) => client.knowledgeApprove(id),
    knowledge_quarantine_put: ({ id, content }) => client.knowledgeImport(id, content),
    knowledge_get: ({ id }) => client.knowledgeGet(id),
    evidence_import_put: ({ id, content }) => client.evidenceImport(id, content),
    evidence_get: ({ id }) => client.evidenceGet(id),
    evidence_list: () => client.evidenceList(),
    recovery_plan_get: ({ id }) => client.recoveryPlanGet(id),
    recovery_plan_put: ({ id, content }) => client.recoveryPlanPut(id, content),
    recovery_status_get: () => client.recoveryStatus(),
    recovery_restore_validate_get: ({ path }) => client.recoveryRestoreValidate(path),
  };
}
