// memory-lib D29 protocol client SDK.
export class MemoryClientError extends Error {
  constructor(status, code, message, detail) {
    super(`${code}: ${message}${detail ? ` (${detail})` : ""}`);
    this.name = "MemoryClientError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export class MemoryClient {
  constructor({ url = "http://127.0.0.1:8787", credentialRef, secret, agent = "pilot-01", role = "researcher" } = {}) {
    if (!credentialRef || !secret) throw new Error("MemoryClient requires credentialRef and secret");
    this.url = url.replace(/\/$/, "");
    this.auth = { credential_ref: credentialRef, secret, principal: { agent_id: agent, role_id: role } };
  }

  async _post(route, body = {}) {
    const res = await fetch(`${this.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...this.auth, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new MemoryClientError(res.status, data.error?.code ?? "HTTP_ERROR", data.error?.message ?? res.statusText, data.error?.detail);
    return data;
  }

  async health() { return fetch(`${this.url}/v1/health`).then((res) => res.json()); }
  async search({ query, limit = 10, documentQuota = 3, workspace, tags, since, until, graphExpand = true } = {}) { return this._post("/v1/search", { query, limit, documentQuota, workspace, tags, since, until, graphExpand }); }
  async list({ limit, workspace, tags, since, until } = {}) { return this._post("/v1/memory/list", { limit, workspace, tags, since, until }); }
  async get(id, { include_cold = false } = {}) { return this._post("/v1/get", { id, include_cold }); }
  async write(payload = {}) { return this._post("/v1/write", payload); }
  async deprecate(id, replacement_id, reason) { return this._post("/v1/memory/deprecate", { id, ...(replacement_id ? { replacement_id } : {}), ...(reason ? { reason } : {}) }); }

  async learningPlanGet(topic) { return this._post("/v1/learning/plan_get", { topic }); }
  async learningPlanPut(topic, plan) { return this._post("/v1/learning/plan_put", { topic, plan }); }
  async learningProgressGet(topic) { return this._post("/v1/learning/progress_get", { topic }); }
  async learningProgressPut(topic, progress) { return this._post("/v1/learning/progress_put", { topic, progress }); }
  async learningReviewGet(topic) { return this._post("/v1/learning/review_get", topic ? { topic } : {}); }
  async learningReviewPut(topic, results) { return this._post("/v1/learning/review_put", { topic, results }); }
  async learningProfileGet() { return this._post("/v1/learning/profile_get", {}); }
  async learningProfilePut(profile) { return this._post("/v1/learning/profile_put", { profile }); }

  async petCommand(input, mode = "chat", history) { return this._post("/v1/pet/command", { input, mode, ...(history ? { history } : {}) }); }
  async captureConversation(event) { return this._post("/v1/conversations/capture", event); }
  async captureComplete(event) { return this._post("/v1/conversations/complete", event); }
  async ingest(payload) { return this._post("/v1/ingest", payload); }

  async adminRegistry() { return this._post("/v1/admin/registry"); }
  async adminRevoke(framework_id) { return this._post("/v1/admin/registry/revoke", { framework_id }); }
  async adminActivate(framework_id) { return this._post("/v1/admin/registry/activate", { framework_id }); }
  async adminAudit({ limit = 100, allow } = {}) { return this._post("/v1/admin/audit", { limit, ...(allow === undefined ? {} : { allow }) }); }
  async adminFrameworkCreate(payload = {}) { return this._post("/v1/admin/framework/create", payload); }
  async adminCredentialRotate(target_credential_ref, wincred = false) { return this._post("/v1/admin/credential/rotate", { target_credential_ref, wincred }); }
}
