import test from "node:test";
import assert from "node:assert/strict";
import {writeFile, chmod} from "node:fs/promises";
import {join} from "node:path";
import {stageSourceFixture, treeSnapshot} from "./helpers.mjs";
import {sha256} from "../src/storage/canonical.mjs";
import {reviewSourcePackage, loadSourcePackage} from "../src/skill-sources/package.mjs";

test("source package review preserves upstream metadata legal bytes and unverified assessments", async (t) => {
  for (const skillRoot of ["", "skills/example-skill"]) {
    const x = await stageSourceFixture(t, {skillRoot});
    const before = await treeSnapshot(x.p.agentHomes[0]);
    const {review, files} = await loadSourcePackage(x.p.roots, x);
    assert.deepEqual(review.holds, []);
    assert.equal(review.acquisitionAssessment.pin, "caller-supplied-unverified");
    assert.equal(review.acquisitionAssessment.installation, "not-installed");
    assert.equal(review.files.find((f) => f.target === "LICENSE").sha256, sha256(x.contents.LICENSE));
    assert.deepEqual(files.LICENSE, Buffer.from(x.contents.LICENSE));
    assert.deepEqual(files["SKILL.md"], Buffer.from(x.contents[(skillRoot ? skillRoot + "/" : "") + "SKILL.md"]));
    assert.ok(review.disclosures.some((d) => d.code === "INERT_UNVERIFIED_HELPERS"));
    assert.equal(await treeSnapshot(x.p.agentHomes[0]), before);
  }
});

test("source package required files and review declarations fail closed", async (t) => {
  const x = await stageSourceFixture(t);
  for (const mutate of [
    (m) => m.files.pop(), (m) => m.requiredPaths.push("missing.md"),
    (m) => { m.licensePaths = []; }, (m) => m.noticePaths.push("missing-notice"),
    (m) => m.files.push({...m.files[0]}), (m) => { m.files[0].target = "../LICENSE"; },
    (m) => { m.files[0].target = ".devctx-owned.json"; }, (m) => { m.extra = true; },
    (m) => Object.setPrototypeOf(m, {inherited: true})
  ]) {
    const mapping = structuredClone(x.mapping); mutate(mapping);
    await assert.rejects(reviewSourcePackage(x.p.roots, {...x, mapping}));
  }
  const mapping = structuredClone(x.mapping);
  mapping.review.fileCompleteness = "unreviewed";
  mapping.dependencies = [{name: "synthetic-runtime", status: "missing"}];
  mapping.compatibility = {claude: "unreviewed", codex: "unsupported"};
  const review = await reviewSourcePackage(x.p.roots, {...x, mapping});
  assert.deepEqual(review.holds.map((h) => h.code).sort(), ["DEPENDENCY_MISSING", "NO_REVIEWED_HOST", "REVIEW_REQUIRED"]);
});

test("source package frontmatter rejects ambiguous semantic name forms", async (t) => {
  for (const line of ['"name": other', "'name': other", "name : other", "? name", "<<: *alias", "&anchor", "*alias", "!tag", "{name: other}", "[name, other]", "%YAML 1.2", "...", "name: other", "metadata: &anchor", "  <<: *alias", "\tname: other", "metadata: {author: example}", "metadata: [one, two]"]) {
    const x = await stageSourceFixture(t, {skillRoot: "", contents: {LICENSE: "License", "SKILL.md": `---\nname: example-skill\n${line}\n---\nBody\n`}});
    const review = await reviewSourcePackage(x.p.roots, x);
    assert.ok(review.holds.some((h) => h.code === "UNSUPPORTED_NAME"), JSON.stringify(line));
  }
});

test("source package reports unsupported bytes links limits and legal collisions", async (t) => {
  for (const [body, expected] of [
    ["---\nname: example-skill\n---\n[Missing](references/missing.md)", "MISSING_LINK"],
    ["---\nname: example-skill\n---\n[Reference][label]", "UNCHECKED_LINK"],
    [Buffer.from([255]), "BINARY_CONTENT"]
  ]) {
    const x = await stageSourceFixture(t, {skillRoot: "", contents: {LICENSE: "License", "SKILL.md": body}});
    assert.ok((await reviewSourcePackage(x.p.roots, x)).holds.some((h) => h.code === expected));
  }
  const x = await stageSourceFixture(t, {contents: {LICENSE: "Root", "skills/example-skill/LICENSE": "Nested", "skills/example-skill/SKILL.md": "---\nname: example-skill\n---\nBody"}});
  assert.ok((await reviewSourcePackage(x.p.roots, x)).holds.some((h) => h.code === "LEGAL_TARGET_COLLISION"));
});

test("source package reinspection refuses changed stages and executable storage", async (t) => {
  const x = await stageSourceFixture(t);
  await writeFile(join(x.stagePath, "files/LICENSE"), "Changed");
  await assert.rejects(reviewSourcePackage(x.p.roots, x), {code: "DEVCTX_INTEGRITY"});
  const y = await stageSourceFixture(t);
  await chmod(join(y.stagePath, "files/LICENSE"), 0o700);
  await assert.rejects(reviewSourcePackage(y.p.roots, y), {code: "DEVCTX_PATH_UNSAFE"});
});

test("source package holds oversized packages and unsupported paths without executing helpers", async (t) => {
  const x = await stageSourceFixture(t, {skillRoot: "", contents: {LICENSE: "License", "SKILL.md": "---\nname: example-skill\n---\nBody", "assets/one.txt": "a".repeat(100000), "assets/two.txt": "b".repeat(100000), "assets/three.txt": "c".repeat(100000)}});
  assert.ok((await reviewSourcePackage(x.p.roots, x)).holds.some((h) => h.code === "PACKAGE_LIMIT"));
  const y = await stageSourceFixture(t, {skillRoot: "", contents: {LICENSE: "License", "SKILL.md": "---\nname: example-skill\n---\nBody", "arbitrary.txt": "Unsupported root"}});
  assert.ok((await reviewSourcePackage(y.p.roots, y)).holds.some((h) => h.code === "UNSUPPORTED_LAYOUT"));
});
