# DSH 插件取舍（2026-10-30）

> 两份清单来自用户整理：① UI 组件/主题类 ② 让 AI 产出好看页面的工具类。
> 结论分三类：**装**（运行时直接受益）、**吸收**（把方法写成我们自己的规范/技能）、**跳过**。

## 结论表

| 项目 | 类别 | 处理 | 理由 |
|---|---|---|---|
| **dsh-visualize** | ② | ✅ **已装**（本地离线） | 在对话里用沙盒 iframe 渲染 HTML 片段，正好解决“边设计边看”。BSD-3、无运行时依赖、无 prepare 脚本、源码无外联 |
| **dsh-genui** | ② | ⏸ 待定 | 与 visualize 功能重叠（对话内渲染 + 导出 HTML）。先用 visualize，不够再补 |
| **dsh-web-artifact-designer** | ② | ✅ **已吸收** | 它的价值是生成规范，不是运行时。已写成 `~/.dsh/skills/frontend-design/SKILL.md`（token/组件/三态/数字/自检 + 反 AI 味六条） |
| dsh-fuse | ② | ⏭ 跳过 | 需要交互式逐元素微调，我没有可视化输入，收益低 |
| draw2code | ② | ⏭ 跳过 | 需要人先画草图；我们不画线框 |
| dock / dock-files / dock-editor | ① | ⏭ 跳过 | VSCode 式多面板基座，只有“把控制台做成 DSH 插件”才需要，已明确不做 |
| @dsh-ui/react / dsh-plugin-template | ① | ⏭ 跳过 | 插件作者的构建栈；我们不写插件 |
| dsh-dream-skin / dsh-ui-liquid-glass | ① | ⏭ 跳过 | 只改 DSH 自身外观，与记忆库控制台无关 |
| dsh-smooth-stream | ① | ⏭ 跳过 | 只影响流式渲染顺滑度；当前不卡，等真有卡顿再说 |
| awesome-dsh-plugin / dsh.so | ① | ⏭ 跳过 | 插件目录/市场，仅供检索 |

## 已装内容（可回滚）

```
包          @nagi-ovo/dsh-visualize@0.1.7（BSD-3-Clause）
来源        git clone github.com/Nagi-ovo/dsh-visualize（codeload 被墙，走 git）
本地位置    ~/.dsh/profiles/web/local-plugins/dsh-visualize
接入方式    pnpm add file:./local-plugins/dsh-visualize（离线）
安装前备份  ~/.dsh/profiles/web/package.json.bak-20261030-212127
            ~/.dsh/profiles/web/pnpm-lock.yaml.bak-20261030-212127
```

**审计结果**：无 `prepare` 脚本、运行时零依赖（只有 DSH 的 peer 依赖）、源码无 `fetch` 外联、许可证 BSD-3。

**注意**：`pnpm add` 会按 `package.json` 裁剪 node_modules，首次安装时把 `@tencent-connect/dsh-qqbot@0.5.3` 误删，已用 `pnpm add --offline` 恢复并写回 `package.json`。

## 生效条件

插件装了但**没生效**——DSH 的插件层在启动时加载，需要重启 `dsh web`。重启会中断当前对话窗口（会话历史在磁盘，可恢复）。

## 回滚

```powershell
cd ~/.dsh/profiles/web
cp package.json.bak-20261030-212127 package.json
pnpm install --offline
```
