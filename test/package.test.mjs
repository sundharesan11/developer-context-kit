import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { makeRepo, sandbox } from "./helpers.mjs";
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
