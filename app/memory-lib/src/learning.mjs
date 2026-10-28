// memory-lib — learning API (v1). File-first storage under learningRoot.
// Data structures follow the learn-anything methodology (adapted):
//   plan     = learning map: modules with weight/difficulty/dependencies
//   progress = per-module status / mastery / attempts
//   review   = spaced repetition (Ebbinghaus 4 rounds: 1/7/16/35 days)
//   profile  = learner profile
// Storage: learningRoot/<sanitized-topic>/{plan,progress,review,profile}.json
// All writes atomic (temp + rename). Zero ledger dependency (file is truth).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteFile } from "./atomic-write.mjs";
import { requirePrincipal } from "./identity-guard.mjs";

const REVIEW_INTERVALS_DAYS = [1, 7, 16, 35]; // Ebbinghaus 4 rounds
const MAX_ROUND = REVIEW_INTERVALS_DAYS.length; // after round 4 -> mastered interval keeps 35d

export function sanitizeTopic(topic) {
  return String(topic ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled";
}

export function topicDir(learningRoot, topic) {
  return path.join(learningRoot, sanitizeTopic(topic));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  // ATOMICWRITE-1：收敛到统一助手（rename 遇 EPERM/EACCES/EBUSY 会短退避重试）。
  await atomicWriteFile(file, JSON.stringify(data, null, 2) + "\n");
}

// Due selection is shared by the per-topic and the cross-topic (aggregate) reads so
// both report identical item fields: { module_id, round, next_due }.
function dueTime(item) {
  if (!item || !item.nextDue) return null;
  const at = new Date(item.nextDue).getTime();
  return Number.isFinite(at) ? at : null;
}

function dueEntriesFrom(items, nowMs) {
  return Object.entries(items ?? {})
    .filter(([, item]) => {
      const at = dueTime(item);
      return at !== null && at <= nowMs;
    })
    .map(([moduleId, item]) => ({ module_id: moduleId, round: item.round, next_due: item.nextDue }));
}

export function createLearningApi(learningRoot) {
  // VISIBILITY-FIX-1：学习读路径此前**完全不接身份**（只有动作门 `learning`）。
  // 实测部署 registry 里有**两个**角色带该动作（`pilot-01/learner`、`pilot-01/pet`）⇒ 当下即可读。
  // 而本存储**没有归属字段**（plan/progress/review 只按 topic 分目录）⇒ 无法按身份收窄，
  // 因此这里只做**必须给身份**这一层（明确拒绝，而不是"没身份就当无主数据全给"）。
  // 更细的"哪个身份能读哪个 topic"需要先给学习数据补归属字段，属后续产品决策。
  const needPrincipal = (principal, what) => requirePrincipal(principal, `learning.${what}`);

  // --- plan (learning map) ---
  async function getPlan(topic, principal = null) {
    needPrincipal(principal, "getPlan");
    const file = path.join(topicDir(learningRoot, topic), "plan.json");
    return readJson(file);
  }
  async function putPlan(topic, plan) {
    if (!topic || typeof topic !== "string" || !topic.trim()) throw new Error("topic is required");
    if (!plan || typeof plan !== "object") throw new Error("plan is required");
    const now = new Date().toISOString();
    const modules = Array.isArray(plan.modules) ? plan.modules : [];
    const normalized = {
      topic: String(plan.topic ?? topic),
      map: {
        modules: modules.map((m, i) => ({
          id: String(m.id ?? `mod_${i + 1}`),
          title: String(m.title ?? `模块 ${i + 1}`),
          weight: Number(m.weight ?? 1),
          difficulty: String(m.difficulty ?? "medium"),
          dependencies: Array.isArray(m.dependencies) ? m.dependencies.map(String) : [],
        })),
        createdAt: plan.map?.createdAt ?? now,
        updatedAt: now,
      },
    };
    const file = path.join(topicDir(learningRoot, topic), "plan.json");
    await writeJson(file, normalized);
    return normalized;
  }

  // --- progress ---
  async function getProgress(topic, principal = null) {
    needPrincipal(principal, "getProgress");
    const file = path.join(topicDir(learningRoot, topic), "progress.json");
    return readJson(file);
  }
  async function putProgress(topic, progress) {
    if (!topic) throw new Error("topic is required");
    const now = new Date().toISOString();
    const modules = {};
    for (const [id, p] of Object.entries(progress?.modules ?? {})) {
      modules[id] = {
        status: String(p.status ?? "not_started"),
        mastery: Math.max(0, Math.min(1, Number(p.mastery ?? 0))),
        attempts: Number(p.attempts ?? 0),
        lastActivityAt: p.lastActivityAt ?? now,
      };
    }
    const normalized = { topic, modules, updatedAt: now };
    const file = path.join(topicDir(learningRoot, topic), "progress.json");
    await writeJson(file, normalized);
    return normalized;
  }

  // --- spaced repetition (Ebbinghaus 4 rounds) ---
  async function getReview(topic, principal = null) {
    needPrincipal(principal, "getReview");
    const file = path.join(topicDir(learningRoot, topic), "review.json");
    const data = (await readJson(file)) ?? { topic, items: {}, updatedAt: null };
    const due = dueEntriesFrom(data.items, Date.now());
    return { topic, due, all_items: data.items ?? {} };
  }

  // --- due-review enumeration (read-only, across learning topics) ---
  // "What is due today?" needs every topic, not one at a time. The file is truth:
  // enumerate learningRoot/<dir>/review.json; the topic name comes from review.json
  // (dir name only as fallback) and the module title from that topic's plan.json.
  async function listReviewedTopics() {
    let entries;
    try {
      entries = await fs.readdir(learningRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const topics = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(learningRoot, entry.name);
      const review = await readJson(path.join(dir, "review.json"));
      if (!review || typeof review !== "object" || Array.isArray(review)) continue;
      const topic = typeof review.topic === "string" && review.topic.trim() ? review.topic : entry.name;
      const items = review.items && typeof review.items === "object" && !Array.isArray(review.items) ? review.items : {};
      topics.push({ topic, dir, items });
    }
    topics.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
    return topics;
  }

  function moduleTitles(plan) {
    const modules = Array.isArray(plan?.map?.modules) ? plan.map.modules : Array.isArray(plan?.modules) ? plan.modules : [];
    const titles = new Map();
    for (const m of modules) {
      if (!m || m.id === undefined || m.id === null) continue;
      titles.set(String(m.id), typeof m.title === "string" && m.title.trim() ? m.title : null);
    }
    return titles;
  }

  async function listDueReviews(principal = null) {
    needPrincipal(principal, "listDueReviews");
    const now = Date.now();
    const topics = await listReviewedTopics();
    const due = [];
    for (const t of topics) {
      const titles = moduleTitles(await readJson(path.join(t.dir, "plan.json")));
      for (const entry of dueEntriesFrom(t.items, now)) {
        due.push({ topic: t.topic, ...entry, module_title: titles.get(entry.module_id) ?? null });
      }
    }
    due.sort((a, b) => {
      const at = new Date(a.next_due).getTime();
      const bt = new Date(b.next_due).getTime();
      if (at !== bt) return at - bt; // earliest due first
      if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1;
      return a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0;
    });
    return { scope: "all", count: due.length, topics: topics.map((t) => t.topic), due };
  }

  async function putReview(topic, results) {
    if (!Array.isArray(results)) throw new Error("results must be an array of {module_id, correct}");
    const file = path.join(topicDir(learningRoot, topic), "review.json");
    const data = (await readJson(file)) ?? { topic, items: {}, updatedAt: null };
    const now = new Date().toISOString();
    for (const r of results) {
      const id = String(r.module_id);
      const correct = r.correct === true;
      const prev = data.items[id] ?? { round: 0, nextDue: null };
      const newRound = correct ? Math.min(prev.round + 1, MAX_ROUND) : 0; // wrong -> reset
      const days = REVIEW_INTERVALS_DAYS[Math.min(newRound, REVIEW_INTERVALS_DAYS.length) - 1] ?? REVIEW_INTERVALS_DAYS[0];
      data.items[id] = { round: newRound, nextDue: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString() };
    }
    data.updatedAt = now;
    await writeJson(file, data);
    return data;
  }

  // --- profile ---
  async function getProfile(principal = null) {
    needPrincipal(principal, "getProfile");
    const file = path.join(learningRoot, "profile.json");
    return readJson(file);
  }
  async function putProfile(profile) {
    const now = new Date().toISOString();
    const normalized = {
      name: String(profile?.name ?? "学习者"),
      goals: Array.isArray(profile?.goals) ? profile.goals.map(String) : [],
      createdAt: profile?.createdAt ?? now,
      updatedAt: now,
    };
    const file = path.join(learningRoot, "profile.json");
    await writeJson(file, normalized);
    return normalized;
  }

  return { getPlan, putPlan, getProgress, putProgress, getReview, listDueReviews, putReview, getProfile, putProfile };
}
