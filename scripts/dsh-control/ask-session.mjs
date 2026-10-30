// 向某个已有会话发一条 prompt（DSH 0.2.1：Cookie 认证 + /api/session/prompt + requestId/content）
// 用法: node ask-session.mjs <session-id 前缀> "<要问的话>"
import { listSessions, prompt } from "./dsh-api.mjs";

const pref = process.argv[2];
const text = process.argv[3];
if (!pref || !text) { console.error('用法: node ask-session.mjs <前缀> "<问题>"'); process.exit(2); }

const sessions = await listSessions();
const hit = sessions.find((s) => s.sessionId.includes(pref));
if (!hit) { console.error(`找不到会话 ${pref}（共 ${sessions.length} 个）`); process.exit(2); }
if (!hit.agentAvailable) { console.error(`会话 ${hit.sessionId} 不可用：format=${hit.formatStatus}（需先迁移）`); process.exit(3); }

try {
  const v = await prompt(hit.sessionId, text);
  console.log(`HTTP 200 ${JSON.stringify(v)}`);
} catch (e) {
  console.error(`发送失败: ${e.message}`);
  process.exit(1);
}
