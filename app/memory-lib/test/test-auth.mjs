import fs from "node:fs/promises";
import path from "node:path";
import { rotateCredential } from "../src/identity-admin.mjs";
import { readSecret } from "../src/credential-resolver.mjs";
import { createAccountPasswordStore, hashPassword } from "../src/password-hash.mjs";

export const TEST_CREDENTIAL_REF = "memory-lib/deepseek-harness";

export async function createTestAuth(root, tmp) {
  const registryPath = path.join(tmp, "identity.json");
  const secretsDir = path.join(tmp, "secrets");
  const secretStore = { type: "file", dir: secretsDir };

  await fs.cp(path.join(root, "runtime", "identity.json"), registryPath, { recursive: false });
  await rotateCredential({ secretsDir, credentialRef: TEST_CREDENTIAL_REF });
  const authValue = await readSecret(secretStore, TEST_CREDENTIAL_REF);
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const framework = registry.frameworks.find((item) => item.credential_ref === TEST_CREDENTIAL_REF);
  registry.accounts = [{ username: "admin@example", framework_id: framework.framework_id, credential_ref: TEST_CREDENTIAL_REF, agent_id: "admin-01", role_id: "librarian-admin", status: "active" }, { username: "pilot@example", framework_id: framework.framework_id, credential_ref: TEST_CREDENTIAL_REF, agent_id: "pilot-01", role_id: "researcher", status: "active" }];
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  const accountPasswords = createAccountPasswordStore({ secretStore });
  const accountPasswordStore = accountPasswords;
  const accountPassword = "F11-test-account-password";
  await accountPasswords.write("admin@example", await hashPassword(accountPassword));
  await accountPasswords.write("pilot@example", await hashPassword("F11-pilot-account-password"));

  return { registryPath, secretStore, credentialRef: TEST_CREDENTIAL_REF, authValue, accountUsername: "admin@example", accountPassword, accountPasswordStore, accountPasswords };
}
