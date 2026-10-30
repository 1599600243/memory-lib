# 发布与同步规则（2026-10-28 起）

## 三个位置，各管一件事

| 位置 | 角色 | 有无历史 | 远端 |
|---|---|---|---|
| `D:\MemoryLib\app` | **开发主库**（生产跑的就是它） | ✅ 605 个提交 | ❌ 无（老远端 `openclaw-memory-portable` 已于 2026-10-28 删除，本地 remote 改名为 `old-deleted-2026-10-28` 留痕） |
| `D:\MemoryLib` | 运维/派单/报告仓库 | ✅ | ❌ 无（仅本地） |
| `I:\memory-lib` | **公开快照**（对外发布） | 只有 1 个初始提交 | ✅ `github.com/1599600243/memory-lib`（PUBLIC） |

## 规矩

1. **开发只在 `D:\MemoryLib\app` 做**，不要在 `I:\memory-lib` 里写功能——那里是快照。
2. **发布 = 重建快照**，用脚本：`pwsh -NoProfile -File D:\MemoryLib\scripts\build-public-repo.ps1`
   - 它会：复制 → 裁剪（`dsh-control`、`dsh-memory-capture`、`reports`、`orders`、事故文档、`data/logs/node_modules`）→ 脱敏（本机绝对路径 → 相对/占位）→ 自查；
   - 之后再 `cd I:\memory-lib; git add -A; git commit; git push`。
3. **公开仓库永远不含**：`data/`、`logs/`、`state/`、`indexes/`、`node_modules/`、`reports/`、`orders/`、`scripts/dsh-control/`、`*.log`、任何 secret。
4. 推送前必须过一遍脚本打印的「本机痕迹 = 0 / 真 secret = 0」。

## 历史备份（重要）

```
I:\backups\memory-lib-app-2026-10-28.bundle   3.3 MB，605 个提交
```

**这是唯一的异地历史副本**（老远端已删）。恢复方式：

```bash
git clone I:\backups\memory-lib-app-2026-10-28.bundle restored
```

建议每次大节点后重新打一个（`git -C D:\MemoryLib\app bundle create <新文件> --all`）。

## 本机网络限制（会影响部署验证）

| 域名 | 本机可达 | 影响 |
|---|---|---|
| `api.github.com` | ✅ 200 | `gh`、`git push` 正常 |
| `github.com` | ❌ 超时 | **网页打不开、`gh auth refresh` 的设备授权页也打不开** |
| `objects.githubusercontent.com` | ❌ 超时 | 网页文件预览不可用 |

⇒ 在**这台机器**上 `git clone https://github.com/...` 会失败。要做"真实部署模拟"，要么先起代理（本机本来有 7890，现在没跑），要么从别的机器/网络 clone。

## 老仓库处置记录

- `1599600243/openclaw-memory-portable`（PRIVATE）：2026-10-28 由用户删除；
- 删除前核对：远端只停在 2026-09-21，本地领先 **448 个提交**，issues/releases/tags 全 0，**远端无任何独有内容**；
- 本地 `D:\MemoryLib\app` 的 remote 已改名 `old-deleted-2026-10-28`（不删配置，留痕）。
