import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, readdir, readFile, mkdir, stat } from "node:fs/promises";
import { makePilot, now, fixtureGit, treeSnapshot } from "./helpers.mjs";
import { planProfile, applyProfile, readProfile, readProfileRevision, PROFILE_CAP } from "../src/profile/store.mjs";
import { validateProfile } from "../src/profile/validate.mjs";
import { canonicalJson } from "../src/storage/canonical.mjs";
const dirOf = (p) => join(p.configRoot, "profile");
async function apply(p, profile) {
  const plan = await planProfile(p.roots, { profile });
  return { plan, result: await applyProfile(p.roots, { profile, fingerprint: plan.fingerprint }, { now }) };
}
// Fills notes and stack entries, then pads workKind so the canonical profile is exactly `size` bytes.
function sized(size) {
  const profile = { workingPreferences: { notes: Array.from({ length: 10 }, (_, i) => String(i).padStart(190, "n")) }, stackKnown: [], workKind: "" };
  while (Buffer.byteLength(canonicalJson(profile)) + 125 < size) profile.stackKnown.push(String(profile.stackKnown.length).padStart(70, "s"));
  profile.workKind = "w".repeat(size - Buffer.byteLength(canonicalJson(profile)));
  return profile;
}
test("profile plan then apply of an empty profile creates revision 1 and a current pointer", async (t) => {
  const p = await makePilot(t);
  const plan = await planProfile(p.roots, { profile: {} });
  assert.equal(plan.preview, true);
  assert.equal(plan.destination, dirOf(p));
  assert.equal(plan.base.generation, 0);
  assert.equal(plan.base.revisionHash, null);
  assert.equal(plan.next.generation, 1);
  assert.deepEqual(plan.profile, {});
  await assert.rejects(access(dirOf(p)));
  const result = await applyProfile(p.roots, { profile: {}, fingerprint: plan.fingerprint }, { now });
  assert.equal(result.generation, 1);
  assert.deepEqual((await readdir(dirOf(p))).sort(), ["current.json", "v1.json"]);
  assert.equal((await stat(join(dirOf(p), "v1.json"))).mode & 0o777, 0o600);
  const current = await readProfile(p.roots);
  assert.equal(current.generation, 1);
  assert.deepEqual(current.profile, {});
  assert.equal(current.revisionHash, result.revisionHash);
});
test("profile read before any apply reports no profile", async (t) => {
  const p = await makePilot(t);
  assert.deepEqual(await readProfile(p.roots), { generation: 0, revisionHash: null, profile: null });
});
test("profile second change creates revision 2 and leaves revision 1 unchanged", async (t) => {
  const p = await makePilot(t);
  await apply(p, { workKind: "Backend services" });
  const before = await readFile(join(dirOf(p), "v1.json"), "utf8");
  const { result } = await apply(p, { workKind: "Backend services", stackCurrent: ["Node.js", "PostgreSQL"], workingPreferences: { diagrams: "prefer", autonomy: "ask-first" } });
  assert.equal(result.generation, 2);
  assert.equal(await readFile(join(dirOf(p), "v1.json"), "utf8"), before);
  assert.deepEqual((await readProfileRevision(p.roots, 1)).profile, { workKind: "Backend services" });
  assert.deepEqual((await readProfile(p.roots)).profile.stackCurrent, ["Node.js", "PostgreSQL"]);
});
test("profile cap accepts exactly 4096 canonical bytes and refuses 4097 with the size", async (t) => {
  const p = await makePilot(t);
  assert.equal(PROFILE_CAP, 4096);
  const exact = sized(4096), over = sized(4097);
  assert.equal(Buffer.byteLength(canonicalJson(exact)), 4096);
  assert.equal(Buffer.byteLength(canonicalJson(over)), 4097);
  assert.equal(validateProfile(exact), exact);
  await assert.rejects(planProfile(p.roots, { profile: over }), (error) => error.code === "DEVTWIN_LIMIT" && error.details.size === 4097 && error.details.cap === 4096);
  await apply(p, exact);
  const snapshot = await treeSnapshot(p.configRoot);
  await assert.rejects(applyProfile(p.roots, { profile: over, fingerprint: "sha256:" + "0".repeat(64) }, { now }), { code: "DEVTWIN_LIMIT" });
  assert.equal(await treeSnapshot(p.configRoot), snapshot);
});
test("profile with every field skipped is a valid empty profile", () => {
  assert.deepEqual(validateProfile({}), {});
  assert.deepEqual(validateProfile({ workingPreferences: {}, stackCurrent: [], stackKnown: [], writing: {} }), { workingPreferences: {}, stackCurrent: [], stackKnown: [], writing: {} });
  assert.deepEqual(validateProfile({ writing: { tone: "plain", formality: { team: "casual", client: "formal" }, greeting: "Hi", signOff: "Thanks", length: "short", spelling: "en-GB", avoidPhrases: ["circle back"] } }).writing.formality, { team: "casual", client: "formal" });
});
test("profile refuses unknown keys and invalid field values", () => {
  for (const bad of [null, [], { extra: 1 }, { workingPreferences: { mood: "x" } }, { workingPreferences: { diagrams: "always" } }, { stackCurrent: ["a", "a"] }, { stackCurrent: ["line\nbreak"] }, { workKind: 5 }, { writing: { formality: { team: "loud" } } }, { writing: { length: "epic" } }, { stackKnown: Array.from({ length: 41 }, (_, i) => "s" + i) }]) {
    assert.throws(() => validateProfile(bad), { code: "DEVTWIN_INVALID_INPUT" });
  }
});
test("profile note matching the GitHub-token pattern is refused and nothing is written", async (t) => {
  const p = await makePilot(t);
  const note = "use gh" + "p_" + "A".repeat(36) + " for releases";
  await assert.rejects(planProfile(p.roots, { profile: { workingPreferences: { notes: [note] } } }), { code: "DEVTWIN_SENSITIVE_CONTENT" });
  await assert.rejects(applyProfile(p.roots, { profile: { workingPreferences: { notes: [note] } }, fingerprint: "sha256:" + "0".repeat(64) }, { now }), { code: "DEVTWIN_SENSITIVE_CONTENT" });
  await assert.rejects(access(dirOf(p)));
});
test("profile refuses a key named api_key anywhere", async (t) => {
  const p = await makePilot(t);
  const key = ["api", "key"].join("_");
  for (const profile of [{ [key]: "x" }, { workingPreferences: { [key]: "x" } }, { writing: { formality: { [key]: "formal" } } }]) {
    await assert.rejects(planProfile(p.roots, { profile }), { code: "DEVTWIN_INVALID_INPUT" });
  }
  await assert.rejects(access(dirOf(p)));
});
test("profile apply with a fingerprint computed against revision 1 when revision 2 is current is stale", async (t) => {
  const p = await makePilot(t);
  await apply(p, { workKind: "one" });
  const stalePlan = await planProfile(p.roots, { profile: { workKind: "three" } });
  await apply(p, { workKind: "two" });
  const snapshot = await treeSnapshot(p.configRoot);
  await assert.rejects(applyProfile(p.roots, { profile: { workKind: "three" }, fingerprint: stalePlan.fingerprint }, { now }), { code: "DEVTWIN_STALE_VERSION" });
  assert.equal(await treeSnapshot(p.configRoot), snapshot);
  assert.equal((await readProfile(p.roots)).generation, 2);
});
test("profile apply without a fingerprint or with a mismatched one writes nothing", async (t) => {
  const p = await makePilot(t);
  const plan = await planProfile(p.roots, { profile: { workKind: "one" } });
  await assert.rejects(applyProfile(p.roots, { profile: { workKind: "one" } }, { now }), { code: "DEVTWIN_PLAN_REQUIRED" });
  await assert.rejects(applyProfile(p.roots, { profile: { workKind: "other" }, fingerprint: plan.fingerprint }, { now }), { code: "DEVTWIN_PLAN_MISMATCH" });
  await assert.rejects(access(dirOf(p)));
});
test("profile refuses a config root that is a Git worktree with the copy-or-export remedy", async (t) => {
  const p = await makePilot(t);
  await mkdir(p.configRoot, { mode: 0o700 });
  await fixtureGit(p.configRoot, ["init", "-q"]);
  const check = (error) => error.code === "DEVTWIN_PATH_UNSAFE" && /copy or export/.test(error.details.remedy);
  await assert.rejects(planProfile(p.roots, { profile: {} }), check);
  await assert.rejects(applyProfile(p.roots, { profile: {}, fingerprint: "sha256:" + "0".repeat(64) }, { now }), check);
  await assert.rejects(access(dirOf(p)));
});
test("profile interrupted apply keeps the previous revision current and requires recovery", async (t) => {
  const p = await makePilot(t);
  await apply(p, { workKind: "one" });
  const plan = await planProfile(p.roots, { profile: { workKind: "two" } });
  await assert.rejects(applyProfile(p.roots, { profile: { workKind: "two" }, fingerprint: plan.fingerprint }, { now, faults: { afterRevision: () => { throw new Error("crash"); } } }), /crash/);
  const orphan = await readFile(join(dirOf(p), "v2.json"), "utf8");
  const current = await readProfile(p.roots);
  assert.equal(current.generation, 1);
  assert.deepEqual(current.profile, { workKind: "one" });
  await assert.rejects(planProfile(p.roots, { profile: { workKind: "three" } }), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  const retry = await planProfile(p.roots, { profile: { workKind: "two" } }).catch((error) => error);
  assert.equal(retry.code, "DEVTWIN_RECOVERY_REQUIRED");
  await assert.rejects(applyProfile(p.roots, { profile: { workKind: "two" }, fingerprint: plan.fingerprint }, { now }), (error) => error.code === "DEVTWIN_RECOVERY_REQUIRED" && error.details.generation === 2);
  assert.equal(await readFile(join(dirOf(p), "v2.json"), "utf8"), orphan);
  assert.equal((await readProfile(p.roots)).generation, 1);
});
