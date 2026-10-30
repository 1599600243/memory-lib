// 一次性补丁：把 P2（读群+挑话+续话）接进适配器。锚点找不到就报错退出，避免再次切错。
import { readFileSync, writeFileSync } from "node:fs";

const P = "D:/MemoryLib/adapters/napcat/index.mjs";
let src = readFileSync(P, "utf8").replace(/\r\n/g, "\n"); // 统一成 LF，否则多行锚点匹配不上
const fail = (m) => { console.error("✗ " + m); process.exit(1); };
const must = (cond, m) => { if (!cond) fail(m); };

// (a) 修掉被写进注释里的去重判断
const badDedup = '// 用绝对差：测试会注入固定 now，减法会出现巨大负值导致误判成"重复"\\n      if (Math.abs(now() - st.mtimeMs) < DEDUP_TTL_MS) fresh = false;';
if (src.includes(badDedup)) {
  src = src.replace(badDedup,
    '// 用绝对差：测试注入固定 now 时，减法会出现巨大负值导致误判成"重复"\n      if (Math.abs(now() - st.mtimeMs) < DEDUP_TTL_MS) fresh = false;');
  console.log("✓ 去重判断已修复");
} else {
  console.log("· 去重判断无需修复（或已修）");
}

// (b) import
const oldImport = 'speakerLabel, isRunawayRequest, rateLimitAllows, mergeMemoryTexts } from "./resolve.mjs";';
must(src.includes(oldImport), "import 行没找到");
src = src.replace(oldImport,
  'speakerLabel, isRunawayRequest, rateLimitAllows, mergeMemoryTexts, appendGroupBuffer, decideGroupProactive, isEngaged, renderGroupTranscript } from "./resolve.mjs";');

// (c) 状态 map
const mapAnchor = '  const groupSendLog = new Map(); // groupId -> 最近发送时间戳';
must(src.includes(mapAnchor), "groupSendLog 锚点没找到");
src = src.replace(mapAnchor, mapAnchor
  + '\n  const groupBuffer = new Map(); // groupId -> 最近群消息（仅内存，不入库）'
  + '\n  const groupLastSpokeAt = new Map(); // groupId -> 上次在群里说话的时间'
  + '\n  const groupSpokenSince = new Map(); // groupId -> 连续对话窗口内已说条数');

// (d) verdict 段：先记缓冲，再判断续话
const oldVerdict = [
  '  const verdict = shouldHandle(event, {',
  '      selfId,',
  '      aliases: cfg.bot?.aliases ?? [],',
  '      groupAllow: cfg.bot?.groupAllow ?? [],',
  '    });',
  '    if (!verdict.ok) {',
  '      if (verdict.reason && !["not-addressed", "group-not-allowed"].includes(verdict.reason)) {',
  '        log(`忽略（${verdict.reason}）`);',
  '      }',
  '      return;',
  '    }',
  '    const identity = resolveIdentity(readIdentities(), { channel: cfg.channel, uid: verdict.uid });',
].join("\n");
must(src.includes(oldVerdict), "verdict 段没找到");

const newVerdict = [
  '  const verdict = shouldHandle(event, {',
  '      selfId,',
  '      aliases: cfg.bot?.aliases ?? [],',
  '      groupAllow: cfg.bot?.groupAllow ?? [],',
  '    });',
  '',
  '    const senderNameRaw = event.sender?.card || event.sender?.nickname || "";',
  '    const earlyIdentity = resolveIdentity(readIdentities(), { channel: cfg.channel, uid: String(event.user_id ?? "") });',
  '',
  '    // P2：白名单群里**所有**消息都进内存缓冲（不管有没有叫她），她才有"群里刚才在聊什么"；缓冲不入库。',
  '    const gidOfEvent = String(event.group_id ?? "");',
  '    if (gidOfEvent && (cfg.bot?.groupAllow ?? []).map(String).includes(gidOfEvent)) {',
  '      groupBuffer.set(gidOfEvent, appendGroupBuffer(groupBuffer.get(gidOfEvent) ?? [], {',
  '        label: speakerLabel({ scope: "group", identity: earlyIdentity, senderName: senderNameRaw, uid: String(event.user_id ?? "") }),',
  '        text: verdict.text ?? "",',
  '        at: now(),',
  '      }, { max: Number(cfg.bot?.groupBufferSize ?? 30) }));',
  '    }',
  '',
  '    // 她刚在群里说过话的 15 分钟内：别人接着聊，她不@也能接一句（最多 3 条，防自嗨）',
  '    if (!verdict.ok && verdict.reason === "not-addressed" && gidOfEvent) {',
  '      const engaged = isEngaged({',
  '        now: now(),',
  '        lastSpokeAt: groupLastSpokeAt.get(gidOfEvent) ?? 0,',
  '        spokenSince: groupSpokenSince.get(gidOfEvent) ?? 0,',
  '        cfg: cfg.proactive ?? {},',
  '      });',
  '      if (engaged && earlyIdentity) {',
  '        verdict.ok = true;',
  '        verdict.scope = "group";',
  '        verdict.groupId = gidOfEvent;',
  '        verdict.uid = String(event.user_id ?? "");',
  '        log(`群 ${gidOfEvent} 连续对话窗口内，未@也接话`);',
  '      }',
  '    }',
  '',
  '    if (!verdict.ok) {',
  '      if (verdict.reason && !["not-addressed", "group-not-allowed"].includes(verdict.reason)) {',
  '        log(`忽略（${verdict.reason}）`);',
  '      }',
  '      return;',
  '    }',
  '    const identity = earlyIdentity;',
].join("\n");
src = src.replace(oldVerdict, newVerdict);

// (e) 发送后记录"上次说话时间"（供续话窗口用）
const oldSend = '      await reply(verdict.scope, verdict.groupId ?? verdict.uid, answer);\n      log(`发送用时 ${now() - ts}ms`);';
must(src.includes(oldSend), "reply 段没找到");
src = src.replace(oldSend, oldSend
  + '\n      if (verdict.scope === "group") {'
  + '\n        groupLastSpokeAt.set(verdict.groupId, now());'
  + '\n        groupSpokenSince.set(verdict.groupId, (groupSpokenSince.get(verdict.groupId) ?? 0) + 1);'
  + '\n      }');

// (f) 替换 startProactive（用 startProactive 之后的下一个 connect 作为结束边界）
const spStart = src.indexOf('  function startProactive() {');
must(spStart > 0, "startProactive 没找到");
const spEnd = src.indexOf('  function connect() {', spStart);
must(spEnd > spStart, "startProactive 结束边界没找到");
const newProactive = [
  '  // P2 主动发言：每小时看一次「这一小时群里聊了什么」，30% 概率挑一句能接的话，',
  '  // 内容**基于真实聊天记录**（v1 是对着空气冒泡）。',
  '  function startProactive() {',
  '    const pcfg = cfg.proactive ?? {};',
  '    if (!pcfg.enabled) { log("主动发言：未启用"); return; }',
  '    const tickMs = Math.max(60_000, Number(pcfg.tickMinutes ?? 60) * 60_000);',
  '    proactiveTimer = setInterval(async () => {',
  '      const today = localDayKey(now());',
  '      if (proactiveDaily.date !== today) { proactiveDaily.date = today; proactiveDaily.count = 0; }',
  '      const gids = Array.isArray(pcfg.groups) ? pcfg.groups.map(String) : [];',
  '      for (const gid of gids) {',
  '        const decision = decideGroupProactive({',
  '          now: now(),',
  '          cfg: pcfg,',
  '          buffer: groupBuffer.get(gid) ?? [],',
  '          lastSpokeAt: groupLastSpokeAt.get(gid) ?? 0,',
  '          dailyCount: proactiveDaily.count,',
  '        });',
  '        if (!decision.speak) { log(`主动发言跳过（群${gid}: ${decision.reason}）`); continue; }',
  '        try {',
  '          const transcript = renderGroupTranscript(groupBuffer.get(gid) ?? [], { max: Number(pcfg.transcriptLines ?? 20) });',
  '          const msgs = buildChatMessages({',
  '            persona, styleSamples, memoryText: "", history: [], scope: "group",',
  '            userText: [',
  '              "（这是群里最近的聊天记录，你在旁边潜水看着。现在想插一句。）",',
  '              transcript,',
  '              "",',
  '              "只挑一个你在意或能接上的点，像群里的人一样自然说一句，1~2 句。",',
  '              "不要总结大家说了什么，不要逐条回应，不要点名，不要问在吗。",',
  '            ].join("\\n"),',
  '          });',
  '          const answer = await chat(msgs);',
  '          if (!answer?.trim()) continue;',
  '          await reply("group", gid, answer.trim());',
  '          const t = now();',
  '          groupLastSpokeAt.set(gid, t);',
  '          groupSpokenSince.set(gid, 0);',
  '          proactiveDaily.count += 1;',
  '          lastSpokeAt = t;',
  '          log(`主动插话 → 群 ${gid}：${answer.trim().slice(0, 60)}`);',
  '        } catch (err) {',
  '          log(`主动插话失败（群${gid}）: ${err.message}`);',
  '        }',
  '      }',
  '    }, tickMs);',
  '    proactiveTimer.unref?.();',
  '    log(`主动发言 v2：每 ${tickMs / 60_000} 分钟读一次群聊，概率 ${pcfg.probability ?? 0.3}，静默 ${pcfg.quietMinutes ?? 30} 分钟，上限 ${pcfg.dailyLimit ?? 4} 条/天，作息 ${(pcfg.quietHours ?? [2, 9]).join("-")} 点，至少 ${pcfg.minMessages ?? 5} 条群消息才考虑`);',
  '  }',
  '',
].join("\n");
src = src.slice(0, spStart) + newProactive + src.slice(spEnd);

writeFileSync(P, src, "utf8");
console.log("✓ 补丁完成");

