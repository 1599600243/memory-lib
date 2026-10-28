import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = await fs.readFile(path.join(here, "..", "web", "console.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < html.length; index++) {
    if (html[index] === "{") { depth++; opened = true; }
    if (html[index] === "}") depth--;
    if (opened && depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

test("console exposes a preview-first ingest workflow with safe defaults", () => {
  assert.match(html, /data-tab="ingest">采集 \/ 导入/u);
  assert.match(html, /id="tab-ingest"/u);
  assert.match(html, /id="ingestExtract" type="checkbox">/u);
  assert.doesNotMatch(html, /id="ingestExtract"[^>]*checked/u);
  assert.match(html, /id="ingestConfirm" disabled/u);
  assert.match(html, /id="ingestUseImports"/u);
  assert.match(html, /get\("\/v1\/ingest\/status"\)/u);
  assert.match(functionSource("previewIngest"), /if \(!request\.paths\.length\)/u);
  assert.match(functionSource("previewIngest"), /post\("\/v1\/ingest", request\)/u);
  assert.match(functionSource("confirmIngest"), /S\.ingestPreview/u);
  assert.match(functionSource("confirmIngest"), /dry_run: false/u);
  assert.match(functionSource("invalidateIngestPreview"), /ingestConfirm/u);
});

test("console renders ingest paths and results through escaping", () => {
  const render = functionSource("renderIngestResult");
  assert.match(render, /esc\(item\.path\)/u);
  assert.match(render, /esc\(item\.target \|\| item\.evidence_id/u);
  assert.match(render, /esc\(item\.reason/u);
  assert.match(render, /data\.impact\?\.directories/u);
  assert.match(functionSource("loadIngestAudit"), /startsWith\("memory-ingest"\)/u);
  assert.match(html, /activateTab\("audit"\)/u);
});
