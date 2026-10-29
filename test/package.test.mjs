import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { makeRepo, sandbox } from "./helpers.mjs";
import { RUNTIME_ENTRIES, scanRuntime, listRuntimeFiles } from "../src/kit/runtime-files.mjs";
const repoRoot = join(import.meta.dirname, "..");
const checkPkg = (args) => spawnSync(process.execPath, [join(import.meta.dirname, "../scripts/check-package.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
async function pkgFixture(t, files) {
  const dir = await makeRepo(join(await sandbox(t), "pkg"), files);
  const allow = join(dir, "..", "allow.json");
  await writeFile(allow, JSON.stringify(Object.keys(files).sort()));
  return { dir, allow };
}
test("package audit fails on a planted secret, home path, private email or denylist term, without echoing it", async (t) => {
  const fixtureValue = ["api", "_key"].join("") + " = " + "abcdef" + "123456";
  const cases = { "a.md": fixtureValue, "b.md": "/" + ["Users", "someone", "x"].join("/"), "c.md": ["dev", "realcorp.test"].join("@"), "d.md": "Project " + ["Glo", "bex"].join("") };
  for (const [name, text] of Object.entries(cases)) {
    const f = await pkgFixture(t, { [name]: text, "ok.md": "fine\n" });
    const deny = join(f.dir, "..", "deny.txt"); await writeFile(deny, ["glo", "bex"].join("") + "\n");
    const r = checkPkg(["--root", f.dir, "--allowlist", f.allow, "--denylist", deny, "--no-pack"]);
    assert.equal(r.status, 1, name);
    assert.ok(!r.stdout.includes("abcdef123456") && !r.stdout.includes("someone") && !r.stdout.includes("realcorp"), name);
    assert.equal(JSON.parse(r.stdout).pack, "not-run");
  }
  const extra = await pkgFixture(t, { "ok.md": "fine\n" });
  await writeFile(join(extra.dir, "stray.md"), "untracked but not ignored\n");
  assert.equal(checkPkg(["--root", extra.dir, "--allowlist", extra.allow, "--no-pack"]).status, 1);
});
test("package audit passes on the actual candidate set, including these tests and their fixtures", () => {
  const r = checkPkg(["--root", join(import.meta.dirname, "..")]);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, JSON.stringify(out.findings));
  assert.equal(out.pack, "run");
  assert.ok(out.files.includes("test/package.test.mjs"));
});

test("package audit refuses generated handoff packets even when allowlisted", async (t) => {
  const fixture = await pkgFixture(t, { "packet.handoff.md": "PRIVATE-PACKET-CANARY\n", "package.json": JSON.stringify({ name: "synthetic-package", version: "0.0.0", private: true }) });
  for (const suffix of [["--no-pack"], []]) {
    const result = checkPkg(["--root", fixture.dir, "--allowlist", fixture.allow, ...suffix]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.findings.some((item) => item.type === "generated-handoff-packet"));
    if (!suffix.length) assert.ok(parsed.findings.some((item) => item.type === "generated-handoff-packet-in-pack"));
    assert.ok(!result.stdout.includes("PRIVATE-PACKET-CANARY"));
  }
});
test("package audit flags tracked private state at the root, under a private root or under a scope", async (t) => {
  for (const name of ["profile/current.json", "data/digests/x.md", "data/scopes/alpha/drafts/x.md", "inputs/skill-templates/x/SKILL.md", "state/stack/approval.json", "config/profile/v1.json"]) {
    const f = await pkgFixture(t, { [name]: "{}\n", "ok.md": "fine\n" });
    const r = checkPkg(["--root", f.dir, "--allowlist", f.allow, "--no-pack"]);
    assert.equal(r.status, 1, name);
    assert.deepEqual(JSON.parse(r.stdout).findings, [{ file: name, type: "private-state" }], name);
  }
});
test("package audit does not flag kit source, schemas or skill templates as private state", async (t) => {
  const f = await pkgFixture(t, { "src/profile/store.mjs": "export {};\n", "src/stack/check.mjs": "export {};\n", "src/drafts/save.mjs": "export {};\n", "schemas/profile.schema.json": "{}\n",
    "templates/skills/stack-watch/candidate/SKILL.md": "# Fixture\n", "test/fixtures/stack/rss.xml": "<rss/>\n", "test/fixtures/skill-templates/fixture-notes/template.json": "{}\n" });
  const r = checkPkg(["--root", f.dir, "--allowlist", f.allow, "--no-pack"]);
  assert.equal(r.status, 0, r.stdout);
});

test("runtime set is the files allowlist plus package.json, sorted, and flags links", async (t) => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.files, [...RUNTIME_ENTRIES]);
  const files = listRuntimeFiles(repoRoot);
  assert.deepEqual(files, [...files].sort());
  for (const file of ["package.json", "bin/devtwin.mjs", "src/cli.mjs", "src/kit/runtime-files.mjs", "src/demo/run.mjs", "LICENSE", "NOTICE", "README.md"]) assert.ok(files.includes(file), file);
  assert.ok(!files.some((f) => /^(?:test|site|docs|scripts)\//.test(f)));
  const dir = await sandbox(t);
  await mkdir(join(dir, "src/sub"), { recursive: true });
  await writeFile(join(dir, "package.json"), "{}\n"); await writeFile(join(dir, "src/b.mjs"), "\n"); await writeFile(join(dir, "src/sub/a.mjs"), "\n");
  await writeFile(join(dir, "src/.DS_Store"), "x"); await writeFile(join(dir, "stray.md"), "x");
  assert.deepEqual(listRuntimeFiles(dir), ["package.json", "src/b.mjs", "src/sub/a.mjs"]);
  await symlink(join(dir, "src/b.mjs"), join(dir, "src/link.mjs"));
  assert.deepEqual(scanRuntime(dir).refused, [{ path: "src/link.mjs", reason: "link" }]);
  assert.throws(() => listRuntimeFiles(dir), (e) => e.code === "DEVTWIN_PATH_UNSAFE");
});
test("package audit fails on pack-missing, pack-extra and a packed docs reference", async (t) => {
  const pkg = (files) => JSON.stringify({ name: "synthetic-package", version: "0.0.0", private: true, files });
  const f = await pkgFixture(t, { "package.json": pkg(["src/", "extra.md"]), "src/a.mjs": "export const see = \"see docs/GUIDE.md\";\n// docs/GUIDE.md in a comment line is for contributors\nexport const url = \"https://example.com/blob/main/docs/GUIDE.md\";\n",
    "src/b.md": "Read [the guide](../docs/GUIDE.md) and `docs/solutions`.\n", "bin/tool.mjs": "\n", "extra.md": "x\n", "docs/GUIDE.md": "# Guide\n" });
  const r = checkPkg(["--root", f.dir, "--allowlist", f.allow]);
  assert.equal(r.status, 1);
  const findings = JSON.parse(r.stdout).findings;
  assert.ok(findings.some((x) => x.file === "package.json" && x.type === "files-mismatch"));
  assert.ok(findings.some((x) => x.file === "bin/tool.mjs" && x.type === "pack-missing"));
  assert.ok(findings.some((x) => x.file === "extra.md" && x.type === "pack-extra"));
  assert.deepEqual(findings.filter((x) => x.type === "pack-docs-ref"), [{ file: "src/a.mjs", type: "pack-docs-ref", ref: "docs/GUIDE.md" }, { file: "src/b.md", type: "pack-docs-ref", ref: "docs/GUIDE.md" }]);
});
test("the pack holds exactly the runtime set, with no test, site, docs or scripts entry", () => {
  const out = JSON.parse(checkPkg(["--root", repoRoot]).stdout);
  assert.equal(out.pack, "run");
  assert.deepEqual(out.packed, listRuntimeFiles(repoRoot));
  for (const prefix of ["test/", "site/", "docs/", "scripts/"]) assert.ok(!out.packed.some((f) => f.startsWith(prefix)), prefix);
  assert.deepEqual(out.findings.filter((x) => x.type.startsWith("pack-")), []);
});
