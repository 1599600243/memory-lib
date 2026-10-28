// memory-lib — standalone server CLI configuration (secret store + operator policies).
//
// F8: wincred (Windows Credential Manager) is the authoritative secret store and
// the standalone server default. The file store is an explicit opt-in, and the
// wincred migration fallback (--secret-fallback-file) is opt-in and can only be
// combined with wincred. An unusable --secret-store must fail loudly instead of
// silently falling back to another store.
//
// F3: auto-review policy mode and rule configuration are operator inputs. They are
// parsed at startup and never accepted from a client request.
//
// Protocol fields (credential_ref / secret / principal) are unchanged: this module
// only decides which backend the server reads credentials from and which internal
// policy configuration is passed to the server.
import fs from "node:fs/promises";
import { AUTO_REVIEW_DECISIONS, AUTO_REVIEW_MODES, AUTO_REVIEW_SIGNAL_NAMES } from "./auto-review.mjs";

export const SECRET_STORE_TYPES = ["wincred", "file"];
export const DEFAULT_SECRET_STORE = "wincred";
export const FALLBACK_FLAG = "--secret-fallback-file";
export const SECRET_STORE_FLAG = "--secret-store";
export const AUTO_REVIEW_CONFIG_FLAG = "--auto-review-config";
export const AUTO_REVIEW_CONFIG_ENV = "MEMORY_LIB_AUTO_REVIEW_CONFIG";
export const WINCRED_CACHE_FLAG = "--wincred-cache-ms";
export const CALENDAR_TIMEZONE_FLAG = "--calendar-timezone";

export class ServerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServerConfigError";
  }
}

const EXPECTED = `expected: ${SECRET_STORE_TYPES.join(" | ")}; default: ${DEFAULT_SECRET_STORE}`;
const AUTO_REVIEW_CONFIG_KEYS = new Set(["enabled", "mode", "fallback", "rules", "disabledRules", "llmTriage"]);
const AUTO_REVIEW_RULE_KEYS = new Set(["id", "decision", "reason", "sources", "tags", "notTags", "importance", "minContentChars", "maxContentChars", "contentSignals", "notContentSignals"]);

// Distinguish "flag absent" (use the default) from "flag present without a value"
// (a configuration error the operator must see).
export function readFlagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { present: false, value: null };
  const next = argv[i + 1];
  if (next === undefined || next === "" || next.startsWith("--")) return { present: true, value: null };
  return { present: true, value: next };
}

export function readNonNegativeNumberFlag(argv, name) {
  const flag = readFlagValue(argv, name);
  if (!flag.present) return null;
  if (flag.value === null) throw new ServerConfigError(`missing value for ${name}`);
  const value = Number(flag.value);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new ServerConfigError(`${name} must be a non-negative integer (milliseconds)`);
  }
  return value;
}

// TZ-CONFIG-1: the deployment default timezone for bare (timezone-less) date input.
//
// Contract: `calendarTimezone` is a *deployment* setting, never guessed. When it is
// not configured the server keeps interpreting bare dates as **UTC** — the value the
// code has always used. Changing that silently would be a behaviour change for every
// integrator who relied on it, so an absent flag must NOT fall back to the machine's
// local timezone. Only an explicit, valid IANA name may move the default.
//
// A Windows zone name ("China Standard Time") is deliberately rejected rather than
// translated: this is an operator setting read once at startup, and a rejected value
// is visible immediately, while a silent translation is not. An unusable value must
// fail closed — never degrade to UTC behind the operator's back.
export function resolveCalendarTimezoneConfig({ flag = { present: false, value: null }, env = null } = {}) {
  const envValue = typeof env === "string" && env.trim() ? env.trim() : null;
  if (!flag.present && !envValue) return null;
  const value = flag.present ? flag.value : envValue;
  if (value === null || value === undefined || value === "") {
    throw new ServerConfigError(`missing value for ${CALENDAR_TIMEZONE_FLAG} (expected an IANA time zone name such as Asia/Shanghai)`);
  }
  const name = String(value).trim();
  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    valid = true;
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ServerConfigError(
      `unsupported ${CALENDAR_TIMEZONE_FLAG} value: ${JSON.stringify(name)} (expected an IANA time zone name such as Asia/Shanghai; a Windows name such as "China Standard Time" is not accepted)`
    );
  }
  return name;
}

// Startup log line for the deployment default timezone. Only ever prints the
// configured name (or a fixed "UTC (unconfigured)" note) — never any path or secret.
export function describeCalendarTimezone(calendarTimezone) {
  return calendarTimezone === null || calendarTimezone === undefined
    ? "UTC (unconfigured: bare dates are interpreted as UTC)"
    : `${calendarTimezone} (bare dates are interpreted in this time zone)`;
}

// Build the secretStore descriptor consumed by src/credential-resolver.mjs.
// Throws ServerConfigError for every unusable combination.
export function resolveSecretStoreConfig({ flag = { present: false, value: null }, secretsDir = null, wincredReadScript = null, fileFallback = false, wincredCacheMs = null } = {}) {
  let type;
  if (!flag.present) {
    type = DEFAULT_SECRET_STORE;
  } else if (flag.value === null) {
    throw new ServerConfigError(`missing value for ${SECRET_STORE_FLAG} (${EXPECTED})`);
  } else {
    type = flag.value;
  }

  if (!SECRET_STORE_TYPES.includes(type)) {
    throw new ServerConfigError(
      `unsupported --secret-store value: ${JSON.stringify(type)} (${EXPECTED}; the file store is an explicit opt-in: "--secret-store file")`
    );
  }
  if (wincredCacheMs !== null && (!Number.isFinite(wincredCacheMs) || wincredCacheMs < 0 || !Number.isInteger(wincredCacheMs))) {
    throw new ServerConfigError(`${WINCRED_CACHE_FLAG} must be a non-negative integer (milliseconds)`);
  }
  if (wincredCacheMs !== null && type !== "wincred") {
    throw new ServerConfigError(`${WINCRED_CACHE_FLAG} requires --secret-store wincred (got ${JSON.stringify(type)})`);
  }
  if (fileFallback && type !== "wincred") {
    throw new ServerConfigError(`${FALLBACK_FLAG} requires --secret-store wincred (got ${JSON.stringify(type)}); the file store is already authoritative`);
  }
  if (type === "file") {
    if (!secretsDir) throw new ServerConfigError(`--secret-store file requires --secrets-dir (file store directory)`);
    return { type: "file", dir: secretsDir };
  }
  if (!wincredReadScript) {
    throw new ServerConfigError("--secret-store wincred requires the wincred read helper (scripts/wincred-read.ps1)");
  }
  const store = { type: "wincred", readScript: wincredReadScript };
  if (wincredCacheMs !== null) store.cacheTtlMs = wincredCacheMs;
  if (fileFallback) {
    if (!secretsDir) throw new ServerConfigError(`${FALLBACK_FLAG} requires --secrets-dir (file fallback directory)`);
    store.fileFallback = { dir: secretsDir };
  }
  return store;
}

// Parse the operator-only F3 configuration. The JSON file is intentionally read
// before the server starts; malformed policy must fail closed rather than silently
// falling back to defaults. CLI mode wins over MEMORY_LIB_AUTO_REVIEW, while the
// explicit config path wins over MEMORY_LIB_AUTO_REVIEW_CONFIG.
export async function resolveAutoReviewConfig({ modeFlag = { present: false, value: null }, configFlag = { present: false, value: null }, envMode = null, envConfigPath = null, readFile = (file) => fs.readFile(file, "utf8") } = {}) {
  const configPath = configFlag.present ? configFlag.value : (envConfigPath || null);
  if (configFlag.present && configFlag.value === null) throw new ServerConfigError(`missing value for ${AUTO_REVIEW_CONFIG_FLAG}`);

  let fileConfig = {};
  if (configPath) {
    let raw;
    try {
      raw = await readFile(configPath);
    } catch (error) {
      throw new ServerConfigError(`auto-review config unreadable: ${configPath} (${error?.message ?? error})`);
    }
    try {
      fileConfig = JSON.parse(String(raw));
    } catch (error) {
      throw new ServerConfigError(`auto-review config invalid JSON: ${configPath} (${error?.message ?? error})`);
    }
    if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
      throw new ServerConfigError("auto-review config must be a JSON object");
    }
    const unknown = Object.keys(fileConfig).filter((key) => !AUTO_REVIEW_CONFIG_KEYS.has(key));
    if (unknown.length) throw new ServerConfigError(`auto-review config has unsupported fields: ${unknown.join(", ")}`);
    validateAutoReviewConfigShape(fileConfig);
  }

  const envModePresent = envMode !== null && envMode !== undefined && envMode !== "";
  const modeValue = modeFlag.present ? modeFlag.value : (fileConfig.mode ?? (envModePresent ? envMode : "actual"));
  if (modeFlag.present && modeFlag.value === null) throw new ServerConfigError("missing value for --auto-review");
  if (![...AUTO_REVIEW_MODES, "off"].includes(modeValue)) throw new ServerConfigError(`unsupported --auto-review value: ${JSON.stringify(modeValue)} (expected: off | dry-run | actual)`);

  const output = { ...fileConfig };
  if (modeFlag.present || !Object.hasOwn(fileConfig, "mode") && envModePresent) {
    output.mode = modeValue === "off" ? "actual" : modeValue;
    output.enabled = modeValue !== "off";
  } else if (modeValue === "off") {
    output.enabled = false;
    output.mode = "actual";
  }
  validateAutoReviewConfigShape(output);
  return output;
}

function validateAutoReviewConfigShape(config) {
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new ServerConfigError("auto-review enabled must be boolean");
  if (config.mode !== undefined && !AUTO_REVIEW_MODES.includes(config.mode)) throw new ServerConfigError(`unsupported auto-review mode: ${JSON.stringify(config.mode)} (expected: actual | dry-run)`);
  if (config.fallback !== undefined && !AUTO_REVIEW_DECISIONS.includes(config.fallback)) throw new ServerConfigError(`unsupported auto-review fallback: ${JSON.stringify(config.fallback)}`);
  if (config.disabledRules !== undefined && (!Array.isArray(config.disabledRules) || config.disabledRules.some((id) => typeof id !== "string"))) throw new ServerConfigError("auto-review disabledRules must be an array of strings");
  if (config.rules !== undefined && (!Array.isArray(config.rules) || config.rules.some((rule) => !rule || typeof rule !== "object" || Array.isArray(rule)))) throw new ServerConfigError("auto-review rules must be an array of objects");
  for (const rule of config.rules ?? []) {
    for (const key of ["sources", "tags", "notTags", "importance", "contentSignals", "notContentSignals"]) {
      if (rule[key] !== undefined && (!Array.isArray(rule[key]) || rule[key].some((value) => typeof value !== "string"))) throw new ServerConfigError(`auto-review rule ${rule.id ?? "<unknown>"}: ${key} must be an array of strings`);
    }
    for (const key of ["contentSignals", "notContentSignals"]) {
      if (rule[key]?.some((name) => !AUTO_REVIEW_SIGNAL_NAMES.includes(name))) throw new ServerConfigError(`auto-review rule ${rule.id ?? "<unknown>"}: unknown ${key}`);
    }
    for (const key of ["minContentChars", "maxContentChars"]) {
      if (rule[key] !== undefined && (!Number.isFinite(rule[key]) || rule[key] < 0)) throw new ServerConfigError(`auto-review rule ${rule.id ?? "<unknown>"}: ${key} must be a non-negative number`);
    }
  }
}

// Startup log line. Contains store paths and cache policy only — never a secret.
export function describeSecretStore(secretStore) {
  if (secretStore?.type === "wincred") {
    const cache = secretStore.cacheTtlMs === 0 ? "cache disabled" : `cache ${secretStore.cacheTtlMs ?? 1000}ms`;
    return `wincred (Windows Credential Manager; ${cache})${secretStore.fileFallback ? ` + FILE fallback (MIGRATION ONLY, dir: ${secretStore.fileFallback.dir})` : ""}`;
  }
  if (secretStore?.type === "file") return `file (explicit opt-in, dir: ${secretStore.dir})`;
  return "unknown";
}
