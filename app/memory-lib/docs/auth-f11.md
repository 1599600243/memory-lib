# F11 authentication contract

## Human accounts

`identity.json` may contain an explicit, non-secret `accounts[]` list. Each active account maps a normalized username to a framework, credential reference, agent, and role. An existing machine admin provisions the first account through `POST /v1/admin/account/create`; admin-only password reset, suspend, and activate routes manage its lifecycle. Password hashes are stored only in the configured secret store (file mode uses `accounts/<safe-normalized-username>.scrypt`; WinCred uses target `accounts/<normalized-username>`); neither plaintext passwords nor hashes belong in the registry, audit records, URLs, or responses.

The canonical routes are:

- `POST /v1/auth/login` — username/password to an opaque Bearer session.
- `POST /v1/auth/logout` — idempotent current-token revocation.
- `GET /v1/auth/whoami` — current identity and grants; does not renew the session.
- `POST /v1/auth/password` — Bearer-only password change; revokes all sessions for the account.

There are no `/v1/login` or `/v1/logout` aliases. REST and `/mcp` accept `Authorization: Bearer <token>`. Stdio MCP can forward the same token with `MCP_MEMORY_TOKEN`.

## Session lifecycle

The default idle lifetime is 12 hours with sliding renewal, bounded by a seven-day absolute lifetime. The runtime file stores only SHA-256 token hashes and derived metadata. Every Bearer request rereads the registry. Machine credential reads may be cached for a bounded TTL (`--wincred-cache-ms`, default 1000 ms, only successful request-credential reads are cached): in-process writes (framework create, credential rotation, account password change, account create) invalidate the cache immediately, so account suspension, framework revocation, role removal, and in-process credential rotation invalidate a session at once. An **out-of-process** rotation or revocation can stay stale until the TTL expires (or indefinitely if the cache is disabled by setting `--wincred-cache-ms 0`).

Unknown, inactive, malformed, and wrong-password logins use the same `401 UNAUTHENTICATED` response. Repeated failures are locked per account fingerprint; peer failures are counted for observation but do not create a machine-wide lock in the loopback deployment. Account lockout returns `429` with `Retry-After`. Audit uses the fixed `auth_method` values `credential` and `session` and stores only fingerprints, principal metadata, action, outcome, and safe resource identifiers.

## Machine compatibility

Machines continue to send `credential_ref + secret + principal` through the existing authorization and audit chain. Password login never treats a username as a credential reference and never infers a principal from framework/agent/role array position.

## Not implemented (backlog)

- **First-login forced password change**: not implemented. `/v1/auth/password` is an optional self-service change, not a mandatory post-provisioning flow.
- **TOTP / MFA second factor**: not implemented, and no protocol interface slot is reserved. These are documented as deferred so the contract does not imply support that does not exist.

## Remote access

The core binds loopback only. Do not expose plaintext password login over a remote HTTP listener; use encrypted Tailscale access/TLS and keep the token in the `Authorization` header.
