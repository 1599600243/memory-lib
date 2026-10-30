import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = await fs.readFile(path.join(here, "..", "web", "console.html"), "utf8");

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") { depth++; opened = true; }
    if (html[i] === "}") depth--;
    if (opened && depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

test("console password form validates locally before the password request", () => {
  const context = {};
  vm.runInNewContext(`${extractFunction("validatePasswordChange")}; result = [validatePasswordChange("1234567", "1234567"), validatePasswordChange("12345678", "different"), validatePasswordChange("12345678", "12345678")];`, context);
  assert.deepEqual(Array.from(context.result), ["密码至少需要 8 个字符", "两次输入的新密码不一致", ""]);
  const changeSource = extractFunction("changeOwnPassword");
  assert.ok(changeSource.indexOf("validatePasswordChange") < changeSource.indexOf('post("/v1/auth/password"'), "validation must run before the request");
});

test("console identity page handles password revocation and account lifecycle endpoints", () => {
  assert.match(html, /id="currentPassword" type="password"/u);
  assert.match(html, /id="newPassword" type="password" minlength="8"/u);
  assert.match(html, /id="confirmPassword" type="password" minlength="8"/u);
  assert.match(html, /post\("\/v1\/auth\/password", \{ username: S\.username, current_password: current, new_password: next \}\)/u);
  assert.match(html, /当前密码不正确/u);
  assert.match(html, /密码已更新，请重新登录/u);
  assert.match(html, /clearLoginState/u);
  for (const route of ["/v1/admin/account/create", "/v1/admin/account/suspend", "/v1/admin/account/activate", "/v1/admin/account/password/reset"]) assert.ok(html.includes(route), route);
  assert.match(html, /id="accountResetPassword-\$\{index\}" type="password" minlength="8"/u);
  assert.match(html, /\.registry-form-grid\s*\{[^}]*display:grid[^}]*gap:16px/u);
  assert.match(html, /\.registry-table-wrap\s*\{[^}]*overflow-x:auto/u);
  assert.match(html, /\.registry-table th, \.registry-table td\s*\{[^}]*padding:8px 12px[^}]*white-space:nowrap/u);
  assert.match(html, /@media \(max-width:1100px\)[^{]*\{[^}]*\.registry-form-grid/u);
  assert.doesNotMatch(extractFunction("resetAccountPassword"), /prompt\(/u);
  assert.doesNotMatch(html, /localStorage/u);
});

test("console framework onboarding uses templates, fixed WinCred and ephemeral secret rendering", () => {
  for (const role of ["reader", "researcher", "learner", "pet", "steward", "capture-ingest", "librarian-admin"]) assert.match(html, new RegExp(`<option value="${role}"`));
  assert.match(html, /id="frameworkScopes"/u);
  assert.match(html, /data-action="admin"/u);
  assert.match(html, /post\("\/v1\/admin\/framework\/create"/u);
  assert.match(extractFunction("createManagedFramework"), /wincred: true/u);
  assert.match(extractFunction("createManagedFramework"), /button\.disabled = true/u);
  assert.match(extractFunction("rotateFrameworkCredential"), /\/v1\/admin\/credential\/rotate/u);
  assert.match(html, /此凭证只显示这一次/u);
  assert.match(extractFunction("showOneTimeSecret"), /textContent = secret/u);
  assert.doesNotMatch(extractFunction("showOneTimeSecret"), /localStorage|sessionStorage|cookie|location/u);
  assert.doesNotMatch(html, /localStorage|sessionStorage/u);
});
