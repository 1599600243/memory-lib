// D6.5 learning assistant: same agent runtime, learning-specific governed facade.
import { createAgentRuntime } from "./agent-runtime.mjs";
import { createLearningApi } from "./learning.mjs";
import { loadAgentConfig, defaultAgentConfigPath } from "./agent-config.mjs";

export async function createLearningAssistant({ dataRoot, workspaceRoot, memoryFactory, learningRoot, llmFactory = null, model = {}, agentConfigPath = null, now = () => new Date() } = {}) {
  if (!learningRoot) throw new Error("learning assistant requires learningRoot");
  const learning = createLearningApi(learningRoot);
  const configured = await loadAgentConfig(agentConfigPath ?? defaultAgentConfigPath(dataRoot), {});
  const learningConfig = configured.learning ?? { agent_id: "pilot-01", role_id: "learning", scopes: [{ layer: "memory", visibility: "shared" }], tools: ["search", "get", "learning_get_plan", "learning_get_progress", "learning_list_due", "learning_get_profile"], prompt: "你是学习助手。", model, stopWhen: 3 };
  const runtime = createAgentRuntime({
    dataRoot,
    workspaceRoot,
    memoryFactory: (identity) => {
      const memory = memoryFactory(identity);
      // VISIBILITY-FIX-1：learning 读方法现在**要求身份**（此前不接身份）。
      // 身份来自该 agent 的配置（`learningConfig`）——即"这个学习助手是谁"，不是调用方自报。
      const learningPrincipal = {
        framework_id: identity?.framework_id ?? "deepseek-harness",
        tenant_id: identity?.tenant_id ?? "default",
        group_id: identity?.group_id ?? null,
        user_id: identity?.user_id ?? null,
        agent_id: learningConfig.agent_id,
        role_id: learningConfig.role_id,
      };
      return {
        ...memory,
        learning_get_plan: ({ topic }) => learning.getPlan(topic, learningPrincipal),
        learning_get_progress: ({ topic }) => learning.getProgress(topic, learningPrincipal),
        learning_list_due: () => learning.listDueReviews(learningPrincipal),
        learning_get_profile: () => learning.getProfile(learningPrincipal),
      };
    },
    llmFactory,
    now,
    agents: { learning: learningConfig },
  });
  return { runtime, learning, run: (input = "") => runtime.run({ agent: "learning", trigger: "manual", input }) };
}
