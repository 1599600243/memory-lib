# 交接：检索隔离从 post-filter 改为 pre-filter（2026-11-02）

> 发起：being 线在「memory-lib ↔ being 联调」房间报告（2026-11-02 18:41）。
> 由于他们的会话在 `.\app` 被 `denied: shell.exec` 挡住，本轮由记忆库主线实现并验证。
> 提交：`b92c3cf`

## 一、结论

原实现是 **post-filter**：先取全局 Top-N，再按 `authRoots` / `canSeePath` 过滤。两个后果都成立：

1. 成本随全库增长：每次查询把全库 active embeddings 全算一遍（26,608 条 × 1024 维）。
2. 召回被挤掉：别人的热门结果占据 Top-N，调用者自己的记忆排不进去——不越权，但检索不到。

现在两路（FTS / 向量）都在 SQL 里**先**按「路径根 + 主体维度」过滤，返回后再复核一次。

## 二、他们问的 `authRoots` 格式（准确回答）

```js
// ledger-search.mjs:59
if (!Array.isArray(authRoots) || authRoots.length === 0) return true; // 不限制
return authRoots.some((root) => {
  const rel = path.relative(root, filePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
});
```

- **格式：绝对路径数组**（`dataRoot/curated/shared`、`dataRoot/project-state/<project>` 等）
- **`null` 或 `[]` = 不限制**
- 来源：`resolveRootsForScopes(scopes, dataRoot, workspaceRoot)`（`src/memory-lib.mjs:61`）
- 索引 SQL 里用 `path.relative(dataRoot, root)` 转成 `curated/shared` 这种相对前缀（见 `relativeRootPrefixes`）

**但路径根回答不了"这条记录属于谁"**：`visibility=user` 的根是**整个 `curated/shared`（2846 个文件）**，真正的隔离是逐文件按 `user_id` 比对。所以只做路径前缀过滤不够——这也是这轮补 `file_principals` 的原因。

## 三、实现

### 1. 索引新增主体维度（`src/index-store.mjs`）

```sql
CREATE TABLE file_principals (
  path TEXT PRIMARY KEY, container TEXT, visibility TEXT,
  group_id TEXT, user_id TEXT, agent_id TEXT, role_id TEXT,
  project TEXT, tenant_id TEXT
);
```

- 索引时从 frontmatter 抽取；`groupId/userId/agentId/tenantId` 这类 camelCase 也认（对话证据就是这种写法）
- 缺省 visibility 按 container 推导（project→project、tool/knowledge→platform、role→role，其余 private）
- 文件删除时同步删除；存量库在下一轮索引自动补齐（本轮现网已补 5,675 条）

### 2. 检索前置过滤（`src/index-search.mjs`）

FTS 与向量两路都：

```sql
... LEFT JOIN file_principals p ON p.path = f.path
WHERE f.status='active'
  AND (f.path LIKE :root0/% OR ...)          -- 路径根
  AND (p.tenant_id IS NULL OR p.tenant_id = :tenant)
  AND ( <主体谓词> )                          -- 见下
```

主体谓词覆盖：`platform`、`shared`（分组严格比较）、`user`（user_id 相等）、`agent`/`private`/`long-term`（user/agent/role 任一命中）、`role`（role_id 相等，含从 `curated/agents/<agent>/` 路径推 agent 的旧记录）、`project`（group 兼容）、`evidence`（group + user 同时相等）、无身份标记旧记录的 container 默认放行。

**语义取 `canSeePath` 的超集**：宁可多取，交给返回后的 `inAuthRoots` / `canSeePath` 复核删除——索引永远不是权威。

### 3. 调用方传身份（`src/memory-lib.mjs`、`src/graph-retrieval.mjs`）

- `memory-lib.search` 把 `principal + scopes + tenantId` 传进 `memoryIndexSearch`
- `jointSearch` 不再传 `authRoots = null`：带 `principal + scopes`（图侧无目录根，先按主体维度过滤，精确可见性仍由 `visiblePath` 复核）

## 四、验证（原始数字）

```
新回归 test/search-prefilter.test.mjs：7/7
  · 路径根 → dataRoot 相对前缀
  · 生成的 SQL 含 p.user_id / p.tenant_id（不是纯路径）
  · 跨身份不可见
  · Top-N 饿死：40 条别人的"米饭" + 1 条自己的，limit=1 仍返回自己的
  · 空根 = 拒绝全部
  · camelCase evidence 仍按 group+user 隔离

检索相关 11 个文件：60/60
全量 762 tests：757 pass
  失败 3 个：
    · ML1（已知历史失败，基线同样失败）
    · M1.4 production-shaped / maint5 —— 单独跑与串行跑均 3/3 通过，属并发抖动
```

现网性能（`/v1/search`，同一 query「米饭」）：

```
改前：1.5–1.6 s
改后：admin 0.78–1.24 s，qq-bot 0.70–1.24 s
```

qq 身份返回 10 条逐条核对：`user=u-owner / group=qq / vis=user`，evidence 是 `groupId=qq / userId=u-owner`（camelCase），无越权。

## 五、已知限制 / 后续

1. **图检索（jointSearch）** 目前只做了主体维度前置，没有把 `authRoots` 传进去（避免 `graph-retrieval → memory-lib` 循环依赖）；因此图侧仍可能多取，但不会少取。
2. **分区索引**（按 agent/scope 分库）没做；当前是单库 + 前置谓词。
3. 索引表结构变更没有显式 schema version：靠 `CREATE TABLE IF NOT EXISTS` + 每轮索引 upsert 自愈；回退旧代码时 `file_principals` 表会被忽略，无副作用。
4. 回滚：`git revert b92c3cf`（数据侧不用动；最坏情况下删掉 `file_principals` 表也无影响）。

## 六、给 being 线的对接结论

- 他们不需要再在 `.\app` 执行 `node --test`：主线已跑过并贴了结果。
- 他们要验证自己的身份隔离，直接用 `/v1/search`（带 qq 身份）与 `/v1/recall/brief` 即可；`prefiltered` 字段在 `memoryIndexSearch` 返回值里（HTTP 响应暂未暴露）。
- 如果还要加"用热点词观察返回条数"的对照实验，建议用 `limit=1` 造 Top-N 饿死场景，比 `limit=10` 更能看出差别。

## 七、后续三项（2026-11-02 晚，提交 3bfa5ae）

### 1. 图检索多跳扩展

`jointSearch({ depth })`：以命中项（索引结果 id + 精确边端点）为种子，沿边 BFS 最多 `depth` 跳（默认 2，上限 3）。

- 只走 `principalCanEdge` 放行的边
- 中间节点（`project:` / `tag:` / `memory:` / `evidence:` / `conversation-` / `session-` / `soul:` / `napcat:` / `qq:` / `being:` 以及含 `#` 的事件引用）**可以继续走，但不作为结果返回**
- 节点上限 200

实测（qq 身份）：`/v1/search/joint` 出现 `matched_by=["graph:hop2"]`，返回的是记忆（`decision-…` / `progress:memory-lib`），不再是证据/事件节点。

### 2. 检索元信息

`memory-lib.searchWithMeta()` + `/v1/search` 响应新增 `meta`：

```json
{ "prefiltered": true, "lanes": { "fts": 145, "vector": 1600 }, "used_owned_index": true }
```

用来回答"这条为什么没被召回"：是前置过滤挡了，还是 FTS/向量本来就没取到。

### 3. 项目边

- 现网重建图谱：6,442 → 8,943 边（`rebuildGraph` 把 curated/plans/profile/tools-memory 的 evidence_refs/tags/project/supersedes 全部建成边）
- `belongs_to_project` 6 → 7（补上了 codegraph 决策那条）
- 回归证明：`project-decision` 写入即产生边（writer 的 `project.linked` 事件），**不需要全量 rebuild**

### 仍然没做

- 分区索引（单库 + 前置谓词，未按 agent/scope 分库）
- 图的多跳默认 2 跳，深链（3 跳以上）需要显式传 `depth`

### 已补（2026-11-02 晚，提交含 scope-roots 拆分）

- 图检索的索引 lane 现在也带 `authRoots`：`resolveRootsForScopes` 拆到 `src/scope-roots.mjs`，`graph-retrieval` 不再为拿它而反向依赖 `memory-lib`

## 八、排查手册（2026-11-02 晚）

`docs/DEBUG-RETRIEVAL-2026-11-02.md`：用 `meta.prefiltered / lanes / matched_by(graph:hopN)` 三条线索判断"为什么没召回"，附决策树、可直接粘贴的 SQL/命令、常见误判。

同时把诊断暴露到两个入口：
- MCP `memory_search` 响应新增 `meta`（prefiltered / lanes / used_owned_index）
- 控制台「记忆」页检索结果显示"前置过滤开/关（候选：FTS n / 向量 n）"

