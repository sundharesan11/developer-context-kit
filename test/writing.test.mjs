import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { applyAllowlist, checkMarkdown, passesWriting } from "../src/writing/ste.mjs";

const script = join(import.meta.dirname, "../scripts/check-writing.mjs");
const words = (n, word = "word") => Array.from({ length: n }, () => word).join(" ");
const rules = (text) => checkMarkdown(text).map((f) => f.rule);
function fixtureRoot(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "devtwin-writing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}
const runCheck = (root) => {
  const r = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8", env: { PATH: process.env.PATH } });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)) };
};

test("writing check passes a compliant paragraph", () => {
  const text = "# Title\n\nThe store keeps one record per file. Each record has an ID and a body.\n\n1. Run the check.\n2. Read the result.\n";
  assert.deepEqual(checkMarkdown(text), []);
  assert.equal(passesWriting(text), true);
});

test("writing check fails a 31-word sentence and reports the file and line", (t) => {
  const root = fixtureRoot(t, { "docs/GUIDE.md": "# Guide\n\nShort sentence.\n\n" + words(31) + ".\n" });
  const r = runCheck(root);
  assert.equal(r.status, 1);
  assert.equal(r.out.ok, false);
  assert.deepEqual(r.out.findings.map(({ file, rule, line }) => ({ file, rule, line })), [{ file: "docs/GUIDE.md", rule: "sentence-length", line: 5 }]);
  assert.match(r.out.findings[0].message, /31 words/);
});

test("writing check ignores text inside code fences", () => {
  const text = "Intro.\n\n```sh\n" + words(40) + " utilize will be installed\n```\n\n~~~\n" + words(40) + "\n~~~\n\n1. Run this:\n\n   ```sh\n   " + words(40) + "\n   ```\n";
  assert.deepEqual(checkMarkdown(text), []);
});

test("writing check ignores inline code, link URLs, frontmatter, comments, headings and tables", () => {
  assert.deepEqual(rules("Run `in order to simply utilize etc.` now.\n"), []);
  assert.deepEqual(rules("See [the guide](https://example.com/just/easily.html) for details.\n"), []);
  assert.deepEqual(rules("---\nname: just a test\ndescription: Use when you simply want to.\n---\n\nBody text.\n"), []);
  assert.deepEqual(rules("<!-- simply " + words(40) + " -->\nBody text.\n"), []);
  assert.deepEqual(rules("## " + words(40) + " simply\n"), []);
  assert.deepEqual(rules("| Column | Value |\n| --- | --- |\n| " + words(40) + " | x |\n"), []);
  // Table cells are lenient on length but still use the banned-word list.
  assert.deepEqual(rules("| Column | Value |\n| --- | --- |\n| simply run it | x |\n"), ["banned-word"]);
  // Inline code counts as one word, so a long command does not inflate the sentence.
  assert.deepEqual(rules(words(28) + " `" + words(20) + "`.\n"), []);
});

test("writing check flags a banned word with its line", () => {
  const findings = checkMarkdown("First line.\n\nYou can simply run the check.\n");
  assert.deepEqual(findings.map(({ rule, line }) => ({ rule, line })), [{ rule: "banned-word", line: 3 }]);
  assert.match(findings[0].message, /simply/);
  assert.deepEqual(rules("Use it in order to save time.\n"), ["banned-word"]);
  assert.deepEqual(rules("Adjust the input etc. before you run it.\n"), ["banned-word"]);
});

test("writing check allows 26 words outside procedures but not in a numbered step", () => {
  const sentence = words(25) + " end.";
  assert.deepEqual(rules(sentence + "\n"), []);
  assert.deepEqual(rules("- " + sentence + "\n"), []);
  assert.deepEqual(rules("1. " + sentence + "\n"), ["sentence-length"]);
  assert.deepEqual(rules("1. Short step.\n2. " + sentence + "\n"), ["sentence-length"]);
  assert.equal(checkMarkdown("1. Short step.\n2. " + sentence + "\n")[0].line, 2);
});

test("writing check flags passive voice and future tense only in procedures", () => {
  assert.deepEqual(rules("The record is written to the store.\n"), []);
  assert.deepEqual(rules("The command will print a summary.\n"), []);
  assert.deepEqual(rules("1. The record is written to the store.\n"), ["passive-voice"]);
  assert.deepEqual(rules("1. The command will print a summary.\n"), ["future-tense"]);
  assert.deepEqual(rules("1. Open the file and then save it.\n"), ["one-instruction"]);
  assert.deepEqual(rules("1. Open the file; then save it.\n"), ["one-instruction"]);
  assert.deepEqual(rules("1. If the check fails, then read the log.\n"), []);
});

test("writing allowlist suppresses a reviewed finding and reports a stale entry", (t) => {
  const long = words(31) + ".";
  const findings = checkMarkdown(long + "\n").map((f) => ({ file: "docs/A.md", ...f }));
  const entry = { file: "docs/A.md", rule: "sentence-length", excerpt: findings[0].excerpt, reason: "legal text" };
  const stale = { file: "docs/A.md", rule: "banned-word", excerpt: "gone", reason: "old" };
  const result = applyAllowlist(findings, [entry, stale]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.stale, [stale]);

  const root = fixtureRoot(t, {
    "README.md": long + "\n",
    "docs/plans/PLAN.md": long + "\n",
    "docs/research/NOTES.md": long + "\n",
    "skills/demo/SKILL.md": "---\nname: demo\n---\n\nRun the check.\n",
    "scripts/writing-allowlist.json": [{ ...entry, file: "README.md" }, { ...stale, file: "README.md" }],
  });
  const r = runCheck(root);
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.findings, [{ file: "README.md", rule: "stale-allowlist", excerpt: "gone", message: "allowlist entry no longer matches a finding" }]);
  writeFileSync(join(root, "scripts/writing-allowlist.json"), JSON.stringify([{ ...entry, file: "README.md" }]));
  assert.deepEqual(runCheck(root), { status: 0, out: { ok: true, files: 2, findings: [] } });
  writeFileSync(join(root, "scripts/writing-allowlist.json"), JSON.stringify([{ ...entry, file: "README.md", reason: "" }]));
  assert.ok(runCheck(root).out.findings.some((f) => f.rule === "allowlist-invalid"));
});

test("writing check runs in CI and as an npm script", () => {
  const root = join(import.meta.dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:writing"], "node scripts/check-writing.mjs");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.ok(ci.includes("run: npm run check:writing"));
  assert.ok(ci.indexOf("run: npm run check:package") < ci.indexOf("run: npm run check:writing"));
});
