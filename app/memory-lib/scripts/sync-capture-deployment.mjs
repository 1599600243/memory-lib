import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.DSH_MEMORY_CAPTURE_DIR ?? path.join(process.env.DSH_HOME ?? process.env.USERPROFILE ?? ".", "memory-capture");
const files = [
  { source: path.join(root, "adapters", "dsh", "poll-capture.mjs"), destination: path.join(target, "capture.mjs") },
  { source: path.join(root, "adapters", "dsh", "session-snapshot.mjs"), destination: path.join(target, "session-snapshot.mjs") },
];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const manifest = files.map(({ source, destination }) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const sourceHash = hash(source);
  const targetHash = hash(destination);
  if (sourceHash !== targetHash) throw new Error(`capture deployment hash mismatch: ${sourceHash} != ${targetHash}`);
  return { source, destination, sha256: sourceHash };
});
console.log(JSON.stringify({ ok: true, files: manifest }));
