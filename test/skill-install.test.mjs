import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat, readdir, unlink, rename, symlink, link, chmod, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { makePilot, runCli, stageSourceFixture } from "./helpers.mjs";
import { createWorkspace, recordRequirements, recordDesign, approveDesign, createDraft, validateDraft } from "../src/skill-builder/workspace.mjs";
import { planPackageInstall, applyPackageInstall } from "../src/agents/package-install.mjs";
import { digest, sha256 } from "../src/storage/canonical.mjs";
import {reviewSourcePackage} from "../src/skill-sources/package.mjs";
import {approveSourceContent, planSourceInstall, approveSourceAction, applySourceInstall} from "../src/skill-sources/installation.mjs";

const selection = { audience: "personal", workspace: "ws_install01" };
const args = ["--audience", "personal", "--workspace", "ws_install01"];
const response = (kind, hash) => `Approved ${kind} ${hash}`;

test("package receipt is not published when output changes before receipt", async (t) => {
  const x = await approvedInstall(t);
  const input = {revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install"};
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input,
    {fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_verify001"},
    {faults: {beforeReceipt: async (action) => writeFile(join(action.path, "SKILL.md"), "changed")}}
  ), {code: "DEVCTX_INTEGRITY"});
  assert.equal((await readdir(x.dir)).includes(".devctx-owned.json"), false);
});

test("personal Codex plan refuses a competing shared skills copy", async (t) => {
  const x = await approvedInstall(t);
  const competing = join(x.home, ".agents/skills/summarize-note");
  await mkdir(competing, {recursive: true, mode: 0o700});
  await writeFile(join(competing, "SKILL.md"), "Foreign content", {mode: 0o600});
  const plan = await planPackageInstall(x.p.roots, selection, {revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["codex"], mode: "install"});
  assert.equal(plan.actions[0].status, "conflict");
  assert.equal(await readFile(join(competing, "SKILL.md"), "utf8"), "Foreign content");
});

test("package receipt refuses unexpected empty directories at publication", async (t) => {
  const x = await approvedInstall(t);
  const input = {revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install"};
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input,
    {fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_emptydir01"},
    {faults: {beforeReceipt: async (action) => mkdir(join(action.path, "extra"), {mode: 0o700})}}
  ), {code: "DEVCTX_INTEGRITY"});
});

test("personal and source packages refuse each others valid ownership markers", async (t) => {
  for (const first of ["personal", "source"]) {
    const x = await approvedInstall(t);
    const staged = await stageSourceFixture(t, {p: x.p, skillRoot: "", contents: {LICENSE: "Synthetic license", "SKILL.md": "---\nname: summarize-note\ndescription: Source fixture.\n---\nSource fixture body.\n"}});
    staged.mapping.name = "summarize-note";
    const review = await reviewSourcePackage(x.p.roots, staged);
    await approveSourceContent(x.p.roots, {...staged, packageDigest: review.packageDigest}, {decisionId: "dc_crosscontent01", interactionRef: "user:fixture", responseText: `Approved source content ${review.packageDigest} with caller-supplied-unverified pin`});
    const sourceInput = {contentDecisionId: "dc_crosscontent01", targetHome: x.home, agents: ["claude"], mode: "install"};
    const personalInput = {revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install"};
    if (first === "personal") {
      await applyApproved(x);
      assert.equal((await planSourceInstall(x.p.roots, sourceInput)).actions[0].status, "conflict");
    } else {
      const plan = await planSourceInstall(x.p.roots, sourceInput);
      const approval = {decisionId: "dc_crossaction01", fingerprint: plan.fingerprint, interactionRef: "user:fixture", responseText: `Approved source install ${plan.fingerprint}`};
      await approveSourceAction(x.p.roots, sourceInput, approval);
      await applySourceInstall(x.p.roots, sourceInput, approval);
      assert.equal((await planPackageInstall(x.p.roots, selection, personalInput)).actions[0].status, "conflict");
    }
  }
});
async function cli(p, route, more = []) { return runCli(["skill", route, "--pilot", p.path, ...args, ...more]); }
async function fixture(t, { oldReference = false, oldReferenceName = "old.md", oldNestedReference = false, name = "summarize-note", title = "Summary" } = {}) {
  const p = await makePilot(t);
  await createWorkspace(p.roots, selection);
  const req = { goal: "Summarize a synthetic note", success: "A short summary", examples: ["Summarize note"], negativeExample: "Write note", inputs: [], permittedTools: [], forbiddenTools: [], permittedContext: [], forbiddenContext: [], supportedAgents: ["codex", "claude"], output: "Markdown", failure: "Explain", destination: "private", unknowns: [] };
  const design = { name, description: "Summarize a synthetic note.", workflow: ["Read", "Summarize"], outputs: ["Markdown"], dependencies: [], tests: ["fixture"], tree: ["SKILL.md"], destinations: ["private"], reuse: "Synthetic fixture" };
  const rq = join(p.inputsRoot, "rq.json"), ds = join(p.inputsRoot, "ds.json");
  await writeFile(rq, JSON.stringify(req)); await writeFile(ds, JSON.stringify(design));
  await recordRequirements(p.roots, selection, "rq_install01", rq);
  const recorded = await recordDesign(p.roots, selection, "rq_install01", "ds_install01", ds);
  await approveDesign(p.roots, selection, "ds_install01", "dc_design01", "user:synthetic", response("", recorded.digest).replace("  ", " "));
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), `---\nname: ${name}\ndescription: Summarize a synthetic note.\n---\n# ${title}\n`);
  if (oldReference) { await mkdir(join(candidate, "references")); await writeFile(join(candidate, "references", oldReferenceName), "Old synthetic reference.\n"); }
  if (oldNestedReference) { await mkdir(join(candidate, "references/old.md"), { recursive: true }); await writeFile(join(candidate, "references/old.md/child.md"), "Nested synthetic reference.\n"); }
  const draft = await createDraft(p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install01", candidate });
  const validation = await validateDraft(p.roots, selection, "rv_install01");
  assert.equal(validation.valid, true);
  return { p, draft };
}
async function approvedInstall(t, opts = {}) {
  const { p, draft } = await fixture(t, opts), home = p.agentHomes[0];
  const content = await cli(p, "content-approve", ["--revision", "rv_install01", "--decision", "dc_content01", "--interaction-ref", "user:synthetic", `--response`, `Approved content ${draft.packageDigest} as personal generic non-confidential`]);
  assert.equal(content.code, 0, JSON.stringify(content.json));
  const install = ["--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", home, "--agent", "claude"];
  const plan = await cli(p, "local-plan", install);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  const approval = await cli(p, "local-approve", [...install, "--decision", "dc_local001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)]);
  assert.equal(approval.code, 0, JSON.stringify(approval.json));
  return { p, home, install, plan: plan.json.result, dir: join(home, ".claude/skills/summarize-note") };
}
async function applyApproved(x) {
  const result = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package01"]);
  assert.equal(result.code, 0, JSON.stringify(result.json));
}
async function addRevision(x, revisionId, contentDecisionId, title) {
  const candidate = join(x.p.inputsRoot, "candidate-" + revisionId); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), `---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# ${title}\n`);
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId, candidate });
  await validateDraft(x.p.roots, selection, revisionId);
  const approved = await cli(x.p, "content-approve", ["--revision", revisionId, "--decision", contentDecisionId, "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`]);
  assert.equal(approved.code, 0, JSON.stringify(approved.json));
  return ["--mode", "install", "--revision", revisionId, "--content-decision", contentDecisionId, "--home", x.home, "--agent", "claude"];
}

test("synthetic content and action approvals install pinned copies in a disposable home", async (t) => {
  const { p, draft } = await fixture(t), home = p.agentHomes[0];
  const content = await cli(p, "content-approve", ["--revision", "rv_install01", "--decision", "dc_content01", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`]);
  assert.equal(content.code, 0, JSON.stringify(content.json));
  const common = ["--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", home, "--agent", "claude", "--agent", "codex"];
  const plan = await cli(p, "local-plan", common);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.result.actions.map((a) => a.status), ["create", "create"]);
  const approved = await cli(p, "local-approve", [...common, "--decision", "dc_local001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)]);
  assert.equal(approved.code, 0, JSON.stringify(approved.json));
  const applied = await cli(p, "local-apply", [...common, "--decision", "dc_local001", "--plan-fingerprint", plan.json.result.fingerprint, "--run-id", "run_package01"]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  for (const agent of ["claude", "codex"]) {
    const dir = join(home, `.${agent}/skills/summarize-note`);
    assert.match(await readFile(join(dir, "SKILL.md"), "utf8"), /# Summary/);
    assert.equal((await stat(join(dir, "SKILL.md"))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(join(dir, ".devctx-owned.json"), "utf8")).schemaVersion, 2);
  }
  assert.equal((await cli(p, "local-apply", [...common, "--decision", "dc_local001", "--plan-fingerprint", plan.json.result.fingerprint, "--run-id", "run_package02"])).code, 1);
});

test("uninstall requires a distinct approval and preserves the whole edited package", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const remove = ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", remove);
  assert.equal(plan.json.result.actions[0].status, "remove");
  const approved = await cli(x.p, "local-approve", [...remove, "--decision", "dc_remove001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("uninstall", plan.json.result.fingerprint)]);
  assert.equal(approved.code, 0, JSON.stringify(approved.json));
  await writeFile(join(x.dir, "SKILL.md"), "user edited");
  const blocked = await cli(x.p, "local-apply", [...remove, "--decision", "dc_remove001", "--plan-fingerprint", plan.json.result.fingerprint, "--run-id", "run_remove001"]);
  assert.equal(blocked.code, 1);
  assert.equal(await readFile(join(x.dir, "SKILL.md"), "utf8"), "user edited");
  assert.ok((await readdir(x.dir)).includes(".devctx-owned.json"));
});

test("uninstall of intact package removes only its owned files", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const remove = ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", remove);
  const approved = await cli(x.p, "local-approve", [...remove, "--decision", "dc_remove001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("uninstall", plan.json.result.fingerprint)]);
  assert.equal(approved.code, 0, JSON.stringify(approved.json));
  const applied = await cli(x.p, "local-apply", [...remove, "--decision", "dc_remove001", "--plan-fingerprint", plan.json.result.fingerprint, "--run-id", "run_remove001"]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal((await cli(x.p, "local-plan", remove)).json.result.actions[0].status, "absent");
});

test("interrupted create is reported and blocks package apply until journal review", async (t) => {
  const x = await approvedInstall(t), input = { revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install" };
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input, { fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_package01" }, { faults: { beforeReceipt: async () => { throw new Error("synthetic interruption"); } } }), /synthetic interruption/);
  const status = await cli(x.p, "local-status", ["--mode", "install", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(status.json.result.status, "RECOVERY_REQUIRED");
  assert.equal(status.json.result.actions[0].status, "conflict");
  const retry = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package02"]);
  assert.equal(retry.json.error.code, "DEVCTX_RECOVERY_REQUIRED");
});

test("stale fingerprint and reused run ID do not consume a local approval", async (t) => {
  const x = await approvedInstall(t);
  const stale = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", "sha256:" + "0".repeat(64), "--run-id", "run_package01"]);
  assert.equal(stale.json.error.code, "DEVCTX_PLAN_MISMATCH");
  const markerPath = join(x.p.stateRoot, "skill-installs/consumed/ws_install01/dc_local001.json");
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(markerPath), false);
  await mkdir(join(x.p.stateRoot, "runs/run_package01"), { recursive: true });
  const reuse = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package01"]);
  assert.equal(reuse.json.error.code, "DEVCTX_CONFLICT");
  assert.equal(existsSync(markerPath), false);
});

test("approved update swaps the pinned revision and removes only old files", async (t) => {
  const x = await approvedInstall(t, { oldReference: true }); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "new-candidate");
  await mkdir(join(candidate, "references"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Updated\n");
  await writeFile(join(candidate, "references/new.md"), "New synthetic reference.\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const update = ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", update);
  assert.equal(plan.json.result.actions[0].status, "update");
  assert.equal((await cli(x.p, "local-approve", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)])).code, 0);
  const applied = await cli(x.p, "local-apply", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--run-id", "run_update001"]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal((await readdir(join(x.dir, "references"))).join(","), "new.md");
  assert.match(await readFile(join(x.dir, "SKILL.md"), "utf8"), /Updated/);
});

test("unsafe installed directory mode is modified and cannot be uninstalled", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  await chmod(x.dir, 0o755);
  const remove = await cli(x.p, "local-plan", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(remove.json.result.actions[0].status, "modified");
});

test("direct package APIs reject roots without the matching pilot before target reads", async (t) => {
  const x = await approvedInstall(t);
  const input = { revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install" };
  await assert.rejects(planPackageInstall({ ...x.p.roots, pilot: { ...x.p.pilot, agentHomes: [x.p.fakeHome] } }, selection, input), { code: "DEVCTX_GATE_REQUIRED" });
  await assert.rejects(planPackageInstall({ dataRoot: x.p.dataRoot, stateRoot: x.p.stateRoot }, selection, input), { code: "DEVCTX_GATE_REQUIRED" });
});

test("untrusted receipt cannot name a path outside the installed package", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const receiptPath = join(x.dir, ".devctx-owned.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.files["../other.md"] = receipt.files["SKILL.md"];
  await writeFile(receiptPath, JSON.stringify(receipt));
  const remove = await cli(x.p, "local-plan", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(remove.json.result.actions[0].status, "modified");
  assert.match(await readFile(join(x.dir, "SKILL.md"), "utf8"), /# Summary/);
});

test("content approval needs explicit generic-content attestation", async (t) => {
  const { p, draft } = await fixture(t);
  const denied = await cli(p, "content-approve", ["--revision", "rv_install01", "--decision", "dc_content01", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest}`]);
  assert.equal(denied.json.error.code, "DEVCTX_APPROVAL_REQUIRED");
});

test("reviewed interrupted journal clears the recovery gate without deleting partial files", async (t) => {
  const x = await approvedInstall(t), input = { revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install" };
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input, { fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_package01" }, { faults: { beforeReceipt: async () => { throw new Error("synthetic interruption"); } } }));
  const journal = join(x.p.stateRoot, "runs/run_package01/journal.json"), reviewed = join(x.p.stateRoot, "runs/run_package01/reviewed/journal.json");
  await mkdir(join(x.p.stateRoot, "runs/run_package01/reviewed"));
  await rename(journal, reviewed);
  const status = await cli(x.p, "local-status", ["--mode", "install", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(status.json.result.status, "ok");
  assert.deepEqual(status.json.result.reviewed, ["run_package01"]);
  assert.equal(status.json.result.actions[0].status, "conflict");
  assert.match(await readFile(join(x.dir, "SKILL.md"), "utf8"), /# Summary/);
});

test("interrupted update keeps the old receipt and reports modified target", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "changed-candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Changed\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const input = { revisionId: "rv_install02", contentDecisionId: "dc_content02", targetHome: x.home, agents: ["claude"], mode: "install" };
  const plan = await planPackageInstall(x.p.roots, selection, input);
  assert.equal((await cli(x.p, "local-approve", ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude", "--decision", "dc_update001", "--plan-fingerprint", plan.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.fingerprint)])).code, 0);
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input, { fingerprint: plan.fingerprint, decisionId: "dc_update001", runId: "run_update001" }, { faults: { beforeReceipt: async () => { throw new Error("synthetic update interruption"); } } }), /synthetic update interruption/);
  const status = await cli(x.p, "local-status", ["--mode", "install", "--revision", "rv_install02", "--home", x.home, "--agent", "claude"]);
  assert.equal(status.json.result.status, "RECOVERY_REQUIRED");
  assert.equal(status.json.result.actions[0].status, "modified");
  assert.equal(JSON.parse(await readFile(join(x.dir, ".devctx-owned.json"), "utf8")).revision, "rv_install01");
});

test("interrupted removal keeps the receipt and reports modified target", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const input = { revisionId: "rv_install01", targetHome: x.home, agents: ["claude"], mode: "uninstall" };
  const plan = await planPackageInstall(x.p.roots, selection, input);
  assert.equal((await cli(x.p, "local-approve", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude", "--decision", "dc_remove001", "--plan-fingerprint", plan.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("uninstall", plan.fingerprint)])).code, 0);
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input, { fingerprint: plan.fingerprint, decisionId: "dc_remove001", runId: "run_remove001" }, { faults: { beforeReceipt: async () => { throw new Error("synthetic removal interruption"); } } }), /synthetic removal interruption/);
  const status = await cli(x.p, "local-status", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(status.json.result.status, "RECOVERY_REQUIRED");
  assert.equal(status.json.result.actions[0].status, "modified");
  assert.ok((await readdir(x.dir)).includes(".devctx-owned.json"));
});

test("status rejects a content decision for another revision", async (t) => {
  const x = await approvedInstall(t);
  const path = join(x.p.dataRoot, "personal/skill-workspaces/ws_install01/decisions/dc_content01.json");
  const decision = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...decision, revision: "rv_other001" }));
  const result = await cli(x.p, "local-status", ["--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", x.home, "--agent", "claude"]);
  assert.equal(result.json.error.code, "DEVCTX_STALE_VERSION");
});

test("malformed completed journal cannot bypass recovery gate", async (t) => {
  const x = await approvedInstall(t);
  const run = join(x.p.stateRoot, "runs/run_corrupt01");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "journal.json"), JSON.stringify({ schemaVersion: 1, kind: "skill-package-local", targetHome: x.home, intended: [{ skill: "summarize-note" }], completed: [{ skill: "other" }] }));
  await chmod(join(run, "journal.json"), 0o600);
  const retry = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package01"]);
  assert.equal(retry.json.error.code, "DEVCTX_RECOVERY_REQUIRED");
});

test("package installer refuses names reserved for bundled skills", async (t) => {
  const { p, draft } = await fixture(t, { name: "devctx-private" });
  assert.equal((await cli(p, "content-approve", ["--revision", "rv_install01", "--decision", "dc_content01", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const planned = await cli(p, "local-plan", ["--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", p.agentHomes[0], "--agent", "claude"]);
  assert.equal(planned.json.error.code, "DEVCTX_CONFLICT");
});

test("package installer rejects inherited object names as agents", async (t) => {
  const x = await approvedInstall(t);
  const planned = await cli(x.p, "local-plan", ["--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", x.home, "--agent", "toString"]);
  assert.equal(planned.json.error.code, "DEVCTX_INVALID_INPUT");
});

test("legacy incomplete installer journal conservatively blocks package apply", async (t) => {
  const x = await approvedInstall(t), run = join(x.p.stateRoot, "runs/run_legacy001");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "journal.json"), JSON.stringify({ planFingerprint: "sha256:" + "0".repeat(64), intended: [{ skill: "devctx-record" }], completed: [] }));
  await chmod(join(run, "journal.json"), 0o600);
  const applied = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package01"]);
  assert.equal(applied.json.error.code, "DEVCTX_RECOVERY_REQUIRED");
});

test("package installer refuses an unsafe agent-skill parent directory", async (t) => {
  const x = await approvedInstall(t);
  await mkdir(join(x.home, ".claude"), { mode: 0o755 });
  const plan = await cli(x.p, "local-plan", x.install);
  assert.equal(plan.json.error.code, "DEVCTX_PATH_UNSAFE");
});

test("an intervening intact owned revision invalidates an approved update plan", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const third = await addRevision(x, "rv_install03", "dc_content03", "Third revision");
  const middle = await addRevision(x, "rv_install02", "dc_content02", "Middle revision");
  const firstPlan = await cli(x.p, "local-plan", third);
  assert.equal(firstPlan.json.result.actions[0].status, "update");
  assert.equal((await cli(x.p, "local-approve", [...third, "--decision", "dc_third001", "--plan-fingerprint", firstPlan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", firstPlan.json.result.fingerprint)])).code, 0);
  const middlePlan = await cli(x.p, "local-plan", middle);
  assert.equal((await cli(x.p, "local-approve", [...middle, "--decision", "dc_middle01", "--plan-fingerprint", middlePlan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", middlePlan.json.result.fingerprint)])).code, 0);
  assert.equal((await cli(x.p, "local-apply", [...middle, "--decision", "dc_middle01", "--plan-fingerprint", middlePlan.json.result.fingerprint, "--run-id", "run_middle01"])).code, 0);
  const changed = await cli(x.p, "local-plan", third);
  assert.notEqual(changed.json.result.fingerprint, firstPlan.json.result.fingerprint);
  const stale = await cli(x.p, "local-apply", [...third, "--decision", "dc_third001", "--plan-fingerprint", firstPlan.json.result.fingerprint, "--run-id", "run_third001"]);
  assert.equal(stale.json.error.code, "DEVCTX_PLAN_MISMATCH");
});

test("invalid UTF-8 edit to an installed replacement character is preserved", async (t) => {
  const x = await approvedInstall(t, { title: "Replaced � character" }); await applyApproved(x);
  const path = join(x.dir, "SKILL.md"), original = await readFile(path);
  const needle = Buffer.from([0xef, 0xbf, 0xbd]), offset = original.indexOf(needle);
  assert.ok(offset >= 0);
  await writeFile(path, Buffer.concat([original.subarray(0, offset), Buffer.from([0xff]), original.subarray(offset + needle.length)]));
  const remove = await cli(x.p, "local-plan", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"]);
  assert.equal(remove.json.result.actions[0].status, "modified");
  assert.ok((await readFile(path)).includes(0xff));
});

test("update refuses turning an owned file into a directory", async (t) => {
  const x = await approvedInstall(t, { oldReference: true }); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "file-to-dir"); await mkdir(join(candidate, "references/old.md"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# File to directory\n");
  await writeFile(join(candidate, "references/old.md/child.md"), "New nested file.\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const update = ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", update);
  assert.equal(plan.json.result.actions[0].status, "conflict");
  assert.equal((await cli(x.p, "local-approve", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)])).json.error.code, "DEVCTX_CONFLICT");
  assert.match(await readFile(join(x.dir, "references/old.md"), "utf8"), /Old synthetic/);
});

test("update refuses turning an owned directory into a file", async (t) => {
  const x = await approvedInstall(t, { oldNestedReference: true }); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "dir-to-file"); await mkdir(join(candidate, "references"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Directory to file\n");
  await writeFile(join(candidate, "references/old.md"), "New flat file.\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const update = ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", update);
  assert.equal(plan.json.result.actions[0].status, "conflict");
  assert.equal((await cli(x.p, "local-approve", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)])).json.error.code, "DEVCTX_CONFLICT");
  assert.match(await readFile(join(x.dir, "references/old.md/child.md"), "utf8"), /Nested synthetic/);
});

test("tampered local decision keys and interaction reference are refused before consumption", async (t) => {
  const x = await approvedInstall(t);
  const path = join(x.p.dataRoot, "personal/skill-workspaces/ws_install01/decisions/dc_local001.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const changed of [{ ...original, unexpected: "field" }, { ...original, interactionRef: "not-a-user-reference" }]) {
    await writeFile(path, JSON.stringify(changed));
    const result = await cli(x.p, "local-apply", [...x.install, "--decision", "dc_local001", "--plan-fingerprint", x.plan.fingerprint, "--run-id", "run_package01"]);
    assert.equal(result.json.error.code, "DEVCTX_INTEGRITY");
  }
});

test("local plan requires an explicit mode", async (t) => {
  const x = await approvedInstall(t);
  const result = await cli(x.p, "local-plan", ["--revision", "rv_install01", "--content-decision", "dc_content01", "--home", x.home, "--agent", "claude"]);
  assert.equal(result.json.error.code, "DEVCTX_INVALID_INPUT");
});

test("declared pilot home disappearing is a typed refusal", async (t) => {
  const x = await approvedInstall(t);
  await rmdir(x.home);
  const result = await cli(x.p, "local-plan", x.install);
  assert.equal(result.json.error.code, "DEVCTX_GATE_REQUIRED");
});

test("revision changes after journal creation cannot change installed bytes", async (t) => {
  const x = await approvedInstall(t), input = { revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install" };
  const changeRevision = async () => {
    const base = join(x.p.dataRoot, "personal/skill-workspaces/ws_install01"), dir = join(base, "drafts/rv_install01"), manifestPath = join(dir, "manifest.json"), validationPath = join(base, "validations/rv_install01/v1.json");
    const altered = "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Altered after approval\n";
    await writeFile(join(dir, "summarize-note/SKILL.md"), altered);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.find((entry) => entry.path === "SKILL.md").sha256 = sha256(altered);
    const { packageDigest, ...body } = manifest;
    manifest.packageDigest = digest(body);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const validation = JSON.parse(await readFile(validationPath, "utf8"));
    validation.packageDigest = manifest.packageDigest;
    await writeFile(validationPath, JSON.stringify(validation));
  };
  await assert.rejects(applyPackageInstall(x.p.roots, selection, input, { fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_package01" }, { faults: { afterJournal: changeRevision } }), { code: "DEVCTX_STALE_VERSION" });
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(x.dir), false);
});

test("package plan refuses the real home and scoped audiences", async (t) => {
  const x = await approvedInstall(t), input = { revisionId: "rv_install01", contentDecisionId: "dc_content01", targetHome: x.home, agents: ["claude"], mode: "install" };
  await assert.rejects(planPackageInstall(x.p.roots, selection, { ...input, targetHome: homedir() }), { code: "DEVCTX_GATE_REQUIRED" });
  for (const scoped of [{ audience: "company", scope: "acme", workspace: "ws_install01" }, { audience: "project", scope: "acme", project: "acme.atlas", workspace: "ws_install01" }]) {
    await assert.rejects(planPackageInstall(x.p.roots, scoped, input), { code: "DEVCTX_GATE_REQUIRED" });
    const flags = ["--audience", scoped.audience, "--scope", scoped.scope, ...(scoped.project ? ["--project", scoped.project] : []), "--workspace", scoped.workspace];
    const approved = await runCli(["skill", "local-approve", "--pilot", x.p.path, ...flags, "--mode", "install", "--revision", "rv_install01", "--content-decision", "dc_content01", "--home", x.home, "--agent", "claude", "--decision", "dc_scoped01", "--plan-fingerprint", x.plan.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", x.plan.fingerprint)]);
    assert.equal(approved.json.error.code, "DEVCTX_GATE_REQUIRED");
  }
});

test("extra, symlinked and hardlinked installed entries are preserved", async (t) => {
  const x = await approvedInstall(t); await applyApproved(x);
  const status = async () => (await cli(x.p, "local-plan", ["--mode", "uninstall", "--revision", "rv_install01", "--home", x.home, "--agent", "claude"])).json.result.actions[0].status;
  const extra = join(x.dir, "extra.md"); await writeFile(extra, "foreign");
  assert.equal(await status(), "modified"); await unlink(extra);
  await symlink(join(x.dir, "SKILL.md"), extra);
  assert.equal(await status(), "modified"); await unlink(extra);
  await link(join(x.dir, "SKILL.md"), extra);
  assert.equal(await status(), "modified"); await unlink(extra);
  assert.equal(await status(), "remove");
});

test("v1 and another workspace ownership receipts are conflicts", async (t) => {
  const x = await approvedInstall(t), dir = x.dir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "SKILL.md"), "foreign", { mode: 0o600 });
  await writeFile(join(dir, ".devctx-owned.json"), JSON.stringify({ schemaVersion: 1, skill: "summarize-note", version: "0.0.0-local", files: { "SKILL.md": sha256("foreign") }, runId: "run_foreign01" }), { mode: 0o600 });
  assert.equal((await cli(x.p, "local-plan", x.install)).json.result.actions[0].status, "conflict");
  await unlink(join(dir, "SKILL.md")); await unlink(join(dir, ".devctx-owned.json")); await rmdir(dir);
  await applyApproved(x);
  const receiptPath = join(dir, ".devctx-owned.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(receiptPath, JSON.stringify({ ...receipt, workspace: "ws_foreign01" }));
  assert.equal((await cli(x.p, "local-plan", x.install)).json.result.actions[0].status, "conflict");
});

test("case-only owned file rename is refused before approval and consumption", async (t) => {
  const x = await approvedInstall(t, { oldReference: true, oldReferenceName: "Old.md" }); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "case-rename"); await mkdir(join(candidate, "references"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Two\n");
  await writeFile(join(candidate, "references/old.md"), "New synthetic reference.\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const update = ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", update);
  assert.equal(plan.json.result.actions[0].status, "conflict");
  assert.equal((await cli(x.p, "local-approve", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)])).json.error.code, "DEVCTX_CONFLICT");
  await assert.rejects(stat(join(x.p.stateRoot, "skill-installs/consumed/ws_install01/dc_update001.json")), { code: "ENOENT" });
});

test("case-folded file-to-directory update is refused before approval", async (t) => {
  const x = await approvedInstall(t, { oldReference: true, oldReferenceName: "Notes.md" }); await applyApproved(x);
  const candidate = join(x.p.inputsRoot, "case-prefix"); await mkdir(join(candidate, "references/notes.md"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a synthetic note.\n---\n# Two\n");
  await writeFile(join(candidate, "references/notes.md/child.md"), "New nested reference.\n");
  const draft = await createDraft(x.p.roots, selection, { requirementsId: "rq_install01", designId: "ds_install01", decisionId: "dc_design01", revisionId: "rv_install02", candidate });
  await validateDraft(x.p.roots, selection, "rv_install02");
  assert.equal((await cli(x.p, "content-approve", ["--revision", "rv_install02", "--decision", "dc_content02", "--interaction-ref", "user:synthetic", "--response", `Approved content ${draft.packageDigest} as personal generic non-confidential`])).code, 0);
  const update = ["--mode", "install", "--revision", "rv_install02", "--content-decision", "dc_content02", "--home", x.home, "--agent", "claude"];
  const plan = await cli(x.p, "local-plan", update);
  assert.equal(plan.json.result.actions[0].status, "conflict");
  assert.equal((await cli(x.p, "local-approve", [...update, "--decision", "dc_update001", "--plan-fingerprint", plan.json.result.fingerprint, "--interaction-ref", "user:synthetic", "--response", response("install", plan.json.result.fingerprint)])).json.error.code, "DEVCTX_CONFLICT");
  await assert.rejects(stat(join(x.p.stateRoot, "skill-installs/consumed/ws_install01/dc_update001.json")), { code: "ENOENT" });
});
