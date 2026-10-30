# memory-lib 官方协议客户端 SDK（library.v1，Python 版，零第三方依赖）。
import json
import urllib.error
import urllib.request


class MemoryClientError(Exception):
    def __init__(self, status, code, message, detail=None):
        super().__init__(f"{code}: {message}" + (f" ({detail})" if detail else ""))
        self.status = status
        self.code = code
        self.detail = detail


class MemoryClient:
    def __init__(self, url="http://127.0.0.1:8787", credential_ref=None, secret=None, agent="pilot-01", role="researcher"):
        if not credential_ref or not secret:
            raise ValueError("MemoryClient requires credential_ref and secret")
        self.url = url.rstrip("/")
        self.auth = {"credential_ref": credential_ref, "secret": secret, "principal": {"agent_id": agent, "role_id": role}}

    def _post(self, path, body=None):
        data = dict(self.auth)
        if body:
            data.update(body)
        req = urllib.request.Request(f"{self.url}{path}", data=json.dumps(data).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            payload = {}
            try:
                payload = json.loads(e.read().decode("utf-8") or "{}")
            except Exception:
                pass
            err = payload.get("error", {})
            raise MemoryClientError(e.code, err.get("code", "HTTP_ERROR"), err.get("message", str(e)), err.get("detail"))

    def health(self):
        with urllib.request.urlopen(f"{self.url}/v1/health", timeout=30) as res:
            return json.loads(res.read().decode("utf-8"))

    def search(self, query, limit=10, scope=None):
        body = {"query": query, "limit": limit}
        if scope is not None:
            body["scope"] = scope
        return self._post("/v1/search", body)

    def list(self, limit=100, workspace=None, tags=None, since=None, until=None):
        body = {"limit": limit}
        for key, value in (("workspace", workspace), ("tags", tags), ("since", since), ("until", until)):
            if value is not None:
                body[key] = value
        return self._post("/v1/memory/list", body)

    def get(self, id, include_cold=False):
        return self._post("/v1/get", {"id": id, "include_cold": include_cold})

    def write(self, **payload):
        return self._post("/v1/write", payload)

    def deprecate(self, id, replacement_id=None, reason=None):
        body = {"id": id}
        if replacement_id is not None:
            body["replacement_id"] = replacement_id
        if reason is not None:
            body["reason"] = reason
        return self._post("/v1/memory/deprecate", body)

    def learning_plan_get(self, topic): return self._post("/v1/learning/plan_get", {"topic": topic})
    def learning_plan_put(self, topic, plan): return self._post("/v1/learning/plan_put", {"topic": topic, "plan": plan})
    def learning_progress_get(self, topic): return self._post("/v1/learning/progress_get", {"topic": topic})
    def learning_progress_put(self, topic, progress): return self._post("/v1/learning/progress_put", {"topic": topic, "progress": progress})
    def learning_review_get(self, topic=None): return self._post("/v1/learning/review_get", {} if topic is None else {"topic": topic})
    def learning_review_put(self, topic, results): return self._post("/v1/learning/review_put", {"topic": topic, "results": results})
    def learning_profile_get(self): return self._post("/v1/learning/profile_get", {})
    def learning_profile_put(self, profile): return self._post("/v1/learning/profile_put", {"profile": profile})

    def pet_command(self, input, mode="chat", history=None):
        body = {"input": input, "mode": mode}
        if history is not None: body["history"] = history
        return self._post("/v1/pet/command", body)

    def capture_conversation(self, conversation_id, event_id, messages, source, partial=False, session_id=None, tags=None, workspace=None):
        body = {"conversation_id": conversation_id, "event_id": event_id, "messages": messages, "source": source, "partial": partial}
        for key, value in (("session_id", session_id), ("tags", tags), ("workspace", workspace)):
            if value is not None: body[key] = value
        return self._post("/v1/conversations/capture", body)

    def capture_complete(self, conversation_id, event_id, messages, source, partial=False, session_id=None, tags=None, workspace=None):
        body = {"conversation_id": conversation_id, "event_id": event_id, "messages": messages, "source": source, "partial": partial}
        for key, value in (("session_id", session_id), ("tags", tags), ("workspace", workspace)):
            if value is not None: body[key] = value
        return self._post("/v1/conversations/complete", body)

    def admin_registry(self): return self._post("/v1/admin/registry", {})
    def admin_audit(self, limit=100, allow=None): return self._post("/v1/admin/audit", {"limit": limit, **({"allow": allow} if allow is not None else {})})
    def admin_revoke(self, framework_id): return self._post("/v1/admin/registry/revoke", {"framework_id": framework_id})
    def admin_activate(self, framework_id): return self._post("/v1/admin/registry/activate", {"framework_id": framework_id})
    def admin_framework_create(self, framework_id, agent_id, role_id, scopes, actions, framework_credential_ref=None, wincred=False):
        body = {"framework_id": framework_id, "agent_id": agent_id, "role_id": role_id, "scopes": scopes, "actions": actions, "wincred": wincred}
        if framework_credential_ref is not None: body["framework_credential_ref"] = framework_credential_ref
        return self._post("/v1/admin/framework/create", body)
    def admin_credential_rotate(self, target_credential_ref, wincred=False): return self._post("/v1/admin/credential/rotate", {"target_credential_ref": target_credential_ref, "wincred": wincred})
