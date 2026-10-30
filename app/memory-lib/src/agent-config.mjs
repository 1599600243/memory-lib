import fs from "node:fs/promises";
import path from "node:path";

export async function loadAgentConfig(configPath, fallback = {}, { required = false } = {}) {
  if (!configPath) {
    if (required) throw new Error("agent config path is required");
    return fallback;
  }
  try {
    const value = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!value || typeof value !== "object") throw new Error("agent config must be an object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") {
      if (required) throw new Error(`agent config missing: ${configPath}`);
      return fallback;
    }
    throw new Error(`agent config unreadable: ${configPath}: ${error.message}`);
  }
}

export function defaultAgentConfigPath(dataRoot) {
  return path.join(dataRoot, "runtime", "agents", "config.json");
}
