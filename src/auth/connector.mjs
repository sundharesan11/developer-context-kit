import { DevctxError } from "../errors.mjs";
import { assertActorRef } from "../identity/ids.mjs";
import { findForbiddenFields } from "../records/redact.mjs";
import { parseSecretRef } from "./secret-ref.mjs";
export function validateAccountConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Object.keys(cfg).some((key) => !["id", "provider", "accountId", "workspaceId", "actorRef", "secretRef", "policy"].includes(key)) || findForbiddenFields(cfg).length) throw new DevctxError("INVALID_INPUT", "Invalid account configuration");
  if (["id", "provider", "accountId", "workspaceId", "actorRef", "secretRef"].some((key) => typeof cfg[key] !== "string" || !cfg[key])) throw new DevctxError("INVALID_INPUT", "Account identity required");
  try { assertActorRef(cfg.actorRef); parseSecretRef(cfg.secretRef); } catch { throw new DevctxError("INVALID_INPUT", "Invalid account identity"); }
  if (!cfg.policy || Object.keys(cfg.policy).some((key) => !["read", "draft", "outbound"].includes(key)) || Object.values(cfg.policy).some((x) => typeof x !== "boolean")) throw new DevctxError("INVALID_INPUT", "Invalid account policy");
  return cfg;
}
export function createConnector({ account, provider, resolveSecret }) {
  validateAccountConfig(account);
  async function verify() {
    let identity;
    try { identity = await provider.whoami(); } catch { throw new DevctxError("AUTH_UNVERIFIED", "Provider identity unavailable"); }
    if (!identity || identity.verified !== true || !identity.actorRef || !identity.accountId || !identity.workspaceId) throw new DevctxError("AUTH_UNVERIFIED", "Provider identity unverified");
    if (identity.accountId !== account.accountId || identity.workspaceId !== account.workspaceId || identity.actorRef !== account.actorRef) throw new DevctxError("AUTH_MISMATCH", "Provider identity mismatch");
    return { verified: true, accountId: identity.accountId, workspaceId: identity.workspaceId, actorRef: identity.actorRef };
  }
  async function operation(name, args) {
    if (account.policy[name] !== true) throw new DevctxError("GATE_REQUIRED", "Connector operation disabled");
    await verify();
    return provider[name](args);
  }
  return { verify, read: (args) => operation("read", args), draft: (args) => operation("draft", args) };
}
