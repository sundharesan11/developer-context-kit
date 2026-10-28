// U30 (KTD29, KTD39): where a project's lessons go in its repository. `project set` is an always-ask owner action: it
// previews, then applies with the plan fingerprint after the owner dialog, and the hook denies its --apply from agent
// shells (src/hooks/owner-block.mjs).
//   --learnings-dir   the repo-relative folder a learning branch adds its file to (default docs/solutions/lessons)
//   --learnings-base  the remote-tracking ref a learning branch starts from, such as refs/remotes/origin/main (a local
//                     branch is refused); "default" goes back to the remote default branch that refs/remotes/origin/HEAD
//                     names
// The settings live next to the project's binding versions, at configRoot/projects/<scope>/<project>/learnings.json
// (0600, atomic replace under the scope lock):
//   { schemaVersion: 1, scope, project, learningsDir: <rel> | null, learningsBase: <ref> | null, updatedAt }
// The binding versions themselves stay as onboarding wrote them. The daily import reads learningsBase from here too
// (src/import/commands.mjs), so the import and the write-back agree on the base.
// Both fields are part of a repo-push consent's rule digest (src/consent/store.mjs), so a change voids the consent of
// each of the project's repositories. The preview names them.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readRegistry } from "../config/registry.mjs";
import { assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { atomicReplace, ensurePrivatePath, readPrivateJson } from "../storage/fsx.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { requireCommittedProject } from "../records/store.mjs";

export const DEFAULT_LEARNINGS_DIR = "docs/solutions/lessons";
export const DEFAULT_LEARNINGS_BASE = "refs/remotes/origin/HEAD";
const REF = /^refs\/remotes\/[A-Za-z0-9._\/-]{1,200}$/;
const KEYS = ["schemaVersion", "scope", "project", "learningsDir", "learningsBase", "updatedAt"];
const invalid = (field, message) => { throw new DevtwinError("INVALID_INPUT", message, { field }); };

export function assertLearningsDir(dir) {
  try { assertSourceRel(dir); } catch { invalid("learnings-dir", "The learnings folder must be a repo-relative folder such as " + DEFAULT_LEARNINGS_DIR); }
  if (isDeniedRel(dir) || dir.split("/").some((part) => part.startsWith("."))) invalid("learnings-dir", "The learnings folder must not be a hidden or protected folder");
  return dir;
}
// The same ref form the import reads (src/import/solutions.mjs).
export function assertLearningsBase(ref) {
  if (typeof ref !== "string" || !REF.test(ref) || ref.split("/").some((part) => !part || part === "." || part === "..")) invalid("learnings-base", "The learnings base must be a remote-tracking ref such as refs/remotes/origin/main");
  return ref;
}
const settingsPath = (roots, scope, project) => { assertScopeId(scope); assertProjectId(project, scope); return join(roots.configRoot, "projects", scope, project, "learnings.json"); };
// The stored settings, with null for a field never set.
export async function readLearningsSettings(roots, scope, project) {
  let value;
  try { value = await readPrivateJson(settingsPath(roots, scope, project), 4096); }
  catch (error) { if (error.code === "ENOENT") return { learningsDir: null, learningsBase: null }; throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !KEYS.includes(key)) || value.schemaVersion !== 1 || value.scope !== scope || value.project !== project) throw new DevtwinError("INTEGRITY", "Project learnings settings invalid", { scope, project });
  if (value.learningsDir !== null) assertLearningsDir(value.learningsDir);
  if (value.learningsBase !== null) assertLearningsBase(value.learningsBase);
  return { learningsDir: value.learningsDir, learningsBase: value.learningsBase };
}
// The newest binding entry for a repository root, or null when the root is not bound.
export async function bindingForRoot(roots, root) {
  const { value } = await readRegistry(roots);
  return value.bindings.filter((entry) => entry.path === root).reduce((latest, x) => !latest || x.bindingVersion > latest.bindingVersion ? x : latest, null);
}
// The bound roots of one project, sorted.
export async function projectRoots(roots, scope, project) {
  const { value } = await readRegistry(roots);
  return [...new Set(value.bindings.filter((entry) => entry.scope === scope && entry.project === project).map((entry) => entry.path))].sort();
}
// The project of a bound root and its effective learnings folder and base ref (null base: origin/HEAD), or null.
export async function learningsFor(roots, root) {
  const entry = await bindingForRoot(roots, root);
  if (!entry) return null;
  const settings = await readLearningsSettings(roots, entry.scope, entry.project);
  return { scope: entry.scope, project: entry.project, learningsDir: settings.learningsDir ?? DEFAULT_LEARNINGS_DIR, learningsBase: settings.learningsBase };
}

export async function planProjectSet(roots, input) {
  const scope = assertScopeId(input.scope), project = input.project;
  assertProjectId(project, scope);
  if (input.learningsDir === undefined && input.learningsBase === undefined) invalid("learnings-dir", "Give --learnings-dir or --learnings-base");
  await requireCommittedProject(roots, scope, project);
  const current = await readLearningsSettings(roots, scope, project);
  const next = { ...current };
  if (input.learningsDir !== undefined) next.learningsDir = assertLearningsDir(input.learningsDir);
  if (input.learningsBase !== undefined) next.learningsBase = input.learningsBase === "default" ? null : assertLearningsBase(input.learningsBase);
  if (canonicalJson(next) === canonicalJson(current)) invalid("learnings-dir", "Nothing to change");
  // The repo-push consents this change voids: each valid consent of the project's repositories.
  const { readConsent, repoConsentWouldHold } = await import("../consent/store.mjs");
  const voids = [];
  for (const root of await projectRoots(roots, scope, project)) {
    const consent = await readConsent(roots, "repo-push", root);
    if (consent?.valid && !repoConsentWouldHold(consent, next)) voids.push(root);
  }
  return finalizePlan({ kind: "project-set", scope, project, current, next, voids, destination: { root: "configRoot", path: "projects/" + scope + "/" + project + "/learnings.json" } });
}
const shown = (value, fallback) => value ?? fallback + " (default)";
const setDialog = (plan) => ({ title: "Change where lessons go in a repository", body: [
  "Project: " + plan.project + " (scope " + plan.scope + ")", "",
  "Learnings folder: " + shown(plan.current.learningsDir, DEFAULT_LEARNINGS_DIR) + " -> " + shown(plan.next.learningsDir, DEFAULT_LEARNINGS_DIR),
  "Learnings base: " + shown(plan.current.learningsBase, DEFAULT_LEARNINGS_BASE) + " -> " + shown(plan.next.learningsBase, DEFAULT_LEARNINGS_BASE), "",
  "A learning branch starts from the base and adds one file in the folder.",
  ...(plan.voids.length ? ["", "This voids the repo-push consent for:", ...plan.voids.map((root) => "- " + root), "Grant it again with consent grant to keep pushing learning branches."] : [])
].join("\n") });
export async function applyProjectSet(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planProjectSet(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, setDialog(plan));
  const path = settingsPath(roots, plan.scope, plan.project);
  assertWritable(roots, [path]);
  return withPilotLock(roots, scopeLockPath(roots, plan.scope), { kind: "project-set" }, async () => {
    if (canonicalJson(await readLearningsSettings(roots, plan.scope, plan.project)) !== canonicalJson(plan.current)) throw new DevtwinError("STALE_VERSION", "Project learnings settings changed");
    ensurePrivatePath(roots.configRoot, ["projects", plan.scope, plan.project]);
    await atomicReplace(path, canonicalJson({ schemaVersion: 1, scope: plan.scope, project: plan.project, ...plan.next, updatedAt: now().toISOString() }) + "\n");
    return { applied: true, scope: plan.scope, project: plan.project, learningsDir: plan.next.learningsDir ?? DEFAULT_LEARNINGS_DIR, learningsBase: plan.next.learningsBase ?? DEFAULT_LEARNINGS_BASE, voided: plan.voids };
  }, { destinations: [path] });
}

export const projectSetCommand = { options: { scope: { type: "string" }, project: { type: "string" }, "learnings-dir": { type: "string" }, "learnings-base": { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const input = { scope: values.scope, project: values.project, learningsDir: values["learnings-dir"], learningsBase: values["learnings-base"] };
  if (!values.apply) return planProjectSet(ctx.roots, input);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyProjectSet(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
