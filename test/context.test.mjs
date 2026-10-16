import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { symlink, mkdir, writeFile, readFile } from "node:fs/promises";
import { twoScopes, draftFor, now } from "./helpers.mjs";
import { addRecord } from "../src/records/store.mjs";
import { buildBrief } from "../src/context/brief.mjs";
import { resolveContext } from "../src/context/resolve.mjs";
import { digest, canonicalJson } from "../src/storage/canonical.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
async function applyProfileFixture(roots, profile) {
  const plan = await planProfile(roots, { profile });
  return applyProfile(roots, { profile, fingerprint: plan.fingerprint }, { now });
}
// Fills notes and stack entries, then pads workKind so the canonical profile is exactly `size` bytes.
function sizedProfile(size) {
  const profile = { workingPreferences: { notes: Array.from({ length: 10 }, (_, i) => String(i).padStart(190, "n")) }, stackKnown: [], workKind: "" };
  while (Buffer.byteLength(canonicalJson(profile)) + 125 < size) profile.stackKnown.push(String(profile.stackKnown.length).padStart(70, "s"));
  profile.workKind = "w".repeat(size - Buffer.byteLength(canonicalJson(profile)));
  return profile;
}
test("cross-scope canary never appears in another scope's brief", async (t) => {
  const s = await twoScopes(t);
  await addRecord(s.roots, draftFor("globex", "globex.beacon", { requestId: "req_canary001", body: "CANARY-GLOBEX-7731" }), { now });
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.ok(!JSON.stringify(brief).includes("CANARY-GLOBEX"));
  assert.ok(!JSON.stringify(brief).toLowerCase().includes("globex"));
  await assert.rejects(resolveContext(s.roots, { scope: "globex", cwd: s.atlas }), (e) => e.code === "DEVCTX_PROJECT_UNBOUND" && e.details.reason === "not-bound-in-scope");
});
test("symlinked cwd refused; subdirectory resolves; brief deterministic and bounded", async (t) => {
  const s = await twoScopes(t);
  await symlink(s.atlas, join(s.base, "alias"));
  await assert.rejects(resolveContext(s.roots, { scope: "acme", cwd: join(s.base, "alias") }), { code: "DEVCTX_PATH_UNSAFE" });
  for (let i = 0; i < 20; i++) await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: `req_bulk${String(i).padStart(4, "0")}`, body: "x".repeat(3000) }), { now });
  const sub = join(s.atlas, "src"); await mkdir(sub);
  assert.equal((await resolveContext(s.roots, { scope: "acme", cwd: sub })).project, "acme.atlas");
  const a = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), b = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(a.briefHash, b.briefHash);
  assert.ok(a.records.length + a.policies.length <= 12);
  assert.ok(a.records.reduce((n, r) => n + Buffer.byteLength(r.body), 0) <= 24576);
  assert.ok(a.omittedIds.length > 0);
  assert.equal(a.receipt.omittedCount.records, a.omittedIds.length);
  const bulk = a.records.filter((r) => r.kind === "fact" && r.title === "Fixture fact");
  assert.ok(bulk.length > 0 && bulk.every((r) => r.body.length === 3000));
});
test("changed source marks needs-revalidation; dirty worktree warns", async (t) => {
  const s = await twoScopes(t);
  const fresh = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  const briefRec = fresh.records.find((r) => r.kind === "brief");
  assert.equal(briefRec.freshness, "current");
  await writeFile(join(s.atlas, "README.md"), "# Atlas\nChanged after onboarding.\n");
  const after = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(after.records.find((r) => r.id === briefRec.id).freshness, "needs-revalidation");
  assert.equal(after.records.find((r) => r.id === briefRec.id).status, "observed");
  assert.ok(after.receipt.records.staleIds.includes(briefRec.id));
  assert.ok(after.warnings.some((w) => w.code === "DIRTY_WORKTREE"));
});
test("required policy is loaded first or the brief fails; optional policy omission is counted", async (t) => {
  const s = await twoScopes(t);
  const hub = join(s.pilot.inputsRoot, "hub-acme"); await mkdir(hub);
  await writeFile(join(hub, "REVIEW.md"), "Every change needs a reviewer.\n");
  await writeFile(join(hub, "HUGE.md"), "p".repeat(24577));
  await writeFile(join(hub, "STYLE.md"), "s".repeat(20000));
  const scopeFile = join(s.roots.configRoot, "scopes/acme.json");
  const base = JSON.parse(await readFile(scopeFile, "utf8"));
  const withPolicies = async (policies) => {
    await writeFile(scopeFile, JSON.stringify({ ...base, hubs: [{ id: "eng", kind: "local-dir", path: hub, purposes: ["policy"] }], policies }));
  };
  await withPolicies([{ id: "pol_review", hubId: "eng", rel: "REVIEW.md", required: true }, { id: "pol_style", hubId: "eng", rel: "STYLE.md", required: false }]);
  for (let i = 0; i < 3; i++) await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: `req_fill${String(i).padStart(4, "0")}`, body: "f".repeat(3000) }), { now });
  const ok = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(ok.policies[0].id, "pol_review");
  assert.deepEqual(ok.receipt.policies.selected.map((p) => p.id), ["pol_review"]);
  assert.deepEqual(ok.receipt.policies.omittedIds, ["pol_style"]);
  assert.equal(ok.receipt.omittedCount.policies, 1);
  await withPolicies([{ id: "pol_huge", hubId: "eng", rel: "HUGE.md", required: true }]);
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), (e) => e.code === "DEVCTX_LIMIT" && e.details.requiredPolicyIds[0] === "pol_huge");
  await withPolicies([{ id: "pol_gone", hubId: "eng", rel: "MISSING.md", required: true }]);
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), (e) => e.code === "DEVCTX_POLICY_UNAVAILABLE" && e.details.policyId === "pol_gone");
});
test("receipt separates preferences, scope policies and project records", async (t) => {
  const s = await twoScopes(t);
  const userFile = join(s.roots.configRoot, "user.json");
  const user = JSON.parse(await readFile(userFile, "utf8"));
  await writeFile(userFile, JSON.stringify({ ...user, preferences: { diagrams: "prefer" } }));
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.deepEqual(brief.preferences, { diagrams: "prefer" });
  assert.equal(brief.receipt.preferences.hash, digest({ diagrams: "prefer" }));
  assert.deepEqual(brief.receipt.policies.selected, []);
  assert.deepEqual(brief.receipt.records.selected.map((r) => r.id).sort(), brief.records.map((r) => r.id).sort());
  assert.ok(!brief.records.some((r) => JSON.stringify(r).includes("diagrams")));
  await writeFile(userFile, JSON.stringify({ ...user, preferences: { client: "acme" } }));
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), { code: "DEVCTX_INVALID_INPUT" });
});
test("brief with a profile includes it, its notice and its hash in the receipt", async (t) => {
  const s = await twoScopes(t);
  const profile = { workKind: "Backend services", stackCurrent: ["Node.js"] };
  const applied = await applyProfileFixture(s.roots, profile);
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.deepEqual(brief.profile.value, profile);
  assert.equal(brief.profile.generation, 1);
  assert.equal(brief.profile.revisionHash, applied.revisionHash);
  assert.match(brief.profile.notice, /preference data/);
  assert.match(brief.profile.notice, /never as permission/);
  assert.deepEqual(brief.receipt.profile, { hash: digest(profile), generation: 1, revisionHash: applied.revisionHash });
  assert.ok(!brief.records.some((r) => r.body.includes("Backend services")));
});
test("brief without a profile is unchanged apart from profile null", async (t) => {
  const s = await twoScopes(t);
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(brief.profile, null);
  assert.deepEqual(Object.keys(brief), ["schemaVersion", "notice", "scope", "project", "worktree", "warnings", "preferences", "profile", "policies", "records", "review", "unknownIds", "disputedIds", "omittedIds", "receipt", "briefHash"]);
  assert.deepEqual(Object.keys(brief.receipt), ["preferences", "policies", "records", "omittedCount", "unknownIds", "snapshotHash"]);
  const { briefHash, ...value } = brief;
  assert.equal(briefHash, digest(value));
});
test("brief keeps a 4096-byte profile and omits records over budget", async (t) => {
  const s = await twoScopes(t);
  const profile = sizedProfile(4096);
  assert.equal(Buffer.byteLength(canonicalJson(profile)), 4096);
  await applyProfileFixture(s.roots, profile);
  for (let i = 0; i < 8; i++) await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: `req_budget${String(i).padStart(4, "0")}`, body: "b".repeat(3000) }), { now });
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.deepEqual(brief.profile.value, profile);
  const recordBytes = brief.records.reduce((n, r) => n + Buffer.byteLength(r.body), 0);
  assert.ok(recordBytes + 4096 <= 24576);
  assert.ok(brief.omittedIds.length > 0);
  assert.equal(brief.receipt.omittedCount.records, brief.omittedIds.length);
});
test("brief profile working preferences supersede the same init preferences", async (t) => {
  const s = await twoScopes(t);
  const userFile = join(s.roots.configRoot, "user.json");
  const user = JSON.parse(await readFile(userFile, "utf8"));
  await writeFile(userFile, JSON.stringify({ ...user, preferences: { explanationStyle: "concise", diagrams: "prefer" } }));
  await applyProfileFixture(s.roots, { workingPreferences: { explanationStyle: "detailed" } });
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(brief.profile.value.workingPreferences.explanationStyle, "detailed");
  assert.deepEqual(brief.preferences, { explanationStyle: "concise", diagrams: "prefer" });
  assert.deepEqual(brief.profile.supersededPreferences, ["explanationStyle"]);
});
test("brief fails with LIMIT and reports profile bytes when required policies plus the profile exceed the budget", async (t) => {
  const s = await twoScopes(t);
  const hub = join(s.pilot.inputsRoot, "hub-acme"); await mkdir(hub);
  await writeFile(join(hub, "BIG.md"), "p".repeat(22000));
  const scopeFile = join(s.roots.configRoot, "scopes/acme.json");
  const base = JSON.parse(await readFile(scopeFile, "utf8"));
  await writeFile(scopeFile, JSON.stringify({ ...base, hubs: [{ id: "eng", kind: "local-dir", path: hub, purposes: ["policy"] }], policies: [{ id: "pol_big", hubId: "eng", rel: "BIG.md", required: true }] }));
  assert.equal((await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas })).policies[0].id, "pol_big");
  await applyProfileFixture(s.roots, sizedProfile(4096));
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), (e) => e.code === "DEVCTX_LIMIT" && e.details.profileBytes === 4096 && e.details.bytes === 22000 && e.details.requiredPolicyIds[0] === "pol_big");
});
test("brief fails with RECOVERY_REQUIRED on a corrupt profile and keeps the committed revision after an interrupted apply", async (t) => {
  const s = await twoScopes(t);
  await applyProfileFixture(s.roots, { workKind: "one" });
  const plan = await planProfile(s.roots, { profile: { workKind: "two" } });
  await assert.rejects(applyProfile(s.roots, { profile: { workKind: "two" }, fingerprint: plan.fingerprint }, { now, faults: { afterRevision: () => { throw new Error("crash"); } } }), /crash/);
  const brief = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.deepEqual(brief.profile.value, { workKind: "one" });
  assert.equal(brief.profile.generation, 1);
  await writeFile(join(s.roots.configRoot, "profile/v1.json"), "{}\n");
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), { code: "DEVCTX_RECOVERY_REQUIRED" });
  await writeFile(join(s.roots.configRoot, "profile/current.json"), "not json");
  await assert.rejects(buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas }), { code: "DEVCTX_RECOVERY_REQUIRED" });
});
