import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { makePilot, initPilot, runCli } from "./helpers.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { createWorkspace } from "../src/skill-builder/workspace.mjs";
import { validatePackage } from "../src/skill-builder/validate.mjs";

const sel = ["--audience", "personal", "--workspace", "ws_fixture01"];
async function call(p, route, args = []) { return runCli(["skill", route, "--pilot", p.path, ...sel, ...args]); }
async function input(p, name, value) { const path = join(p.inputsRoot, name); await writeFile(path, JSON.stringify(value)); return path; }
const requirements = { goal: "Summarize a daily note", success: "Produces a dated summary", examples: ["Summarize today's note"], negativeExample: "Write a new note", inputs: ["note text"], permittedTools: [], forbiddenTools: ["network"], supportedAgents: ["codex"], output: "Markdown summary", failure: "Explain missing note", destination: "private", unknowns: [] };
const design = { name: "summarize-note", description: "Summarize a daily note into a dated Markdown report.", workflow: ["Read note", "Summarize"], outputs: ["Markdown summary"], dependencies: [], tests: ["fixture note"], tree: ["SKILL.md"], reuse: "No bundled skill covers this fixture." };
async function setup(p) {
  assert.equal((await call(p, "workspace-create")).code, 0);
  const rq = await input(p, "requirements.json", requirements);
  const recorded = await call(p, "requirements-record", ["--requirements", "rq_fixture01", "--input", rq]);
  assert.equal(recorded.code, 0, JSON.stringify(recorded.json));
  const ds = await input(p, "design.json", design);
  const made = await call(p, "design-record", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--input", ds]);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  return made.json.result.digest;
}

test("skill workspace create makes a private personal workspace inside the pilot", async (t) => {
  const p = await makePilot(t);
  const result = await runCli(["skill", "workspace-create", "--pilot", p.path, "--audience", "personal", "--workspace", "ws_fixture01"]);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.result.audience, "personal");
  assert.equal(result.json.result.workspace, "ws_fixture01");
});

test("draft creation rejects missing and mismatched explicit design approval", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  const candidate = join(p.inputsRoot, "candidate");
  await mkdir(candidate); await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  const draft = ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate];
  const missing = await call(p, "draft-create", draft);
  assert.equal(missing.code, 1);
  const wrong = await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", "approve sha256:wrong"]);
  assert.equal(wrong.code, 1);
  const accepted = await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", "Approve " + digest]);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.json));
  const created = await call(p, "draft-create", draft);
  assert.equal(created.code, 0, JSON.stringify(created.json));
  const validated = await call(p, "draft-validate", ["--revision", "rv_fixture01"]);
  assert.equal(validated.code, 0, JSON.stringify(validated.json));
  assert.equal(validated.json.result.valid, true);
  assert.equal((await call(p, "draft-create", draft)).code, 1);
  const shown = await call(p, "workspace-show");
  assert.equal(shown.code, 0);
  assert.ok(!JSON.stringify(shown.json).includes("Summarize a daily note"));
});

test("design approval is stale after named requirements change", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const path = join(p.dataRoot, "personal", "skill-workspaces", "ws_fixture01", "requirements", "rq_fixture01.json");
  await writeFile(path, JSON.stringify({ ...requirements, goal: "Changed" }));
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate); await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  const result = await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate]);
  assert.equal(result.code, 1);
});

test("intake rejects symlinked package files without running helpers", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  await symlink(join(p.inputsRoot, "design.json"), join(candidate, "SKILL.md"));
  const result = await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate]);
  assert.equal(result.code, 1);
  const show = await call(p, "workspace-show");
  assert.deepEqual(show.json.result.revisions, []);
});

test("direct mutation without a pilot fence cannot create a workspace", async (t) => {
  const p = await makePilot(t);
  await assert.rejects(createWorkspace({ dataRoot: p.dataRoot, stateRoot: p.stateRoot }, { audience: "personal", workspace: "ws_fixture01" }), { code: "DEVCTX_GATE_REQUIRED" });
});

test("company and project workspaces require registered membership and keep scope separate", async (t) => {
  const p = await initPilot(t);
  const company = ["--audience", "company", "--scope", "acme", "--workspace", "ws_fixture01"];
  const project = ["--audience", "project", "--scope", "acme", "--project", "acme.atlas", "--workspace", "ws_fixture01"];
  assert.equal((await runCli(["skill", "workspace-create", "--pilot", p.path, ...company])).code, 1);
  await applyScopeAdd(p.roots, { scope: "acme" });
  assert.equal((await runCli(["skill", "workspace-create", "--pilot", p.path, ...company])).code, 0);
  assert.equal((await runCli(["skill", "workspace-create", "--pilot", p.path, ...project])).code, 1);
  assert.equal((await runCli(["skill", "workspace-show", "--pilot", p.path, ...sel])).code, 1);
});

test("validation records missing references as failure and leaves revision private", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\nSee [guide](references/guide.md).\n");
  const draft = await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate]);
  assert.equal(draft.code, 0, JSON.stringify(draft.json));
  const checked = await call(p, "draft-validate", ["--revision", "rv_fixture01"]);
  assert.equal(checked.code, 0, JSON.stringify(checked.json));
  assert.equal(checked.json.result.valid, false);
  assert.deepEqual(checked.json.result.missing, ["references/guide.md"]);
});

test("tampering with a revision prevents validation and is visible without leaking bodies", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  assert.equal((await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate])).code, 0);
  const file = join(p.dataRoot, "personal", "skill-workspaces", "ws_fixture01", "drafts", "rv_fixture01", "package", "SKILL.md");
  await writeFile(file, "changed");
  assert.equal((await call(p, "draft-validate", ["--revision", "rv_fixture01"])).code, 1);
  const shown = await call(p, "workspace-show");
  assert.equal(shown.json.result.revisions[0].status, "tampered");
  assert.ok(!JSON.stringify(shown.json).includes("changed"));
});

test("unsupported frontmatter is a recorded validation failure", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: 'quoted unsupported'\n---\n# Summary\n");
  assert.equal((await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate])).code, 0);
  const checked = await call(p, "draft-validate", ["--revision", "rv_fixture01"]);
  assert.equal(checked.code, 0, JSON.stringify(checked.json));
  assert.equal(checked.json.result.valid, false);
  assert.ok(checked.json.result.findings.length > 0);
});

test("relative links in reference files resolve beside that file", () => {
  const files = { "SKILL.md": "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\nSee [guide](references/guide.md).\n", "references/guide.md": "See [detail](detail.md).\n" };
  assert.deepEqual(validatePackage(files, "summarize-note").missing, ["references/detail.md"]);
});

test("changed design content invalidates its approval before draft publication", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const designPath = join(p.dataRoot, "personal", "skill-workspaces", "ws_fixture01", "designs", "ds_fixture01.json");
  const changed = JSON.parse(await readFile(designPath, "utf8"));
  changed.description = "Changed design"; await writeFile(designPath, JSON.stringify(changed));
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate); await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  assert.equal((await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate])).code, 1);
});

test("hardlinked and oversized package sources are refused", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(candidate);
  const original = join(p.inputsRoot, "original.md"); await writeFile(original, "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  await link(original, join(candidate, "SKILL.md"));
  const args = ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate];
  assert.equal((await call(p, "draft-create", args)).code, 1);
  await unlink(join(candidate, "SKILL.md"));
  await writeFile(join(candidate, "SKILL.md"), "x".repeat(131073));
  assert.equal((await call(p, "draft-create", args)).code, 1);
});

test("helper files stay inert and validation marks them unverified", async (t) => {
  const p = await makePilot(t), digest = await setup(p);
  assert.equal((await call(p, "design-approve", ["--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", digest])).code, 0);
  const candidate = join(p.inputsRoot, "candidate"); await mkdir(join(candidate, "scripts"), { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: summarize-note\ndescription: Summarize a note.\n---\n# Summary\n");
  await writeFile(join(candidate, "scripts", "helper.sh"), "#!/bin/sh\nexit 42\n");
  assert.equal((await call(p, "draft-create", ["--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", candidate])).code, 0);
  const checked = await call(p, "draft-validate", ["--revision", "rv_fixture01"]);
  assert.equal(checked.code, 0);
  assert.equal(checked.json.result.helpers, "unverified");
});
