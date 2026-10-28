#!/usr/bin/env node
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (m) => m.slice(1))), "..");
const credRef = process.env.MCP_MEMORY_CRED_REF;
if (!credRef) { console.error("MCP_MEMORY_CRED_REF is required"); process.exit(2); }
const reader = path.join(ROOT, "app", "memory-lib", "scripts", "wincred-read.ps1");
const target = credRef.replaceAll("/", "_");
const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", reader, "-Target", target], { encoding: "utf8", windowsHide: true });
const secret = result.status === 0 ? result.stdout.replace(/\r?\n$/u, "") : "";
if (!secret || secret.startsWith("WINCRED_READ_NOT_FOUND")) {
  console.error(`credentialRef not found: ${credRef}`);
  process.exit(2);
}
const server = path.join(ROOT, "app", "memory-lib", "mcp", "mcp-server.mjs");
const child = spawn(process.execPath, [server], { env: { ...process.env, MCP_MEMORY_SECRET: secret }, stdio: "inherit", windowsHide: true });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
