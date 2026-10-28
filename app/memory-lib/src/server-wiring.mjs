// TZ-CONFIG-1-REJECT — server-side wiring, extracted so it can be tested **as production runs it**.
//
// Why this file exists: the first attempt at this fix passed its tests while production was
// still wrong, because the test built its own `libFactory` — which forwarded `calendarTimezone`
// — while `server.mjs` built one that destructured only `{ scopes, agentId, principal, audit }`
// and silently dropped the key. A test double that is *more* correct than production does not
// test production.
//
// So the factory `server.mjs` actually passes to `createLocalhostServer` is constructed here,
// and both the CLI and the tests use this one function.
import { createMemoryLib } from "./memory-lib.mjs";

// `calendarTimezone` is the deployment default resolved once by the CLI (null when unconfigured).
// It is forwarded to every library instance, including the one behind the in-process MCP core,
// so REST / `/mcp` cannot drift apart. When null the library keeps its own historical "UTC".
export function createServerLibFactory({ dataRoot, workspaceRoot, calendarTimezone = null, ollama = null, summaryIndex = null, onDerivedIndexError = null, vectorLane = undefined }) {
  if (typeof dataRoot !== "string" || !dataRoot) throw new Error("createServerLibFactory: dataRoot is required");
  return ({ scopes, agentId, roleId, principal, audit, calendarTimezone: perRequestTimezone = null }) => createMemoryLib({
    dataRoot,
    workspaceRoot,
    scopes,
    agentId,
    roleId,
    principal,
    audit,
    // 请求级覆盖优先于部署默认；两者都缺 ⇒ 库自身的 "UTC"（唯一的兜底字面量在 createMemoryLib）。
    calendarTimezone: perRequestTimezone ?? calendarTimezone,
    ...(ollama ? { ollama } : {}),
    ...(summaryIndex ? { summaryIndex } : {}),
    ...(onDerivedIndexError ? { onDerivedIndexError } : {}),
    ...(vectorLane === undefined ? {} : { vectorLane }),
  });
}
