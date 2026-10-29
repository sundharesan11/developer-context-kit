// U43 (KTD2): one kit identity, two kinds. { kind: "git", commit } for a reviewed clone, { kind: "package", version,
// digest } for a package kit under ~/.devtwin/kits. Its kitId string is git:<sha> or npm:<version>+sha256:<64 hex>.
// Configs, receipts and --kit hold the full digest; the 12-hex prefix is only for folder names and display.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { gitCommit } from "./version.mjs";
import { readManifest, DIGEST, COMMIT, VERSION } from "./manifest.mjs";
export { DIGEST, COMMIT, VERSION };
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Kit identity invalid", { field }); };
export const kitsFolder = (home) => join(home, ".devtwin", "kits");
function checked(identity) {
  if (identity?.kind === "git" && Object.keys(identity).length === 2 && typeof identity.commit === "string" && COMMIT.test(identity.commit)) return identity;
  if (identity?.kind === "package" && Object.keys(identity).length === 3 && typeof identity.version === "string" && VERSION.test(identity.version) && typeof identity.digest === "string" && DIGEST.test(identity.digest)) return identity;
  invalid("kit");
}
export const kitId = (identity) => { const k = checked(identity); return k.kind === "git" ? "git:" + k.commit : "npm:" + k.version + "+sha256:" + k.digest; };
export function parseKitId(text) {
  const git = /^git:(.+)$/.exec(text ?? ""), pkg = /^npm:([^+]+)\+sha256:(.+)$/.exec(text ?? "");
  if (git) return checked({ kind: "git", commit: git[1] });
  if (pkg) return checked({ kind: "package", version: pkg[1], digest: pkg[2] });
  invalid("kit");
}
export function displayKitId(value) {
  const k = typeof value === "string" ? parseKitId(value) : checked(value);
  return k.kind === "git" ? "git:" + k.commit.slice(0, 12) : "npm:" + k.version + "+sha256:" + k.digest.slice(0, 12);
}
// A --kit value, <version>+<64 hex>, as a package identity; null for anything else.
export function parseKitArg(text) {
  const parts = typeof text === "string" ? text.split("+") : [];
  return parts.length === 2 && VERSION.test(parts[0]) && DIGEST.test(parts[1]) ? { kind: "package", version: parts[0], digest: parts[1] } : null;
}
// The identity a live block (or a liveGate.kit) names: exactly one of { kitCommit } or { kitVersion, kitDigest }.
export function kitIdentity(live) {
  const has = (key) => live?.[key] !== undefined;
  if (has("kitCommit") && !has("kitVersion") && !has("kitDigest")) return checked({ kind: "git", commit: live.kitCommit });
  if (!has("kitCommit") && has("kitVersion") && has("kitDigest")) return checked({ kind: "package", version: live.kitVersion, digest: live.kitDigest });
  invalid("live");
}
// The live config fields for an identity.
export const kitFields = (identity) => { const k = checked(identity); return k.kind === "git" ? { kitCommit: k.commit } : { kitVersion: k.version, kitDigest: k.digest }; };
// The identity of a kit folder with small reads only: a Git clone is git, a folder with a manifest is package, else null.
// For a package kit this is the manifest's claim; assertKit is what checks the files.
export function identityOfKit(root) {
  const commit = gitCommit(root);
  if (commit) return { kind: "git", commit };
  try { const m = readManifest(root); return { kind: "package", version: m.version, digest: m.digest }; } catch { return null; }
}
