// U27 (KTD35): confirmed kit and config paths. `paths confirm` records the real path of the running kit, the kit's
// .git/HEAD contents (and the ref file HEAD names), the real path of the pilot file and its SHA-256 in
// stateRoot/confirmed-paths.json. The hook compares them at session start with small file reads only: no Git process,
// no lock. While they match, the session-start line says "Kit and config confirmed." and skills skip the path question.
// confirm is always ask: a forged confirmation would make skills stop asking, so the hook denies its --apply from agent
// shells and the apply shows the owner dialog. check is read-only.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { readPrivateJson, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readPilotBytes, runningKit } from "../hooks/receipt.mjs";

export const FIELDS = Object.freeze(["kitRoot", "kitHead", "kitRef", "pilotPath", "pilotSha256"]);
export const confirmedPath = (stateRoot) => join(stateRoot, "confirmed-paths.json");
const REF = /^ref: (refs\/[A-Za-z0-9._/-]{1,200})$/;
const small = (path) => {
  const text = readFileSync(path, "utf8");
  if (text.length > 4096) throw new DevtwinError("LIMIT", "Git file exceeds limit");
  return text.trim();
};
// The kit's Git folder: .git, or the folder a .git file names (a linked worktree).
function gitDirs(kit) {
  const dot = join(kit, ".git");
  if (!lstatSync(dot).isFile()) return { gitDir: dot, commonDir: dot };
  const named = /^gitdir: (.+)$/.exec(small(dot))?.[1];
  if (!named) throw new DevtwinError("GATE_REQUIRED", "Kit Git folder unreadable", { field: "kitRoot" });
  const gitDir = isAbsolute(named) ? named : resolve(kit, named);
  let commonDir = gitDir;
  try { commonDir = resolve(gitDir, small(join(gitDir, "commondir"))); } catch { /* No common folder. */ }
  return { gitDir, commonDir };
}
// HEAD as written, and the commit its ref names (loose ref, then packed-refs), or null for a detached HEAD.
export function readKitHead(kit) {
  const { gitDir, commonDir } = gitDirs(kit);
  const head = small(join(gitDir, "HEAD")), ref = REF.exec(head)?.[1];
  if (!ref) return { kitHead: head, kitRef: null };
  if (ref.split("/").some((part) => part === ".." || part === ".")) throw new DevtwinError("GATE_REQUIRED", "Kit HEAD unreadable", { field: "kitRoot" });
  for (const dir of [...new Set([gitDir, commonDir])]) {
    try { return { kitHead: head, kitRef: small(join(dir, ref)) }; } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let packed = "";
  try { packed = readFileSync(join(commonDir, "packed-refs"), "utf8"); } catch { /* No packed refs. */ }
  const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
  return { kitHead: head, kitRef: line ? line.split(" ")[0] : null };
}
// The values as they are now. Any read problem throws.
export function currentPaths({ pilotPath, pilotBytes, kitRoot }) {
  const kit = runningKit(kitRoot), real = realpathSync(pilotPath);
  return { kitRoot: kit, ...readKitHead(kit), pilotPath: real, pilotSha256: sha256(pilotBytes ?? readPilotBytes(real)) };
}
// { state: "confirmed" | "missing" | "invalid" | "mismatch", fields?, confirmedAt? }. Never throws.
export async function confirmationState(stateRoot, { pilotPath, pilotBytes, kitRoot }) {
  let saved;
  try { saved = await readPrivateJson(confirmedPath(stateRoot), 4096); }
  catch (error) { return { state: error.code === "ENOENT" ? "missing" : "invalid" }; }
  if (saved?.schemaVersion !== 1 || typeof saved.confirmedAt !== "string" || FIELDS.some((key) => !Object.hasOwn(saved, key))) return { state: "invalid" };
  let now;
  try { now = currentPaths({ pilotPath, pilotBytes, kitRoot }); } catch { now = {}; }
  const fields = Object.fromEntries(FIELDS.map((key) => [key, now[key] !== undefined && now[key] === saved[key] ? "match" : "mismatch"]));
  return { state: Object.values(fields).every((v) => v === "match") ? "confirmed" : "mismatch", fields, confirmedAt: saved.confirmedAt };
}

const pilotFile = (ctx) => {
  if (typeof ctx.pilot?.path !== "string") throw new DevtwinError("INVALID_INPUT", "Pilot path required", { field: "pilot" });
  return realpathSync(ctx.pilot.path);
};
export function planConfirm(ctx) {
  let values;
  try { values = currentPaths({ pilotPath: pilotFile(ctx), kitRoot: ctx.kitRoot }); }
  catch (error) { if (error instanceof DevtwinError) throw error; throw new DevtwinError("GATE_REQUIRED", "Kit HEAD unreadable", { field: "kitRoot" }); }
  return finalizePlan({ kind: "paths-confirm", file: confirmedPath(ctx.roots.stateRoot), ...values });
}
const dialogFor = (plan) => ({ title: "Confirm the kit and config paths",
  body: "Agents stop asking for these paths while they stay the same.\n\nKit: " + plan.kitRoot + "\nKit HEAD: " + (plan.kitRef ?? plan.kitHead) + "\nConfig: " + plan.pilotPath });
export async function applyConfirm(ctx, fingerprint) {
  const plan = planConfirm(ctx);
  assertFingerprint(plan, fingerprint);
  await (await import("../owner/dialog.mjs")).requireOwnerApproval(ctx, dialogFor(plan));
  // The config may have changed while the dialog was open.
  assertFingerprint(planConfirm(ctx), fingerprint);
  assertWritable(ctx.roots, [plan.file]);
  ensurePrivatePath(ctx.roots.stateRoot);
  const record = { schemaVersion: 1, ...Object.fromEntries(FIELDS.map((key) => [key, plan[key]])), confirmedAt: ctx.now().toISOString() };
  await atomicReplace(plan.file, JSON.stringify(record) + "\n");
  return { applied: true, ...record, file: plan.file };
}
export async function checkPaths(ctx) {
  const pilotPath = pilotFile(ctx);
  return { file: confirmedPath(ctx.roots.stateRoot), ...(await confirmationState(ctx.roots.stateRoot, { pilotPath, kitRoot: ctx.kitRoot })) };
}
const options = { apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
export const pathsConfirmCommand = { options, run: (values, ctx) => values.apply ? applyConfirm(ctx, values["plan-fingerprint"]) : { preview: true, ...planConfirm(ctx) } };
export const pathsCheckCommand = { options: {}, run: (values, ctx) => checkPaths(ctx) };
