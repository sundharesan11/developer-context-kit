import test from "node:test";
import assert from "node:assert/strict";
import {mkdir, readFile, writeFile, readdir, chmod, rm, symlink, link} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {stageSourceFixture, treeSnapshot, runCli} from "./helpers.mjs";
import {reviewSourcePackage} from "../src/skill-sources/package.mjs";
import {approveSourceContent, planSourceInstall, approveSourceAction, applySourceInstall, sourceInstallStatus} from "../src/skill-sources/installation.mjs";
import {withPilotLock} from "../src/storage/lock.mjs";
import {journals} from "../src/agents/package-files.mjs";
import {applyPackageInstall} from "../src/agents/package-install.mjs";

let sequence = 0;
const id = () => "dc_source" + String(++sequence).padStart(8, "0");
async function approved(t, opts = {}) {
  const x = await stageSourceFixture(t, opts), review = await reviewSourcePackage(x.p.roots, x), contentDecisionId = id();
  await approveSourceContent(x.p.roots, {...x, packageDigest: review.packageDigest}, {decisionId: contentDecisionId, interactionRef: "user:fixture", responseText: `Approved source content ${review.packageDigest} with caller-supplied-unverified pin`});
  return {...x, review, input: {contentDecisionId, targetHome: x.p.agentHomes[0], agents: ["claude", "codex"], mode: "install"}};
}
async function action(x, patch = {}) {
  const input = {...x.input, ...patch}, plan = await planSourceInstall(x.p.roots, input), decisionId = id();
  const approval = {decisionId, fingerprint: plan.fingerprint, interactionRef: "user:fixture", responseText: `Approved source ${input.mode} ${plan.fingerprint}`};
  await approveSourceAction(x.p.roots, input, approval);
  return {input, plan, approval};
}
const apply = (x, a, options) => applySourceInstall(x.p.roots, a.input, a.approval, options);
const target = (x, agent = "codex") => join(x.input.targetHome, agent === "codex" ? ".agents/skills" : ".claude/skills", "example-skill");

test("source sandbox lifecycle installs updates restores and removes exact reviewed bytes", async (t) => {
  const a = await approved(t), install = await action(a);
  assert.deepEqual(install.plan.actions.map((a) => a.status), ["create", "create"]);
  await apply(a, install);
  for (const host of ["claude", "codex"]) {
    assert.equal(await readFile(join(target(a, host), "LICENSE"), "utf8"), a.contents.LICENSE);
    assert.equal(JSON.parse(await readFile(join(target(a, host), ".devtwin-owned.json"))).schemaVersion, 3);
  }
  assert.equal(existsSync(join(a.input.targetHome, ".codex")), false);
  const b = await approved(t, {p: a.p, version: 2});
  const update = await action(b); assert.deepEqual(update.plan.actions.map((a) => a.status), ["update", "update"]);
  await apply(b, update);
  assert.match(await readFile(join(target(a), "SKILL.md"), "utf8"), /Version 2/);
  const restore = await action(a); await apply(a, restore);
  assert.equal(await readFile(join(target(a), "SKILL.md"), "utf8"), a.contents["skills/example-skill/SKILL.md"]);
  const remove = await action(a, {mode: "uninstall"}); await apply(a, remove);
  assert.equal(existsSync(target(a)), false);
  assert.equal(existsSync(a.stagePath), true);
  assert.equal((await readdir(join(a.p.dataRoot, "skill-sources/decisions"))).length, 6);
});

test("source approvals bind content actions and explicit unverified pin acceptance", async (t) => {
  const x = await stageSourceFixture(t), review = await reviewSourcePackage(x.p.roots, x);
  const input = {...x, packageDigest: review.packageDigest}, d = {decisionId: id(), interactionRef: "user:fixture", responseText: `Approved source content ${review.packageDigest}`};
  await assert.rejects(approveSourceContent(x.p.roots, input, d));
  d.responseText += " with caller-supplied-unverified pin";
  await assert.rejects(approveSourceContent(x.p.roots, {...input, packageDigest: "sha256:" + "0".repeat(64)}, d));
  await approveSourceContent(x.p.roots, input, d);
  await assert.rejects(approveSourceContent(x.p.roots, input, d), {code: "DEVTWIN_CONFLICT"});
  const mapping = structuredClone(x.mapping); mapping.dependencies.push({name: "missing-runtime", status: "missing"});
  const held = await reviewSourcePackage(x.p.roots, {...x, mapping});
  await assert.rejects(approveSourceContent(x.p.roots, {...x, mapping, packageDigest: held.packageDigest}, {...d, decisionId: id(), responseText: `Approved source content ${held.packageDigest} with caller-supplied-unverified pin`}));
  const y = await approved(t), a = await action(y);
  await assert.rejects(apply(y, {...a, approval: {...a.approval, fingerprint: "sha256:" + "0".repeat(64)}}), {code: "DEVTWIN_PLAN_MISMATCH"});
  await apply(y, a);
  await assert.rejects(apply(y, a));
});

test("source update and restoration preserve edited foreign linked and executable entries", async (t) => {
  for (const mutation of ["edit", "extra", "empty", "symlink", "hardlink", "executable", "directory-mode"]) {
    const x = await approved(t); await apply(x, await action(x));
    const dir = target(x);
    if (mutation === "edit") await writeFile(join(dir, "SKILL.md"), "User edit");
    if (mutation === "extra") await writeFile(join(dir, "extra.txt"), "User file", {mode: 0o600});
    if (mutation === "empty") await mkdir(join(dir, "empty"), {mode: 0o700});
    if (mutation === "symlink") await symlink(join(dir, "LICENSE"), join(dir, "linked"));
    if (mutation === "hardlink") await link(join(dir, "LICENSE"), join(dir, "linked"));
    if (mutation === "executable") await chmod(join(dir, "scripts/inert.mjs"), 0o700);
    if (mutation === "directory-mode") await chmod(dir, 0o1700);
    const before = await treeSnapshot(dir), plan = await planSourceInstall(x.p.roots, x.input);
    assert.equal(plan.actions.find((a) => a.agent === "codex").status, "modified", mutation);
    await assert.rejects(action(x));
    assert.equal(await treeSnapshot(dir), before);
  }
});

test("source uninstallation survives lost staging but requires the exact current decision", async (t) => {
  for (const damaged of ["missing", "corrupt"]) {
    const x = await approved(t); await apply(x, await action(x));
    const y = await approved(t, {p: x.p});
    const wrong = await planSourceInstall(y.p.roots, {...y.input, mode: "uninstall"});
    assert.ok(wrong.actions.every((a) => a.status === "conflict"));
    if (damaged === "missing") await rm(x.stagePath, {recursive: true});
    else await writeFile(join(x.stagePath, "files/LICENSE"), "Damaged staging");
    await assert.rejects(planSourceInstall(x.p.roots, x.input));
    await apply(x, await action(x, {mode: "uninstall"}));
    assert.equal(existsSync(target(x)), false);
  }
});

test("source collision policy refuses adoption legacy copies and subset host actions", async (t) => {
  const x = await approved(t);
  await mkdir(target(x), {recursive: true, mode: 0o700});
  await writeFile(join(target(x), "SKILL.md"), x.contents["skills/example-skill/SKILL.md"], {mode: 0o600});
  assert.equal((await planSourceInstall(x.p.roots, x.input)).actions.find((a) => a.agent === "codex").status, "conflict");
  await assert.rejects(action(x));
  const y = await approved(t); await apply(y, await action(y));
  const subset = await planSourceInstall(y.p.roots, {...y.input, agents: ["codex"]});
  assert.equal(subset.actions[0].status, "conflict");
  const z = await approved(t);
  await mkdir(join(z.input.targetHome, ".codex/skills/example-skill"), {recursive: true, mode: 0o700});
  assert.ok((await planSourceInstall(z.p.roots, z.input)).actions.every((a) => a.status === "conflict"));
});

test("source partial writes retain recovery evidence and consume only one action approval", async (t) => {
  for (const hook of ["afterConsume", "afterJournal", "beforeReceipt", "afterAction"]) {
    const x = await approved(t), a = await action(x);
    await assert.rejects(apply(x, a, {faults: {[hook]: async () => { throw new Error("PRIVATE_FAULT_CANARY"); }}}), (e) => !JSON.stringify(e).includes("PRIVATE_FAULT_CANARY"));
    const status = await sourceInstallStatus(x.p.roots, x.input);
    assert.ok(status.consumed.includes(a.approval.decisionId));
    if (hook === "afterAction") assert.deepEqual(status.actions.map(({agent, status}) => ({agent, status})), [{agent: "claude", status: "installed"}, {agent: "codex", status: "create"}]);
    if (hook !== "afterConsume") {
      assert.equal(status.status, "RECOVERY_REQUIRED");
      assert.ok((await journals(x.p.roots, x.input.targetHome)).incomplete.length);
    }
    await assert.rejects(apply(x, a));
  }
});

test("source apply rechecks stage target decisions and selected host compatibility", async (t) => {
  const x = await approved(t), a = await action(x);
  await assert.rejects(apply(x, a, {faults: {afterJournal: async () => writeFile(join(x.stagePath, "files/LICENSE"), "Changed")}}));
  assert.equal(existsSync(target(x)), false);
  const y = await approved(t), b = await action(y);
  await mkdir(target(y), {recursive: true, mode: 0o700});
  await assert.rejects(apply(y, b));
  const z = await approved(t);
  const decision = join(z.p.dataRoot, "skill-sources/decisions", z.input.contentDecisionId + ".json");
  await chmod(decision, 0o700);
  await assert.rejects(planSourceInstall(z.p.roots, z.input), {code: "DEVTWIN_PATH_UNSAFE"});
});

test("source installer shares the personal install lock and never breaks a foreign lock", async (t) => {
  const x = await approved(t), a = await action(x);
  await withPilotLock(x.p.roots, join(x.p.stateRoot, "locks/install.lock"), {kind: "fixture-owner"}, async () => {
    await assert.rejects(apply(x, a), {code: "DEVTWIN_BUSY"});
    assert.equal(existsSync(join(x.p.stateRoot, "locks/install.lock")), true);
  }, {destinations: [x.input.targetHome], targetHome: x.input.targetHome});
  assert.equal(existsSync(target(x)), false);
});

test("malformed completed source journals block both package adapters", async (t) => {
  const x = await approved(t), runPath = join(x.p.stateRoot, "runs/run_malformed01");
  await mkdir(runPath, {recursive: true, mode: 0o700});
  await writeFile(join(runPath, "journal.json"), JSON.stringify({kind: "skill-source-local", targetHome: x.input.targetHome, intended: [], completed: []}), {mode: 0o600});
  assert.deepEqual((await journals(x.p.roots, x.input.targetHome)).incomplete, ["run_malformed01"]);
  const a = await action(x);
  await assert.rejects(apply(x, a), {code: "DEVTWIN_RECOVERY_REQUIRED"});
  await assert.rejects(applyPackageInstall(x.p.roots, {audience: "personal", workspace: "ws_recovery1"},
    {targetHome: x.input.targetHome, agents: ["claude"], mode: "install", revisionId: "rv_unknown01", contentDecisionId: "dc_unknown01"},
    {decisionId: "dc_unknown02", fingerprint: "sha256:" + "0".repeat(64)}
  ), {code: "DEVTWIN_RECOVERY_REQUIRED"});
});

test("source installation keeps unreviewed host compatibility and pilot gates visible", async (t) => {
  const x = await stageSourceFixture(t);
  x.mapping.compatibility.codex = "unsupported";
  const review = await reviewSourcePackage(x.p.roots, x), contentDecisionId = id();
  const input = {...x, packageDigest: review.packageDigest}, approval = {decisionId: contentDecisionId, interactionRef: "user:fixture", responseText: `Approved source content ${review.packageDigest} with caller-supplied-unverified pin`};
  await assert.rejects(approveSourceContent(undefined, input, approval), {code: "DEVTWIN_GATE_REQUIRED"});
  await approveSourceContent(x.p.roots, input, approval);
  const install = {contentDecisionId, targetHome: x.p.agentHomes[0], agents: ["codex"], mode: "install"};
  const plan = await planSourceInstall(x.p.roots, install);
  assert.deepEqual(plan.holds, [{code: "COMPATIBILITY_UNSUPPORTED", agent: "codex"}]);
  await assert.rejects(approveSourceAction(x.p.roots, install, {decisionId: id(), fingerprint: plan.fingerprint, interactionRef: "user:fixture", responseText: `Approved source install ${plan.fingerprint}`}), {code: "DEVTWIN_CONFLICT"});
  await assert.rejects(planSourceInstall(undefined, install), {code: "DEVTWIN_GATE_REQUIRED"});
  await assert.rejects(applySourceInstall(undefined, install, {decisionId: id()}), {code: "DEVTWIN_GATE_REQUIRED"});
});

test("source updates refuse path role changes case aliases and moved package roots", async (t) => {
  const x = await approved(t); await apply(x, await action(x));
  for (const rel of ["references/Guide.md", "references/guide.md/child.md"]) {
    const y = await approved(t, {p: x.p, version: 2, contents: {LICENSE: "License", "skills/example-skill/SKILL.md": "---\nname: example-skill\n---\nBody", ["skills/example-skill/" + rel]: "Changed layout"}});
    assert.ok((await planSourceInstall(y.p.roots, y.input)).actions.every((a) => a.status === "conflict"));
    await assert.rejects(action(y));
  }
  const moved = await approved(t, {p: x.p, version: 2, skillRoot: "other/example-skill"});
  assert.ok((await planSourceInstall(moved.p.roots, moved.input)).actions.every((a) => a.status === "conflict"));
  const foreign = await approved(t, {p: x.p, sourceId: "superpowers"});
  assert.ok((await planSourceInstall(foreign.p.roots, foreign.input)).actions.every((a) => a.status === "conflict"));
});

test("source package CLI requires a pilot and explicit two-step approvals", async (t) => {
  const x = await stageSourceFixture(t);
  const args = ["--pilot", x.p.path, "--run", x.stageRunId, "--mapping-json", JSON.stringify(x.mapping)];
  const review = await runCli(["skill-sources", "package-review", ...args]);
  assert.equal(review.code, 0, JSON.stringify(review.json));
  assert.equal((await runCli(["skill-sources", "package-review"])).json.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal((await runCli(["skill-sources", "package-review", ...args, "--run", x.stageRunId])).code, 2);
  const contentId = id(), packageDigest = review.json.result.packageDigest;
  const approve = await runCli(["skill-sources", "content-approve", ...args, "--package-digest", packageDigest, "--decision", contentId, "--interaction-ref", "user:fixture", "--response", `Approved source content ${packageDigest} with caller-supplied-unverified pin`]);
  assert.equal(approve.code, 0, JSON.stringify(approve.json));
  const flags = ["--pilot", x.p.path, "--content-decision", contentId, "--home", x.p.agentHomes[0], "--agent-json", '["claude","codex"]', "--mode", "install"];
  const plan = await runCli(["skill-sources", "local-plan", ...flags]); assert.equal(plan.code, 0);
  const actionId = id(), approvalFlags = ["--decision", actionId, "--plan-fingerprint", plan.json.result.fingerprint];
  const decision = await runCli(["skill-sources", "local-approve", ...flags, ...approvalFlags, "--interaction-ref", "user:fixture", "--response", `Approved source install ${plan.json.result.fingerprint}`]);
  assert.equal(decision.code, 0, JSON.stringify(decision.json));
  const applied = await runCli(["skill-sources", "local-apply", ...flags, ...approvalFlags]); assert.equal(applied.code, 0, JSON.stringify(applied.json));
  const status = await runCli(["skill-sources", "local-status", ...flags]); assert.equal(status.json.result.status, "ok");
});
