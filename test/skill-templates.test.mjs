import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { makePilot, initPilot, runCli, sandbox } from "./helpers.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { listTemplates } from "../src/skill-builder/templates.mjs";

const templateRoot = join(import.meta.dirname, "fixtures", "skill-templates");
const personal = ["--audience", "personal", "--workspace", "ws_fixture01"];
const company = ["--audience", "company", "--scope", "acme", "--workspace", "ws_fixture01"];
const cli = (args, extra = {}) => runCli(args, { templateRoot, ...extra });
const skill = (p, route, args) => cli(["skill", route, "--pilot", p.path, ...args]);
const notes = (values = ["skill-name=summarize-notes"]) => ["--template", "fixture-notes", ...values.flatMap((v) => ["--set", v])];
async function personalPilot(t) { const p = await makePilot(t); assert.equal((await skill(p, "workspace-create", personal)).code, 0); return p; }
async function tree(dir) {
  const out = [];
  async function visit(path, rel) { for (const e of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const r = rel ? rel + "/" + e.name : e.name; out.push(r); if (e.isDirectory()) await visit(join(path, e.name), r); } }
  await visit(dir, ""); return out;
}
async function writeRender(dir, result) {
  for (const file of result.files) { await mkdir(join(dir, ...file.path.split("/").slice(0, -1)), { recursive: true }); await writeFile(join(dir, file.path), file.content); }
}
async function seeded(t, p, dir = join(p.inputsRoot, "seeded")) {
  const seed = await skill(p, "template-seed", [...personal, ...notes()]);
  assert.equal(seed.code, 0, JSON.stringify(seed.json));
  await writeRender(dir, seed.json.result);
  return { dir, seed: seed.json.result, verify: (extra = []) => skill(p, "template-verify", [...personal, ...notes(), "--dir", dir, "--render-digest", seed.json.result.renderDigest, ...extra]) };
}
async function mutated(t, change) {
  const root = join(await sandbox(t), "templates");
  await cp(join(templateRoot, "fixture-notes"), join(root, "fixture-notes"), { recursive: true });
  await change(join(root, "fixture-notes"));
  return root;
}

test("skill template-list is root-free and returns fixture templates with their placeholders", async () => {
  const listed = await cli(["skill", "template-list"]);
  assert.equal(listed.code, 0, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.result.templates.map((x) => x.name), ["fixture-channel", "fixture-notes"]);
  const fixture = listed.json.result.templates[1];
  assert.equal(fixture.description, "Synthetic template that summarizes notes on a chosen topic.");
  assert.deepEqual(fixture.placeholders.map((x) => [x.key, x.kind, x.required, x.default]), [["skill-name", "generic", true, null], ["topic", "generic", false, "daily notes"]]);
});

test("skill template-list reads templates/skills from the kit and is empty when that folder is absent or empty", async (t) => {
  const kit = await sandbox(t);
  const absent = await runCli(["skill", "template-list"], { kitRoot: kit });
  assert.equal(absent.code, 0, JSON.stringify(absent.json));
  assert.deepEqual(absent.json.result.templates, []);
  await mkdir(join(kit, "templates", "skills"), { recursive: true });
  assert.deepEqual((await runCli(["skill", "template-list"], { kitRoot: kit })).json.result.templates, []);
  await cp(join(templateRoot, "fixture-notes"), join(kit, "templates", "skills", "fixture-notes"), { recursive: true });
  assert.deepEqual((await runCli(["skill", "template-list"], { kitRoot: kit })).json.result.templates.map((x) => x.name), ["fixture-notes"]);
});

test("skill template-seed returns filled files, per-file hashes and a render digest and writes nothing", async (t) => {
  const p = await personalPilot(t);
  const before = await tree(p.pilot.pilotRoot);
  const seed = await skill(p, "template-seed", [...personal, ...notes(["skill-name=summarize-notes", "topic=meeting notes"])]);
  assert.equal(seed.code, 0, JSON.stringify(seed.json));
  const result = seed.json.result;
  assert.deepEqual(result.layout, ["candidate/SKILL.md", "design.json", "requirements.json"]);
  assert.deepEqual(result.files.map((f) => f.path), result.layout);
  assert.match(result.renderDigest, /^sha256:[a-f0-9]{64}$/);
  for (const file of result.files) { assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/); assert.ok(!file.content.includes("{{dck:"), file.path); }
  assert.equal(JSON.parse(result.files[1].content).name, "summarize-notes");
  assert.equal(JSON.parse(result.files[2].content).goal, "Summarize meeting notes into a dated report");
  assert.ok(result.files[0].content.includes("Read the meeting notes"));
  assert.deepEqual(await tree(p.pilot.pilotRoot), before);
  const defaulted = await skill(p, "template-seed", [...personal, ...notes()]);
  assert.equal(JSON.parse(defaulted.json.result.files[2].content).goal, "Summarize daily notes into a dated report");
  assert.notEqual(defaulted.json.result.renderDigest, result.renderDigest);
});

test("template seeding feeds the unchanged skill-builder steps from workspace-create to draft-validate", async (t) => {
  const p = await makePilot(t);
  assert.equal((await skill(p, "workspace-create", personal)).code, 0);
  const { dir, verify } = await seeded(t, p);
  const verified = await verify();
  assert.equal(verified.code, 0, JSON.stringify(verified.json));
  assert.equal(verified.json.result.verified, true);
  const rq = await skill(p, "requirements-record", [...personal, "--requirements", "rq_fixture01", "--input", join(dir, "requirements.json")]);
  assert.equal(rq.code, 0, JSON.stringify(rq.json));
  const ds = await skill(p, "design-record", [...personal, "--requirements", "rq_fixture01", "--design", "ds_fixture01", "--input", join(dir, "design.json")]);
  assert.equal(ds.code, 0, JSON.stringify(ds.json));
  const ok = await skill(p, "design-approve", [...personal, "--design", "ds_fixture01", "--decision", "dc_fixture01", "--interaction-ref", "user:fixture-1", "--response", "Approved " + ds.json.result.digest]);
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  const draft = await skill(p, "draft-create", [...personal, "--requirements", "rq_fixture01", "--design", "ds_fixture01", "--decision", "dc_fixture01", "--revision", "rv_fixture01", "--candidate", join(dir, "candidate")]);
  assert.equal(draft.code, 0, JSON.stringify(draft.json));
  const validated = await skill(p, "draft-validate", [...personal, "--revision", "rv_fixture01"]);
  assert.equal(validated.code, 0, JSON.stringify(validated.json));
  assert.equal(validated.json.result.valid, true, JSON.stringify(validated.json));
});

test("skill template-seed for a workspace that does not exist fails with NOT_FOUND", async (t) => {
  const p = await makePilot(t);
  const seed = await skill(p, "template-seed", [...personal, ...notes()]);
  assert.equal(seed.json.error.code, "DEVCTX_NOT_FOUND");
});

test("skill template-verify fails with INTEGRITY naming an edited, removed or extra file", async (t) => {
  const p = await personalPilot(t);
  const { dir, verify } = await seeded(t, p);
  await writeFile(join(dir, "design.json"), (await readFile(join(dir, "design.json"), "utf8")) + " ");
  let result = await verify();
  assert.equal(result.json.error.code, "DEVCTX_INTEGRITY"); assert.equal(result.json.error.details.path, "design.json");
  const second = await seeded(t, p, join(p.inputsRoot, "second"));
  await rm(join(second.dir, "candidate", "SKILL.md"));
  result = await second.verify();
  assert.equal(result.json.error.code, "DEVCTX_INTEGRITY"); assert.equal(result.json.error.details.path, "candidate/SKILL.md");
  const third = await seeded(t, p, join(p.inputsRoot, "third"));
  await writeFile(join(third.dir, "notes.md"), "extra\n");
  result = await third.verify();
  assert.equal(result.json.error.code, "DEVCTX_INTEGRITY"); assert.equal(result.json.error.details.path, "notes.md");
  const fourth = await seeded(t, p, join(p.inputsRoot, "fourth"));
  result = await skill(p, "template-verify", [...personal, ...notes(), "--dir", fourth.dir, "--render-digest", "sha256:" + "0".repeat(64)]);
  assert.equal(result.json.error.code, "DEVCTX_PLAN_MISMATCH");
});

test("skill template-verify refuses a directory outside inputsRoot with GATE_REQUIRED and a symlinked file with PATH_UNSAFE", async (t) => {
  const p = await personalPilot(t);
  const outside = join(p.sandbox, "outside");
  const { seed } = await seeded(t, p, outside);
  const gated = await skill(p, "template-verify", [...personal, ...notes(), "--dir", outside, "--render-digest", seed.renderDigest]);
  assert.equal(gated.json.error.code, "DEVCTX_GATE_REQUIRED");
  const { dir, verify } = await seeded(t, p);
  await rm(join(dir, "design.json")); await symlink(join(outside, "design.json"), join(dir, "design.json"));
  assert.equal((await verify()).json.error.code, "DEVCTX_PATH_UNSAFE");
  const linked = await seeded(t, p, join(p.inputsRoot, "linked"));
  await link(join(linked.dir, "design.json"), join(p.inputsRoot, "hard-link.json"));
  assert.equal((await linked.verify()).json.error.code, "DEVCTX_PATH_UNSAFE");
});

test("a scope placeholder renders only for a company workspace in an existing scope with a value inside that scope", async (t) => {
  const p = await initPilot(t);
  const channel = (value) => ["--template", "fixture-channel", "--set", "skill-name=team-update", "--set", "channel=" + value];
  assert.equal((await skill(p, "workspace-create", personal)).code, 0);
  const asPersonal = await skill(p, "template-seed", [...personal, ...channel("acme")]);
  assert.equal(asPersonal.json.error.code, "DEVCTX_INVALID_INPUT");
  const unknown = await skill(p, "template-seed", [...company, ...channel("acme")]);
  assert.equal(unknown.json.error.code, "DEVCTX_SCOPE_UNKNOWN");
  await applyScopeAdd(p.roots, { scope: "acme" });
  assert.equal((await skill(p, "workspace-create", company)).code, 0);
  for (const value of ["acme", "acme.platform-team"]) assert.equal((await skill(p, "template-seed", [...company, ...channel(value)])).code, 0, value);
  for (const value of ["beacon", "beacon.platform", "acmex", "acme."]) {
    const outside = await skill(p, "template-seed", [...company, ...channel(value)]);
    assert.equal(outside.json.error.code, "DEVCTX_INVALID_INPUT", value); assert.equal(outside.json.error.details.key, "channel");
  }
});

test("skill template-seed refuses a missing required placeholder with INVALID_INPUT naming the key", async (t) => {
  const p = await personalPilot(t);
  const missing = await skill(p, "template-seed", [...personal, ...notes(["topic=notes"])]);
  assert.equal(missing.json.error.code, "DEVCTX_INVALID_INPUT"); assert.equal(missing.json.error.details.key, "skill-name");
  const unknown = await skill(p, "template-seed", [...personal, ...notes(["skill-name=summarize-notes", "colour=blue"])]);
  assert.equal(unknown.json.error.code, "DEVCTX_INVALID_INPUT"); assert.equal(unknown.json.error.details.key, "colour");
  const twice = await skill(p, "template-seed", [...personal, ...notes(["skill-name=summarize-notes", "skill-name=other-notes"])]);
  assert.equal(twice.json.error.code, "DEVCTX_INVALID_INPUT");
});

test("skill template-seed refuses reserved, bundled and invalid skill names", async (t) => {
  const p = await personalPilot(t);
  for (const name of ["devctx-notes", "devctx-onboard", "devctx-create-skill", "Bad_Name", "-lead", "a".repeat(65)]) {
    const result = await skill(p, "template-seed", [...personal, ...notes(["skill-name=" + name])]);
    assert.equal(result.json.error.code, "DEVCTX_INVALID_INPUT", name);
  }
});

test("skill template-seed refuses a value with a newline, the placeholder marker or a token-like string", async (t) => {
  const p = await personalPilot(t);
  const token = "gh" + "p_" + "A".repeat(30);
  for (const [value, code] of [["two\nlines", "DEVCTX_INVALID_INPUT"], ["x {{dck:topic}}", "DEVCTX_INVALID_INPUT"], [token, "DEVCTX_SENSITIVE_CONTENT"]]) {
    const result = await skill(p, "template-seed", [...personal, ...notes(["skill-name=summarize-notes", "topic=" + value])]);
    assert.equal(result.json.error.code, code, value);
  }
});

test("template validation refuses an undeclared placeholder, an unused declared key, an extra file or a symlink", async (t) => {
  const cases = {
    undeclared: (dir) => writeFile(join(dir, "candidate", "SKILL.md"), "---\nname: {{dck:skill-name}}\ndescription: Notes.\n---\n# {{dck:colour}} {{dck:topic}}\n"),
    unused: async (dir) => { const meta = JSON.parse(await readFile(join(dir, "template.json"), "utf8")); meta.placeholders.push({ key: "spare", description: "Unused.", kind: "generic", required: false, default: "" }); await writeFile(join(dir, "template.json"), JSON.stringify(meta)); },
    extra: (dir) => writeFile(join(dir, "README.md"), "extra\n"),
    badKey: async (dir) => { const meta = JSON.parse(await readFile(join(dir, "template.json"), "utf8")); meta.placeholders[1].kind = "secret"; await writeFile(join(dir, "template.json"), JSON.stringify(meta)); },
    extraKey: async (dir) => { const meta = JSON.parse(await readFile(join(dir, "template.json"), "utf8")); meta.version = 2; await writeFile(join(dir, "template.json"), JSON.stringify(meta)); }
  };
  for (const [label, change] of Object.entries(cases)) {
    const root = await mutated(t, change);
    assert.throws(() => listTemplates(root), { code: "DEVCTX_INVALID_INPUT" }, label);
    const listed = await runCli(["skill", "template-list"], { templateRoot: root });
    assert.equal(listed.json.error.code, "DEVCTX_INVALID_INPUT", label);
  }
  const linked = await mutated(t, async (dir) => { await rm(join(dir, "design.json")); await symlink(join(templateRoot, "fixture-notes", "design.json"), join(dir, "design.json")); });
  assert.throws(() => listTemplates(linked), { code: "DEVCTX_PATH_UNSAFE" });
});

test("template routes are listed in help and take no apply option", async (t) => {
  const help = await runCli(["help"]);
  for (const route of ["skill template-list", "skill template-seed", "skill template-verify"]) assert.ok(help.json.result.commands.includes(route), route);
  const p = await personalPilot(t);
  assert.equal((await skill(p, "template-seed", [...personal, ...notes(), "--apply"])).code, 2);
  assert.equal((await skill(p, "template-seed", [...personal, "--template", "missing-template", "--set", "skill-name=x-y"])).json.error.code, "DEVCTX_NOT_FOUND");
});
