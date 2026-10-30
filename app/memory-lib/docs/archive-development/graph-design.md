# 记忆图谱设计（Graph Design）

> 状态（D29）：**未完成 / 不属于当前生产面**。图谱检索、图谱写入和图谱 UI 均不在 D29 活跃协议中；本文件仅保留为历史设计记录，不得作为当前实现或运维指令。
> 目标：把记忆库从「文件 + 全文/向量检索」升级为「文件真相 + 图谱索引」，方便后续开发（检索增强、可视化、学习路径）。
> 借鉴：CodeGraph（预索引代码知识图谱）——离线预索引、少 token、100% 本地。
> 红线：**图谱是派生索引，永远可从文件重建，不改变检索正确性，只做增强**。

## 1. 现状与目标

| | 现状 | 目标 |
|---|---|---|
| graph 能力 | gated off，0 边，代码门禁 | 激活为「记忆图谱」第四索引维 |
| 检索 | hybrid = FTS + 向量 + RRF | + 图谱邻居扩展（1 跳） |
| 关系 | 散落在 frontmatter / 正文 | 结构化节点 + 边，可查询、可视化 |

## 2. 实体（节点）定义

| 类型 | 来源 | 说明 |
|---|---|---|
| `item` | curated 下每条记忆（.md + frontmatter id） | 正式记忆条目 |
| `candidate` | inbox 候选 | 未晋升（图谱里可选，默认不建） |
| `topic` | frontmatter `tags` | 主题标签 |
| `project` | scope `project` 字段（pilot/openclaw…） | 项目/领域 |
| `agent` | 注册表 agent_id（pilot-01…） | 智能体 |
| `source` | frontmatter `source` | 来源文件/URL |
| `knowledge` | knowledge 层条目 | 大材料/书籍知识 |
| `plan` | learning `plan.json` | 学习计划的稳定身份锚点（`plan:<topic>`） |
| `learning_module` | learning `plan.json` 中的模块 | 学习模块（`module:<topic>:<module-id>`，依赖默认在同一 plan 内解析） |

## 3. 关系（边）定义

| 类型 | 方向 | 来源 | 产边方式 |
|---|---|---|---|
| `belongs_to` | item → project | scope.project | 确定性 |
| `tagged` | item → topic | tags | 确定性 |
| `derived_from` | item → source | source 字段 | 确定性 |
| `authored_by` | item → agent | source/author 字段 | 确定性 |
| `supersedes` | 新 item → 旧 item | deprecate 的 replacement_id | 确定性 |
| `supersedes`（项目级） | project → project | frontmatter `supersedes_project`（项目继承/取代，如 memory-lib → openclaw） | 确定性 |
| `belongs_to` | 学习模块 → plan | `plan.json` | 确定性 |
| `prerequisite` | 学习模块 → 前置模块 | learning_map 依赖；裸模块 id 在同一 plan 内解析 | 确定性 |
| `mentions` | item → item / topic | 正文引用（`mem_xxx` / 单行有界 `[[引用]]`） | 正则确定性 + LLM 语义（候选） |

**原则**：能确定性产的就确定性产（低风险、可重建）；需要语义理解（mentions）的，起步用正则，进阶才上 LLM，且 LLM 边走人工审核。

## 4. 产边流程

1. **扫描**：离线遍历 curated / knowledge / learning 的 .md 文件（复用 `read-only-core` 的 `walkFiles`）。
2. **解析 frontmatter**：提取 `id / title / scope.project / tags / source / importance`（复用 `parseFrontmatter`）。
3. **确定性建节点 + 边**：scope.project→project、tags→topic、source→source、agent→agent，直接写入。
4. **正文 mentions 提取**：正则匹配 `mem_[a-z0-9_]+` 与单行、有长度上限的 `[[...]]`；普通反引号内容和代码块不产 topic。
5. **写入图谱存储**（见 §5）。
6. **增量**：只索引新增/变更文件（按 mtime / 内容 hash 去重），不整库重扫。

## 5. 存储

独立 SQLite `graph.db`（与 ledger 分开，避免污染检索索引），两张表：

```sql
CREATE TABLE nodes (
  id    TEXT PRIMARY KEY,      -- item 用 memory id；topic/project/agent 用稳定 slug
  type  TEXT NOT NULL,         -- item/topic/project/agent/source/knowledge/plan/learning_module
  label TEXT NOT NULL,         -- 人类可读名
  scope TEXT,                  -- 结构化 scope JSON（过滤用）
  meta  TEXT                   -- 扩展 JSON
);
CREATE TABLE edges (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  type    TEXT NOT NULL,       -- belongs_to/tagged/derived_from/authored_by/supersedes/prerequisite/mentions
  weight  REAL DEFAULT 1.0,
  source  TEXT DEFAULT 'auto', -- auto(确定性) | llm(候选，待审核)
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX idx_edges_to ON edges(to_id, type);
```

## 6. 消费（图谱怎么用）

1. **检索增强**：hybrid 命中后，取命中 item 的 1 跳邻居（同 project/topic、supersedes 链），作为「相关条目」附加返回（不替代原结果，只加）。
2. **可视化**：控制台 / 宠物加图谱视图（force-directed），主题聚类、项目关系一目了然。
3. **后续开发**：学习路径沿 `prerequisite` 边；记忆关联沿 `mentions` 边；废弃链沿 `supersedes` 边。

## 7. 审核与治理（对齐现有闭环）

- `auto` 边（确定性）：直接入图，可随时重建，无需人工审核。
- `llm` 边（语义 mentions）：进「图谱候选」队列，走现有 `review → promote` 闭环（复用 steward 角色，审计留痕）。
- **图谱永远可重建**：删 `graph.db` 重跑产边即可，不影响文件真相与检索正确性。
- **full rebuild 的替换语义**：先在独立临时 SQLite 文件中完整扫描并建图，再打开 live 库，在 `BEGIN IMMEDIATE` 事务内删除并逐行复制节点、边和文件索引；复制或提交异常会 rollback，live 库恢复到事务开始前的状态。当前实现是事务内复制，不是文件级 rename，因此进程/磁盘级故障恢复仍依赖备份或重新建图；启动前扫描失败则不会触碰 live 库。

## 8. 分阶段落地

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 激活 | 确定性产边（belongs_to/tagged/derived_from/authored_by/supersedes/prerequisite）+ SQLite 建图 + 检索邻居扩展 | 低 |
| P2 语义边 | 正则 mentions 边；进阶 LLM 语义边走候选审核 | 中 |
| P3 可视化 | 控制台/宠物图谱视图 + 主题聚类 | 低（纯前端） |

## 9. 边界与红线

- 图谱是**派生索引**，不是真相；真相永远在文件。
- 图谱检索是「加结果」，不是「替换」——关闭图谱不影响现有 hybrid 检索。
- 激活前需通过本设计的 review（解除代码门禁）。
- 大材料（knowledge/books）默认不建图，只索引 memory 层 + learning 依赖，避免图谱爆炸。
