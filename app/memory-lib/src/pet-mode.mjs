// Semantic pet modes and server-side authorization. Clients may request a mode;
// the authenticated role remains the sole authority for what it can do.

export const PET_MODES = Object.freeze(["companion", "assistant", "steward", "learner", "governance"]);

const LEGACY_MODE_ALIASES = Object.freeze({
  chat: "companion",
  solve: "assistant",
  quiz: "learner",
  visualize: "learner",
  research: "assistant",
});

const MODE_REQUIREMENTS = Object.freeze({
  companion: { actions: ["pet"], roleIds: ["pet-companion", "companion", "pet"] },
  assistant: { actions: ["pet", "propose"], roleIds: ["pet-assistant", "assistant"] },
  steward: { actions: ["pet", "steward"], roleIds: ["pet-steward", "steward"] },
  learner: { actions: ["pet", "learning"], roleIds: ["pet-learner", "learner"] },
  governance: { actions: ["pet", "admin"], roleIds: ["governance", "librarian-admin"] },
});

export function normalizePetMode(value, { legacy = true } = {}) {
  const requested = String(value ?? "").trim().toLowerCase();
  if (PET_MODES.includes(requested)) return { mode: requested, legacy: false, requested: requested || "companion" };
  if (legacy && LEGACY_MODE_ALIASES[requested]) return { mode: LEGACY_MODE_ALIASES[requested], legacy: true, requested };
  if (!requested) return { mode: "companion", legacy: false, requested: "companion" };
  return { mode: null, legacy: false, requested };
}

export function authorizePetMode(role, requestedMode, { allowLegacy = true } = {}) {
  const normalized = normalizePetMode(requestedMode, { legacy: allowLegacy });
  if (!normalized.mode) return { ok: false, mode: null, requested: normalized.requested, reason: "UNKNOWN_MODE" };
  const requirement = MODE_REQUIREMENTS[normalized.mode];
  const actions = Array.isArray(role?.actions) ? role.actions : [];
  const isAdmin = actions.includes("admin");
  const missing = requirement.actions.filter((action) => !actions.includes(action));
  if (missing.length && !isAdmin) return { ok: false, mode: normalized.mode, requested: normalized.requested, legacy: normalized.legacy, reason: "ACTION_DENIED", missing };
  // Semantic roles are explicit. Legacy role ids remain accepted only for the
  // compatible mode that their existing action set already authorizes.
  if (requirement.roleIds.length && !isAdmin && !requirement.roleIds.includes(String(role?.role_id ?? ""))) {
    if (normalized.mode !== "companion" || !actions.includes("pet")) {
      return { ok: false, mode: normalized.mode, requested: normalized.requested, legacy: normalized.legacy, reason: "ROLE_MODE_DENIED" };
    }
  }
  return { ok: true, mode: normalized.mode, requested: normalized.requested, legacy: normalized.legacy };
}

export function modeRequirements(mode) {
  return MODE_REQUIREMENTS[mode] ?? null;
}

export function legacyModeAliases() {
  return { ...LEGACY_MODE_ALIASES };
}
