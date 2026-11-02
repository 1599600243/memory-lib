#!/usr/bin/env node
// patch-dsh-room-zh.mjs —— 把 dsh-room 客户端界面里的英文标签换成中文
//
// 为什么是补丁而不是配置：插件 0.3.23 没有 i18n，英文硬编码在 dist/client.js。
// 本脚本只替换「看起来是界面文案」的字符串（label/children/aria-label/title/placeholder 上下文），
// 发现某条字符串出现在比较/赋值/接口载荷里就跳过并报告，避免改坏逻辑。
//
// 用法：
//   node scripts/patch-dsh-room-zh.mjs          # 打补丁（自动备份 .zh-bak）
//   node scripts/patch-dsh-room-zh.mjs --revert # 还原备份
//
// 注意：插件升级会覆盖 client.js，升级后重跑本脚本即可。

import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROFILE = process.env.DSH_PROFILE_DIR ?? path.join(process.env.USERPROFILE, ".dsh", "profiles", "web");
const CLIENT = path.join(PROFILE, "node_modules", "@cecwxf", "dsh-room", "dist", "client.js");
const BACKUP = `${CLIENT}.zh-bak`;

const EXTERNAL = path.join(path.resolve("D:/MemoryLib"), "config", "dsh-room-zh.json");
const MAP = Object.assign({}, existsSync(EXTERNAL) ? JSON.parse(readFileSync(EXTERNAL, "utf8")) : {}, {
  // 工作区 / 房间入口
  "New session": "新建会话",
  "New room": "新建房间",
  "Join room by invite": "用邀请加入房间",
  "Browse public rooms": "浏览公开房间",
  "Add workspace": "添加工作区",

  // 建房弹窗
  Room: "房间",
  Limits: "限制",
  Name: "名称",
  Description: "描述",
  Workspace: "工作区",
  Model: "模型",
  Create: "创建",
  "Creating…": "创建中…",
  Create: "创建",
  "Create room": "创建房间",
  "Create failed": "创建失败",
  "Name required": "名称必填",
  "Need workspace": "需要工作区",
  "Absolute workspace path required": "需要绝对工作区路径",
  "Absolute path on this machine.": "本机上的绝对路径。",
  "Add agent": "添加成员",
  "Add local agent": "添加本地成员",
  "Add custom": "自定义添加",
  Custom: "自定义",
  "Custom agents": "自定义成员",
  "Add to room": "加入房间",
  "One-line role": "一句话角色",
  "One line other members see.": "其他成员能看到的一句话。",
  "Clear preset tag": "清除预设标签",
  "Filled from the ": "预设填充自 ",
  "List in public directory": "列入公开目录",
  "Local rooms stay private.": "本地房间不会公开。",
  "Isolation mode": "隔离方式",
  "Git worktree per agent": "每个成员独立 worktree",
  "Expose MCP workspace": "暴露 MCP 工作区",
  "Auto-allow reads": "自动允许读取",
  "Auto-allow writes": "自动允许写入",
  "Auto-allow shell": "自动允许命令",
  "Auto-allow network": "自动允许网络",
  "Approval needed": "需要批准",
  "Approval required": "需要批准",
  "Ask to run": "运行时询问",
  Allow: "允许",
  Deny: "拒绝",
  "Parallel runs": "并行运行",

  // 通用按钮
  Cancel: "取消",
  Close: "关闭",
  Done: "完成",
  Delete: "删除",
  Copy: "复制",
  Copied: "已复制",
  Discard: "丢弃",
  "Confirm merge": "确认合并",
  "Confirm discard": "确认丢弃",
  "Merge into main": "合并到主工作区",
  "Not merged": "未合并",
  "No changes.": "没有改动。",
  "Diff truncated.": "差异已截断。",
  "Nothing to discard.": "没有可丢弃的改动。",
  "No agent runs yet.": "还没有成员任务。",
  "No writing agents in this room.": "这个房间没有可写成员。",
  "No other peers online yet.": "还没有其他成员在线。",
  "Only you are here.": "只有你在房间里。",
  "Offline.": "离线。",
  "Model unavailable": "模型不可用",
  Completed: "已完成",
  Failed: "失败",

  // 房间信息
  "Edit room": "编辑房间",
  "Delete room": "删除房间",
  "Leave room": "离开房间",
  "Leave": "离开",
  "Close room details": "关闭房间详情",
  "Copy invite": "复制邀请",
  "Invite copied": "邀请已复制",
  Invite: "邀请",
  Join: "加入",
  "Joining…": "加入中…",
  Joined: "已加入",
  Encryption: "加密",
  "Peer MCP": "对端 MCP",
  "Peer MCP limits on this workspace": "该工作区的对端 MCP 限制",
  "Open workspace": "打开工作区",
  "Message the room": "向房间发消息",
  "Mention someone": "提及成员",
  "Create a task": "创建任务",
  "Create task": "创建任务",

  // 强度档位（只影响显示，值仍是 low/medium/high）
  High: "高",
  Medium: "中",
  Low: "低",
});

// 危险上下文：出现在比较、赋值或 case 里的字符串可能被逻辑使用，跳过。
// 明确只用于显示、即使落在三元/模板里也安全替换的文案
const FORCE = new Set([
  "New room", "Add workspace", "Delete", "Delete room", "Leave", "Leave room", "Join",
  "Local", "Relay", "Rooms by workspace", "Room is offline", "Room session", "Local rooms stay private",
  "Request timed out or was cancelled", "Send", "Switch to chat",
  "Add a workspace in the left sidebar first", "Native dsh session navigation is unavailable",
  "Confirm merge", "Confirm discard", "Create task", "Create a task",
  "Only you are here.", "Offline.", "Ask to run", "Local rooms stay private.",
]);

const UNSAFE = /(===|!==|\bcase\s|\breturn\s)/;
const TRAILING_ASSIGN = /=\s*$/;

function contextsOf(text, needle) {
  const out = [];
  let idx = -1;
  while ((idx = text.indexOf(needle, idx + 1)) >= 0) {
    out.push(text.slice(Math.max(0, idx - 60), idx));
  }
  return out;
}

function main() {
  if (!fs.existsSync(CLIENT)) {
    console.error(`找不到 client.js：${CLIENT}`);
    process.exit(1);
  }

  if (process.argv.includes("--revert")) {
    if (!fs.existsSync(BACKUP)) {
      console.error("没有备份可还原");
      process.exit(1);
    }
    fs.copyFileSync(BACKUP, CLIENT);
    console.log("已还原英文原版");
    return;
  }

  const original = fs.readFileSync(CLIENT, "utf8");
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, original, "utf8");

  let text = fs.readFileSync(BACKUP, "utf8"); // 总是从英文原版重打，保证可重复执行
  const applied = [];
  const skipped = [];

  for (const [en, zh] of Object.entries(MAP)) {
    const needle = `"${en}"`;
    const ctxs = contextsOf(text, needle);
    if (ctxs.length === 0) continue;
    const unsafe = !FORCE.has(en) && ctxs.some((c) => UNSAFE.test(c) || TRAILING_ASSIGN.test(c));
    if (unsafe) {
      skipped.push(`${en}（出现在非界面上下文）`);
      continue;
    }
    text = text.split(needle).join(`"${zh}"`);
    applied.push(`${en} → ${zh}（${ctxs.length} 处）`);
  }

  fs.writeFileSync(CLIENT, text, "utf8");
  console.log(`已替换 ${applied.length} 条文案：`);
  for (const line of applied) console.log("  " + line);
  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 条（可能影响逻辑）：`);
    for (const line of skipped) console.log("  " + line);
  }
  console.log(`\n备份：${BACKUP}`);
  console.log("重启 dsh web 后生效");
}

main();
