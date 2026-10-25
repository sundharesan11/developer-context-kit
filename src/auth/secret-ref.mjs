import { DevtwinError } from "../errors.mjs";
export function parseSecretRef(text) {
  if (typeof text !== "string") throw new DevtwinError("INVALID_INPUT", "Invalid secret reference");
  if (/^keychain:[A-Za-z0-9._-]+\/[A-Za-z0-9._@-]+$/.test(text)) return { kind: "keychain", ref: text };
  if (/^bitwarden:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text)) return { kind: "bitwarden", ref: text };
  if (/^fake:[A-Za-z0-9._-]+$/.test(text)) return { kind: "fake", name: text.slice(5) };
  throw new DevtwinError("INVALID_INPUT", "Invalid secret reference");
}
