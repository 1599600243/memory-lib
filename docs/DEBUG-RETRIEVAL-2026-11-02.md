# 排查手册：一条记忆为什么没被召回（2026-11-02）

> 适用：`/v1/search`、MCP `memory_search`、控制台「记忆」页、图检索。
> 先看元信息，再决定往哪查；不要凭"我记得它就在库里"直接改代码。

## 一、先拿到三条线索

### 1. `meta.prefiltered` —— 前置过滤有没有生效

```json
{"prefiltered": true, "lanes": {"fts": 145, "vector": 1600}, "used_owned_index": true}
```

| 值 | 含义 |
|---|---|
| `true` | SQL 已按「路径根 + tenant + 主体维度」先筛过（2026-11-02 之后） |
| `false` + `used_owned_index=true` | 走了索引但没加主体前置（表缺失/无 principal） |
| `used_owned_index=false`（meta 里没有） | 没走自有索引，退回 file-first 扫描 |

### 2. `meta.lanes` —— 两路各自取到多少候选

- `fts=0, vector=0` → **两路都没取到**：换词、确认索引健康（`/v1/health` 的 `index.failed`）、确认 `query` 不是纯停用词。
- 有候选但 `results=0` → 被**后置**过滤删掉了：可见性、时间窗（since/until/calendarDate）、图层（memories/documents/evidence）、去重。
- 候选很多但结果很少 → 后置过滤刀口太紧，查 scope / 时间窗。

### 3. `matched_by` —— 这条是怎么进来的

| 值 | 含义 |
|---|---|
| `fts` | 关键词命中 |
| `vector` | 语义相似 |
| `graph` | 精确边命中 |
| `graph:hop1` / `graph:hop2` | 从命中项沿边扩展 1/2 跳（2026-11-02 起） |

`/v1/search/joint` 才会出现 `graph*`；普通 `/v1/search` 只有 `fts/vector`。

## 二、决策树

```
结果 0 条
├── meta 缺失 / used_owned_index=false
│     └── 索引没被用上：查 indexes/sqlite 是否存在、health.index.failed、是否 MEMORY_INDEX 被禁
├── meta.lanes 两路都是 0
│     └── 根本没取到：换词；确认 query 有 ≥2 字实词；确认索引已建
└── lanes > 0 但 results = 0
      └── 被后置过滤：依次查
          1) principal 的 scope 是否覆盖目标目录（roots）
          2) 目标 frontmatter 的 visibility/user_id/group_id 是否与 principal 匹配
          3) since/until/calendarDate 是否把目标日期排除
          4) searchMode / layer 过滤
          5) tags 过滤（AND：给的每个 tag 都必须有）

结果有、但没有目标那条
├── 目标不在授权目录 → scope 问题（不是召回问题）
├── 目标 frontmatter 缺 user_id/group_id → 只能被「无身份标记」分支放行（仅 long-term/tool/knowledge/project）
├── 目标日期超出近 N 天（无 query 的兜底只给近 7 天）→ 加 query 或 since/until
└── /joint 里没有 graph:hopN
      ├── 边不存在：跑 rebuildGraph；或目标没有 project/tags/evidence_refs
      └── 边存在但 principalCanEdge 拒绝：边的 group/user 与 principal 不符（看 edges 表对应列）
```

## 三、可直接粘贴的检查

### 1. 看一次检索的 meta

```bash
curl -s -X POST http://127.0.0.1:8787/v1/search \
  -H 'content-type: application/json' \
  -d '{"credential_ref":"…","secret":"…","principal":{"agent_id":"qq-bot","role_id":"chat-reader"},"query":"米饭","limit":5}'
```

响应里的 `meta` 就是三条线索。

### 2. 看目标文件在索引里的主体维度

```sql
SELECT path, container, visibility, group_id, user_id, agent_id, role_id, project
FROM file_principals WHERE path LIKE '%目标文件名%';
```

没有行 → 该文件还没被索引（跑一轮索引），或它不在可检索根下。

### 3. 看目标的可见性判定

```js
import { canSeePath } from "./src/visibility.mjs";
canSeePath({ principal, dataRoot, filePath, frontmatter });
```

返回 `false` 就说明是**授权问题**，不是召回问题。

### 4. 看图里有没有边

```sql
SELECT src_id, predicate, dst_id FROM edges
WHERE src_id = '目标记忆 id' OR dst_id = '目标记忆 id';
```

没有边 → `rebuildGraph` 或该记忆缺 `project`/`tags`/`evidence_refs`。

## 四、常见误判

| 现象 | 真实原因 |
|---|---|
| "库里明明有，检索不到" | 十有八九是 `visibility=user` 但 `user_id` 不是调用者（授权问题） |
| "以前能搜到，现在搜不到" | 检查 `since/until` 或近 7 天兜底；检查 tag 过滤（AND） |
| "/joint 里没有图结果" | 图 lane 只在有边/有种子时出现；且中间节点（tag/project/证据）不作为结果返回 |
| "检索变慢了" | 看 `lanes.vector` 是否仍然接近全库（前置过滤没生效） |
| "证据节点出现在结果里" | 2026-11-02 之后已排除（`conversation-` / `session-` / `napcat:` / `#`），若出现说明跑的是旧进程 |

## 五、动代码之前

1. 先确认是**授权**还是**召回**（`canSeePath` vs `meta`）。
2. 召回问题优先补数据（索引一轮 / rebuildGraph），不要先改检索逻辑。
3. 改检索逻辑必须带"Top-N 饿死"回归（别人的热门记录不能挤掉自己的）。
4. 回滚点：`b92c3cf`（前置过滤）、`3bfa5ae`（多跳 + meta）。
