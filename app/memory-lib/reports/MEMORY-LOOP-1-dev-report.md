STATUS: READY

# MEMORY-LOOP-1 开发报告（收口 + spec re-review medium 指认处置）

> 交付物路径：`D:\MemoryLib\reports\MEMORY-LOOP-1-dev-report.md`（本文件）
> 仓库内另有一份**逐字节相同**的受版本管理副本：`memory-lib/reports/MEMORY-LOOP-1-dev-report.md`
> （放在仓库里是为了让"报告本身"也有一个可引用的 git sha；两份内容一致，见 §1.3 的自引用说明）
> 报告只有一份，文件名不含 `acceptance`。首行是 STATUS 标记（本行以上只有 STATUS 一行）。

## 0. 一句话结论

spec re-review 的 medium 指认**成立，但方向与字面不同**：`localhost-server.conclusionScope` 是"按层名猜
一个 visibility"，它既不等于 `write-memory` 对同一份写入输入**实际写出来的**可见性，也不等于 `/v1/write`
对同一份输入的放行口径 —— 实测结果是"该严的地方松（document 能写出 platform 可见的记忆）、该松的地方
严（curated-shared 同一份输入 `/v1/write` 200、提交 403）"。本次把门禁改成**先用 `write-memory` 的同一个
默认可见性函数算出这条结论最终写成什么（container + visibility），再套 `/v1/write` 对那个可见性的既有
规则**。**可见性判据、container-policy、检索根、检索排序一个字节没动**（改动全在"谁有权把这条结论写下
去"这一层）。§1.4 是同一版测试的红→绿原始输出，§3 是受影响面的修前/修后实测读数。

---

## 1. 五件固定件

### 1.1 基线

- 本里程碑（MEMORY-LOOP-1）基线：`0cd8ee78594f1d7eecec1f80c149f093d59a8409`（VISIBILITY-FIX-1-REJECT5 收口，
  已验收上线）。已核验它是 HEAD 的祖先（`git merge-base --is-ancestor 0cd8ee7… HEAD` 退出码 0）。
- 本次"收口"工作开始时的 HEAD：`4a27bdb68413892e0e7cc7904ccd1edc018036c9`（工作树干净，`git status --porcelain` 为空）。

### 1.2 终态 sha

- 修复提交：**`0211a6950112a4dff86cc97bdfaf0e739ec6613a`**（C1；落地后树干净，全量/定向回归都在这个 sha 上跑过）
- 报告 WIP 提交：**`d6f77b5dc4bac71f2938e5c96fca50c6f42cf464`**（C2；本文件的两个副本在 C3 里同时记录它）
- 报告相关提交：见 §1.3 的 C2 / C3 / C4。**C4（把首行改成 `STATUS: READY` 的那一次）的 sha 无法写进本文件**
  —— 文件内容参与了那次提交，写进去就等于要求提交包含自己的哈希。C4 的 sha 由交付回复里的
  `git rev-parse HEAD` 给出；这一点是自引用的客观限制，不是漏写。
- 工作树在每次提交前都是干净的；**全程没有 amend、没有 rebase、没有改写历史**。

### 1.3 提交清单（no amend）

```
0211a6950112a4dff86cc97bdfaf0e739ec6613a  MEMORY-LOOP-1 修复：提炼提交的写授权按【写出来的可见性】算（去掉按层名猜的 conclusionScope）   ← 本次代码修复（C1）
d6f77b5dc4bac71f2938e5c96fca50c6f42cf464  MEMORY-LOOP-1 报告（WIP）：medium 指认的复核、处置与受影响面读数（C2）
172d5f1d7976bc5cca6cb38851b4b3dcd2ec9cd2  MEMORY-LOOP-1 报告：记录 C1/C2 提交 sha（C3；C4 的首行 READY 转换另计）
<C4>     MEMORY-LOOP-1 报告：首行 STATUS: WIP -> STATUS: READY（最终一次编辑，只改首行）
```

本里程碑沿用的既有提交（同样**没有 amend**，来自前几轮交付）：

```
e4f01a8  MEMORY-LOOP-1 切片1：捕获落盘即产生可追踪提炼待办 + /v1/refinement/jobs 的 list/get/claim
979ebaa  MEMORY-LOOP-1 切片2：领取者提交结论 ⇒ 正式记忆落盘 + 回执 + 可立即读回
82e3a60  MEMORY-LOOP-1 切片3：完成度度量只读接口 /v1/refinement/jobs/metrics（本地日 + 时区 + as_of）
4ff18dd  MEMORY-LOOP-1 切片4：提炼提交的 stable_key 冲突与取代（同体合并 / 409 SUPERSEDE_REQUIRED / 取代链留盘）
4a27bdb  MEMORY-LOOP-1 修复：suppressRefinement 仍建待办 / 证据逐条兼容 / 无 workspace 待办可用 / …（上一轮 9 条审阅）
```

### 1.4 红→绿（**同一版测试**）原始输出

测试文件：`memory-lib/test/refinement-jobs-submit-scope-http.test.mjs`（3 个顶层测试 + 4 个子测试，共 7 个断言点；
已登记进 `memory-lib/scripts/run-tests.mjs` 的回归集）。

| 阶段 | 命令（在 `D:\MemoryLib\app\memory-lib`） | 原始输出文件 | 结果 |
| --- | --- | --- | --- |
| 修前（HEAD=4a27bdb 的 src） | `node test\refinement-jobs-submit-scope-http.test.mjs` | `reports\MEMORY-LOOP-1-scope-red.raw.txt` | `tests 7 / pass 0 / fail 7` |
| 修后（同一个文件，src=0211a69） | 同上 | `reports\MEMORY-LOOP-1-scope-green.raw.txt` | `tests 7 / pass 7 / fail 0` |

修前 7 个失败点与**具体读数**（原始输出里逐条可查）：

1. `①同一份写入输入，/v1/write 放行 ⇒ 提交门禁也必须放行`：
   `the submit entry must authorize exactly like /v1/write for the same write input, got 403
   {"code":"WRITE_SCOPE_DENIED","message":"SUBMIT_SCOPE_DENIED: SCOPE_DENIED"}`（期望 200）。
2. 子测试 `tool：写出来是 platform 可见性 ⇒ 要 admin`：`got 200 {"ok":true,…,"writes":[{"id":"ml1s-pp-tool","layer":"tool",
   "path":"…\tools-memory\ml1s-pp-tool.md","created":true…}]}`（期望 403）。
3. 子测试 `agent：只按服务端绑定身份（role/role）`：`got 403 … SUBMIT_SCOPE_DENIED: SCOPE_DENIED`（期望 200）。
4. 子测试 `plan：…（plan/private）`：同上 403（期望 200）。
5. 子测试 `profile：…（long-term/private）`：同上 403（期望 200）。
6. `②③platform 可见性要 admin；项目层作用域不放宽`：
   `a platform-visible conclusion must require the admin action, got 200 {"ok":true,…,"writes":[{"id":"ml1s-submit-doc",
   "layer":"document","path":"…\evidence\documents\ml1s-submit-doc.md"…}]}`（期望 403）。
7. 父测试 ②③ 因 #6 计入失败（同一断言点）。

修后同一文件 7/7 通过（子测试逐条 `✔`，见 `MEMORY-LOOP-1-scope-green.raw.txt`）。
另有两份**同一份探针**的修前/修后对照表（真实 HTTP + 盘上 frontmatter，45 行逐行）：
`reports\MEMORY-LOOP-1-gate-probe-BEFORE.txt` / `-AFTER.txt`，脚本 `reports\MEMORY-LOOP-1-gate-probe.mjs`。

### 1.5 回滚 + 改动文件清单 + 没覆盖什么

**回滚（任选其一，都不需要理解细节）**

```powershell
# ① 整笔回退（推荐；只回退本次修复这一个提交）
git -C D:\MemoryLib\app revert --no-edit 0211a69

# ② 只把源码退回上一轮的 4a27bdb（保留新增测试，它会重新变红——这正是"判别力"的证据）
git -C D:\MemoryLib\app checkout 4a27bdb68413892e0e7cc7904ccd1edc018036c9 -- `
  memory-lib/src/write-memory.mjs memory-lib/src/localhost-server.mjs `
  memory-lib/src/refinement-jobs.mjs memory-lib/scripts/run-tests.mjs
```

**改动文件清单（本次修复，C1=0211a69，5 个文件）**

| 文件 | 改动性质 |
| --- | --- |
| `memory-lib/src/write-memory.mjs` | 把"container ⇒ 默认 visibility"抽成 `containerDefaultVisibility()`（第 57 行），`baseFrontmatter` 改为调用它（第 64 行）。**表达式逐字符不变**，只为让门禁与写入共用同一个真值源。 |
| `memory-lib/src/localhost-server.mjs` | 删掉 `conclusionScope()`（按层名猜 visibility），新增 `conclusionWriteTarget()`（第 100 行）与 `conclusionWriteDenial()`（第 120 行）；submit 路由的 assertion 改用它（第 1590 行）。 |
| `memory-lib/src/refinement-jobs.mjs` | 仅注释（第 432–437 行）改成与新口径一致的描述；**无行为改动**。 |
| `memory-lib/test/refinement-jobs-submit-scope-http.test.mjs` | **新增**判别测试（3 顶层 + 4 子测试）。 |
| `memory-lib/scripts/run-tests.mjs` | 回归集登记新测试文件（1 行）。 |
| `memory-lib/reports/MEMORY-LOOP-1-dev-report.md` | 本报告的受版本管理副本（交付路径在仓库外，见文首）。 |

**没覆盖什么**（详见 §6）：生产 8787 未部署/未重启、生产 `D:\MemoryLib\data` 未写；`document`/`tool` 结论
"要 admin"这条**新增要求**没有在真实生产身份配置上回归（生产里持有 `memory/platform` 的角色都没有 admin）；
`agent`/`plan`/`profile` 的放宽只有本单测试 + 探针，没有真实接入方用法支撑；"回执可回读"只对持有该层读作用域
的主体保证（与 `/v1/write` 同），没有为"提交者必须能读回"再补机制（属可见性/产品决策面）。

---

## 2. 复核发现与处置

### 2.1 指认本身：`conclusionScope` 与写入实际口径不一致（**成立**）

被指认的代码（修复前，`localhost-server.mjs` 第 81–99 行）：

```js
// curated-shared ⇒ { layer: "memory", visibility: "shared" }
// document       ⇒ { layer: "knowledge", visibility: "shared" }
```

而 `write-memory.mjs` 的 `baseFrontmatter`（第 56–57 行）对**没有显式 visibility** 的写入按 container 决定可见性：
`project ⇒ project / tool|knowledge ⇒ platform / role ⇒ role / 其余 ⇒ private`。于是同一份写入输入：

| 层 | 门禁要求的 scope | 实际落盘的 container / visibility | `/v1/write` 对同一输入的放行 |
| --- | --- | --- | --- |
| curated-shared | `{memory, shared}` | `long-term` / `private` | 200（只要求 propose） |
| document | `{knowledge, shared}` | `knowledge` / `platform`（**所有人可读**） | 200（隐式 platform 不查 admin；**显式** platform 非 admin 400） |
| tool | `{memory, platform}` | `tool` / `platform` | 同上 |
| agent | `{memory, role}` | `role` / `role` | 200 |
| plan / profile | `{memory, private}` | `plan|long-term` / `private` | 200 |

两个方向都错：

- **该严的地方松**：`document` 落盘 visibility 是 `platform`（`principalAllowsContainer` 第 60 行：platform 直接
  allow），而门禁只要求 `{knowledge, shared}` —— 该 scope 在 `resolveRootsForScopes`（`memory-lib.mjs` 第 59–106 行）
  里**没有任何分支**，实测 `count=0 roots=[]`。也就是说这是个"标签"，任何带它的角色都能写出组外可读的记忆：
  实测 `researcher` 形状的角色（无 admin）提交 document ⇒ 200，落盘 `evidence/documents/… visibility: platform`，
  同组另一个 agent/user 能读到（探针第 38 行 `200`）。而 `/v1/write` 对**显式** `visibility:"platform"` 要求
  admin 动作（第 1167 行；实测非 admin 的角色 400 `WRITE_REJECTED`）。
- **该松的地方严**：`curated-shared` 落盘是 `private`（只对写入者自己的 user/agent/role 可读），根本不产生"共享"；
  可门禁却要 `{memory, shared}`。实测：一个"有 propose、没有 memory/shared"的角色（P）用**同一份输入**
  走 `/v1/write` 得到 200、走提交得到 `403 WRITE_SCOPE_DENIED`。代码注释自己写的是"与 /v1/write 同一把尺子
  （propose）"（第 1507 区域），但门禁多要了一个写入口从不要求的 scope。

### 2.2 判定：**是真实的授权门禁缺陷**，处置 = 修门禁（不改可见性）

判据用两条可测标准，都站得住：

1. **不得比写入口更严**：同一份写入输入，`/v1/write` 放行的，提交也必须放行（否则调用方明明能写却被告知无权写，
   且理由是伪造的"SUBMIT_SCOPE_DENIED: SCOPE_DENIED"）。修前实测 403 vs 200。
2. **门禁要求的必须是"写出来的那份记录"的授权**：`platform` 可见性（所有人可读）要走 `/v1/write` 的既有
   admin 规则；`private`（只对自己可读）则没有可要求的读作用域（`{memory, private}` 也是 0 个检索根）。

修法（不改任何可见性判据）：

- `conclusionWriteTarget({layer, container, visibility})`：用 `normalizeContainer` + `containerDefaultVisibility`
  算出**这条结论最终写成的** container / visibility（与 `baseFrontmatter` 同一个函数，不复制表达式）。
- `conclusionWriteDenial({planned, role})`：对这个 visibility 套既有规则
  - `platform` ⇒ 需要 `admin` 动作（`/v1/write` 第 1167 行的原规则）；
  - `project` ⇒ 需要该项目的项目作用域（捕获写入口第 1462 行的原规则；它也正是
    `project-state/<project>` 这条记录的读作用域）。**这条不放宽**；
  - `private / role / agent / user / shared` ⇒ 只按服务端绑定身份（`/v1/write` 对这些可见性本来就只有这一条）。

### 2.3 明确**没有**做的事（避免越界）

- **不改** `container-policy.mjs`（`principalAllowsContainer` / `pathContainer` / `LEGACY` 映射一字未动）。
- **不改** `memory-lib.mjs` 的 `resolveRootsForScopes` / 检索根 / 检索排序（该文件未出现在改动清单里）。
- **不改** `write-memory.mjs` 的默认可见性值（只把同一表达式抽成函数；见 §3 的 before/after 逐行相同读数）。
- 不新增字段：结论里仍然**不能**声明 `visibility`（`CONCLUSION_FIELDS` 未改），本单不替产品决定"提炼结论该
  写成哪种可见性"——所以 `curated-shared` 结论目前仍按写入默认写成 `private`（见 §6 的剩余风险）。

### 2.4 其余两点确认（未改代码）

**(a) 冲突可被显式检查，且不靠"检索结果带 frontmatter"**

- 结构化 409：`refinement-jobs.mjs` 第 465 行 `failure(409, primary.code, …, { conflicts: resolved.conflicts })`，
  路由原样透传（`error.conflicts: [{stable_key, active_id, code, reason}]`）；
- 留盘可查：同冲突也写进 job 记录（第 463 行 `recordConflict` → 第 539–541 行 `needs_review_reason` /
  `conflicts` / `submissions`），`POST /v1/refinement/jobs/get` 能读到；
- 取代链与"默认只见当前有效版本"：`GET` 精确读旧 id + 检索 `include_superseded`；
- 既有测试逐条钉住：`test/refinement-jobs-stable-key-http.test.mjs` 第 245 行（结构化 conflicts）、
  第 264 行（`job.conflicts` 经 get 读回）、第 266 行（`submissions` 历史记录 `SUPERSEDE_REQUIRED` 与时刻）、
  第 332–333 行（检索命中 → 该文件的 `status/stable_key/superseded_by/supersedes` 逐字段连起来）。
- **检索结果项没有加任何 frontmatter 字段**：第 327–333 行的 `versionOf()` 是"先拿检索命中的 path，再读盘上的
  frontmatter"，正是为了避免"给检索塞字段"。本次改动未触碰检索返回值（该文件不在改动清单里）。

**(b) 上一轮 9 条审阅项的落点（`4a27bdb`）**：逐条在 `4a27bdb` 的提交信息里，红→绿原始输出在
`reports\MEMORY-LOOP-1-repair-red-*.raw.txt` → `reports\MEMORY-LOOP-1-repair-green-*.txt` /
`-repair-green-full-run.txt`。本轮没有回退其中任何一条，回归也覆盖了它们（见 §4 的 refinement 10 个文件）。

---

## 3. 这次改动可能影响的既有行为（**每一条都给修前/修后实测读数**）

读数来源：`reports\MEMORY-LOOP-1-gate-probe-BEFORE.txt` / `-AFTER.txt`（同一份探针、同一批夹具、真实 HTTP +
盘上 frontmatter）+ 红/绿测试原始输出。入口 = `POST /v1/refinement/jobs/submit`（受影响）；对照入口 =
`POST /v1/write`（未改代码）。

| # | 入口 × 角色形状 × 层 | 修前实测 | 修后实测 | 是否预期 |
| --- | --- | --- | --- | --- |
| 1 | `/v1/write`（P/Q/admin；curated-shared、document，含显式 shared/private/platform） | 200/200/400/…（探针第 6–11、22–24 行） | **逐行相同**（同编号行） | 未改代码，不变 ✔ |
| 2 | 写入默认可见性：curated-shared | `container=long-term, visibility=private, layer=long-term` | **逐字段相同** | 不变 ✔（`containerDefaultVisibility` 是同一表达式） |
| 3 | 写入默认可见性：document / tool / agent / plan / profile / project-state | `knowledge/platform`、`tool/platform`、`role/role`、`plan/private`、`long-term/private`、`project/project` | **逐字段相同** | 不变 ✔ |
| 4 | 提交 · curated-shared · **无** `{memory,shared}`（P） | `403 WRITE_SCOPE_DENIED`（`SUBMIT_SCOPE_DENIED: SCOPE_DENIED`） | `200 written`，落盘 `curated/shared/ml1s-submit-shared.md`，container/visibility/layer 与 `/v1/write` 那份**逐字段相同** | 修的就是这一格 ✔ |
| 5 | 提交 · curated-shared · 有 `{memory,shared}`（Q / 既有 `pet-assistant` 用例） | `200 written` | `200 written`（回执可读回 200，旁观者 404） | 不变 ✔ |
| 6 | 提交 · document · **无 admin**（Q / P） | `200 written` → 落盘 `evidence/documents/… visibility=platform`，**同组另一 agent/user 可读（200）** | `403 WRITE_SCOPE_DENIED`（`PLATFORM_REQUIRES_ADMIN`），零写入，`evidence/documents` 目录为空 | **有意收紧**（写入口对显式 platform 也是拒的） |
| 7 | 提交 · document · **有 admin**（librarian-admin） | `200 written` | `200 written`，落盘 `knowledge/platform`，旁观者 200 | 不变 ✔（正对照） |
| 8 | 提交 · tool · **无 admin** 但持 `{memory,platform}`（PP） | `200 written` → `tools-memory/… tool/platform` | `403 WRITE_SCOPE_DENIED` | **有意收紧**（同上：写出来是 platform） |
| 9 | 提交 · agent（PP） | `403 WRITE_SCOPE_DENIED` | `200 written`，落盘 `curated/agents/pilot-01/… container=role / visibility=role` | **有意放宽**（旧要求 `{memory,role}` 是 0 检索根的标签；记录只对写入者自己可读） |
| 10 | 提交 · plan（PP） | `403 WRITE_SCOPE_DENIED` | `200 written`，落盘 `plans/… plan/private` | **有意放宽**（同上理由） |
| 11 | 提交 · profile（PP） | `403 WRITE_SCOPE_DENIED` | `200 written`，落盘 `profile/… long-term/private` | **有意放宽**（同上理由） |
| 12 | 提交 · project-state · **缺**该项目作用域（同组同用户、能领） | `403 WRITE_SCOPE_DENIED` | `403 WRITE_SCOPE_DENIED`，零写入 | **不放宽** ✔（与捕获写入口同一规则） |
| 13 | 提交 · project-state · 持有该项目作用域（捕获者本人） | `200 written` | `200 written`，`project-state/<p>/current-state.md visibility=project` | 不变 ✔ |
| 14 | 提交 · `no_durable_fact` 零输出（P，无 `shared` 作用域） | `200`，`receipt.writes=[]` | `200`，`writes=[]` | 不变 ✔ |
| 15 | 提交路由的动作门（`propose` 写 / `search` 读领） | 路由先判，无 propose ⇒ 403 | 同（未改该处代码） | 不变 ✔ |
| 16 | 冲突可见性：409 `error.conflicts` / `job.conflicts` / `submissions` 历史 / 取代链 | 见 §2.4(a) | 同（未改该处代码） | 不变 ✔ |
| 17 | 检索结果形状（不新增 frontmatter 字段） | 结果项只有 path 等既有字段 | 同（未改检索） | 不变 ✔ |
| 18 | 证据可读性 + 证据兼容性（存在/归属/项目）校验顺序 | 写授权 → 证据 → 同键 → 落盘 | 同（只替换了第一段判定内容） | 不变 ✔（`refinement-jobs-submit-http` 全绿） |
| 19 | capture → 待办 → 度量（`/v1/refinement/jobs/metrics`） | 见既有测试 | 同（未改） | 不变 ✔（`refinement-jobs-metrics-http` 全绿） |
| 20 | pet-command 自动捕获（`suppressRefinement`）仍建待办、巡检报告仍不写 | `200 / 待办存在 / 报告不写` | 同 | 不变 ✔（`refinement-jobs-suppress-capture-http` 全绿） |

> 受影响的"消费者"清单（谁读这些值）：`/v1/refinement/jobs/submit` 的调用方（接入 agent / 管家）读
> `403 WRITE_SCOPE_DENIED` 与 `receipt`；`/v1/refinement/jobs/get` 的调用方读 `job.conflicts` 与 `submissions`；
> 检索侧读到的是文件本身（frontmatter 未变）。**没有**任何既有读路径的返回值被改动。

---

## 4. 测试：代码失败与环境失败（分开列）

### 4.1 全量回归（`node scripts\run-tests.mjs`）

- 原始输出：`reports\MEMORY-LOOP-1-scope-full-green.raw.txt`（本次终态树，含新测试）
- 结果：**7 test file(s) failed**，**0 个代码失败**。7 个失败逐个核对，全部是"子进程起不来"的环境失败：

```
FAIL credential-store.test.mjs      (spawn EPERM：wincred 助手 execFile)
FAIL m1-4-migration.test.mjs        (CLI 子进程未运行 ⇒ 拿到 undefined)
FAIL channel-equivalence.test.mjs   (spawn EPERM: spawnStdio)
FAIL d8-capture-deployment.test.mjs (部署同步脚本子进程未运行 ⇒ null !== 0)
FAIL d9-capture-deployment.test.mjs (同上)
FAIL id1-inventory-cli.test.mjs     (子进程 0xC0000142 ⇒ 沙箱拒绝 spawn)
FAIL id1-bootstrap-cli.test.mjs     (同上)
```

- 基线（同一台机器、同一沙箱，`reports\MEMORY-LOOP-1-slice4-baseline-full.raw.txt`，基线 sha 之前的树）：
  **9 test file(s) failed**。本次 7 个 ⊂ 基线 9 个（多出来的两个 `d6-learning-agent` / `d6-agent-runtime`
  是已知的同类间歇失败，本次通过）。**没有新增失败**。
- 证据（同一次全量输出里）：`Error: spawn EPERM at ChildProcess.spawn`、
  `SKIPPED: subprocess spawning is unavailable here (EPERM) -> this check did NOT run`。没有一条落在本次改动的
  文件/断言里。
- 新测试在全量里也是绿的：`=== refinement-jobs-submit-scope-http.test.mjs ===` 下 3 个顶层测试全 `✔`（含 4 个子测试）。

### 4.2 定向回归（每一条都留了原始输出）

- refinement 10 个文件（`refinement-jobs-http`、`-suppress-capture-http`、`-submit-http`、`-submit-scope-http`、
  `-submit-writefail`、`-metrics-http`、`-stable-key-http`、`-repair`、`m2-refinement-closure`、
  `m2-refinement-followup-http`）：**全绿**（`reports\MEMORY-LOOP-1-scope-targeted-green.raw.txt`，每个文件 `ℹ fail 0`）。
- 受影响面 24 个文件（`m1-4-write-entrypoints`、`m1-2-container-policy`、`m1-2-followup-isolation`、
  `m1-2-followup-audit`、`mem-write-1-mcp-visibility`、`mcp`、`capture-attr`、`d29-write`、`m1-1-e2e`、
  `maint4-frontmatter(-http)`、`pet`、`r10-queue-redaction`、`d15-capture-partial`、`retrieval-p0`、`contract`、
  `contract-table-guard`、`identity-required-call-sites`、`input-validation-4xx`、`m1-6-daily-write`、
  `dayrecall-http`、`scenario-recall-http`、`health-consistency`、`index-failure-health`）：**全绿**
  （`reports\MEMORY-LOOP-1-scope-affected-green.raw.txt`，每个文件 `ℹ fail 0`）。

### 4.3 环境说明（"环境失败"与"代码失败"的分界）

本机沙箱**不许捕获子进程的标准输出**（`spawn EPERM`），它只影响那些**必须 spawn 子进程**的测试（wincred 助手、
CLI 包装、部署同步脚本、`node --test` 的目录展开）。这类失败在基线 sha 上同样存在（9 个），本次 7 个是它的子集。
本次改动涉及的每个入口都有**不走子进程**的等价测试（真实 HTTP + 盘上文件），因此 §3 的读数不受该限制影响。

---

## 5. 规矩自查

| 红线 | 状态 | 证据 |
| --- | --- | --- |
| 只读生产 `D:\MemoryLib\data`、不部署/不重启 8787 | 遵守 | 所有实验在 `os.tmpdir()` 的临时 dataRoot + 临时 registry 副本上；未触碰 `data/`、未起 8787；探针/测试结束 `fs.rm` 清理。 |
| **零模型** | 遵守 | 改动只涉及门禁判定；`src/llm.mjs`、`pet.mjs`、`learning-agent.mjs` 未动；新测试不打模型调用（`libFactory` 用 `vectorLane: { probe: false }`）。 |
| 不新增依赖 | 遵守 | `package.json` / lockfile 未改；新代码只用既有 import（`container-policy.mjs`、`write-memory.mjs`）。 |
| **不改可见性判据 / container-policy / 检索根 / 检索排序** | 遵守 | `container-policy.mjs`、`memory-lib.mjs`、`read-only-core.mjs` **不在改动清单**；`write-memory.mjs` 的默认可见性表达式逐字符保留（见 §3 第 2/3 行：落盘读数修前=修后）。 |
| 不改本单范围（不做 UI、不做自动提炼、不改检索排序） | 遵守 | 改动仅 5 个文件，全部在提炼提交这条链上。 |
| 先红后绿、断言打具体值 | 遵守 | §1.4：同一版 7 个断言点，修前全红、修后全绿；断言都是 403/200、`container`/`visibility`/`layer` 具体值、盘上路径与文件内容，不用恒真断言。 |
| 分小步提交、不改写历史 | 遵守 | 代码修复 1 个提交 + 报告 3 个提交（WIP / 记 sha / READY），全程 `--no-amend`（无 amend/rebase）。 |
| 不用 `;` 串"跑测试 + 提交" | 遵守 | 每条命令只做一件事；测试输出先落盘（`reports\*.raw.txt`），提交是独立命令。 |
| 报告不含 `acceptance`、首行 `STATUS: READY` 才交接 | 遵守 | 文件名 `MEMORY-LOOP-1-dev-report.md`；本版首行是 `STATUS: WIP`，收口时只改首行。 |

---

## 6. 没覆盖什么 / 剩余风险（如实列出）

1. **提炼结论写成哪种可见性，仍由写入默认值决定**（产品决策面，本单不碰）：`curated-shared` 结论依然写成
   `visibility=private`（只对写入者自己的 user/agent/role 可读）。本次只是让门禁**如实**按这个可见性授权，
   并没有让结论变"组内共享"。若产品要"无 workspace 的提炼结论 = 组内共享"，需要另一单（给结论加 visibility
   入参并按 `/v1/write` 的显式规则校验，或调整写入默认），那会改可见性判据 ⇒ 必须产品裁决。
2. **新增的"document/tool 结论要 admin"没有在生产身份配置上回归**：生产 `identity.json` 里持有
   `memory/platform` 的角色（`home-owner-agent`、`home-friend-agent`、`ops-collector`、`ops-agent`）都**没有
   admin 动作** ⇒ 若将来用它们提交 `document`/`tool` 结论，会得到 `403 PLATFORM_REQUIRES_ADMIN`。这是本次
   **收紧**的一部分（与 `/v1/write` 显式 platform 的规则一致），但"哪些角色该有 admin / 该不该写 platform 可见
   记忆"属产品决策。
3. **`agent` / `plan` / `profile` 三条放宽只有本单测试与探针**，没有真实接入方的用例；它们的落盘都是 `private`
   类可见性（不产生跨人可见性），所以放宽不带来"看得更多"。
4. **"回执可回读"只对持有该层读作用域的主体保证**：没有 `{memory, shared}` 的角色（本次的 P）能写
   `curated-shared`，但读不回（`/v1/get` 404）——与 `/v1/write` 完全同形（写入口只要求 propose）。若产品要求
   "提交者必须能读回自己的结论"，需要补"提交者必须具备该层读作用域"的策略（那与本次"与写入口同口径"冲突，
   要先由产品裁决）。
5. **环境限制**：本沙箱不许 spawn 子进程，7 个文件的全量失败属环境（§4.1）；这些文件**在本次改动前后同样失败**，
   本次没有"通过它们来证明没回归"。
6. **未做生产部署**（不归本单）：`0211a69` 未经 DEPLOY 流程上线，生产仍是旧代码。

## 7. 复跑命令（不依赖任何长期状态）

```powershell
# 判别测试（修后应 7/7 通过；把 src 退回 4a27bdb 应 7 红）
cd D:\MemoryLib\app\memory-lib
node test\refinement-jobs-submit-scope-http.test.mjs

# refinement 切片 10 个文件
node test\refinement-jobs-http.test.mjs
node test\refinement-jobs-suppress-capture-http.test.mjs
node test\refinement-jobs-submit-http.test.mjs
node test\refinement-jobs-submit-scope-http.test.mjs
node test\refinement-jobs-submit-writefail.test.mjs
node test\refinement-jobs-metrics-http.test.mjs
node test\refinement-jobs-stable-key-http.test.mjs
node test\refinement-jobs-repair.test.mjs
node test\m2-refinement-closure.test.mjs
node test\m2-refinement-followup-http.test.mjs

# 全量（预期 7 个环境失败，均与基线同一集合）
node scripts\run-tests.mjs

# 修前/修后对照表（真实 HTTP + 盘上 frontmatter；夹具自建临时 dataRoot）
node D:\MemoryLib\reports\MEMORY-LOOP-1-gate-probe.mjs AFTER
```
