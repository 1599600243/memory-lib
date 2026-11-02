# 可见性判定：唯一入口（2026-10-30）

## 之前的问题（已核实，不是估计）

我先前说"144 处判定"是**错的**——那是 grep 到 `visibility` 这个词的次数。真实统计：

```
principalAllowsContainer 调用      17 处（集中函数，已复用）
visibility === "xxx" 直接比较      29 处
其中真正参与判定的                 约 9 处
```

分散的后果已经出现过两次：控制台按身份筛记忆筛出空、写回 403。

## 现在

```
src/visibility.mjs :: canSeePath({ principal, dataRoot, filePath, frontmatter })
  ↑ 读侧唯一入口
src/container-policy.mjs :: principalAllowsContainer()   ← 保留，是 canSeePath 的下层
src/write-authorization.mjs                               ← 写侧独立（下一步收敛）
```

`memory-lib.mjs` 的 `principalAuthorizesPath` 现在是：

```js
const fm = frontmatter ?? (text ? parseFrontmatter(text).frontmatter : {});
return canSeePath({ principal: optionsPrincipal, dataRoot, filePath, frontmatter: fm });
```

## 怎么证明"抽取没改变行为"

`test/visibility-equivalence.test.mjs`：

```
拿真实语料（data/memory 下 4,410 个 .md）
× 真实身份（identity.json 里 40 个 agent/role 组合）
= 176,400 次判定
逐条比对 "冻结的旧实现" vs "canSeePath"
→ 100% 一致才允许合并
```

跑法：

```powershell
cd app/memory-lib
node --test test\visibility-equivalence.test.mjs
```

## 顺带修掉的测试债

`test/visibility-unknown-1.test.mjs` 原本拷贝生产库里的三个真实文件作为 fixture。
2026-10-30 那两个文件被从 `unknown/private` 修正为 `user-owner/user`（真实数据卫生修复），
测试场景随之消失 → 改为**自造 fixture**，不再绑生产数据。

## 下一步（未做）

- `write-authorization.mjs` 的写侧仍有一套独立判定；应收敛到同一套语义，并用
  "读能看见 ⇒ 写能写回" 的矩阵测试锁住。
- 之后新增可见性取值（如 `team`）只需改 `container-policy.mjs` 一处。
