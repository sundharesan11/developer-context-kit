import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { initPilot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { checkMarkdown } from "../src/writing/ste.mjs";
import { extractHeadings } from "../src/templates/outputs.mjs";

const STARTERS = join(import.meta.dirname, "..", "templates", "outputs");
async function machine(t) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "alpha", hubs: [], policies: [], now });
  const cli = async (args) => {
    const chunks = [];
    const code = await main([...args, "--pilot", p.path], { now, home: p.fakeHome, env: {}, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => { const out = await cli(args); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code) => { const out = await cli(args); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, JSON.stringify(out.json.error)); return out.json.error; };
  const input = async (name, text) => { const path = join(p.inputsRoot, name); await writeFile(path, text); return path; };
  return { p, ok, fail, input };
}
const LIKED = "# Outage on the payments queue\n\n## What broke\n\nText.\n\n## Why it broke\n\n```\n# not a heading\n```\n\n## Fixes\n\n### Now\n\n### Later\n";

test("a saved template replaces the starter RCA for template show rca", async (t) => {
  const m = await machine(t);
  const starter = await m.ok(["template", "show", "--kind", "rca"]);
  assert.equal(starter.source, "starter");
  assert.match(starter.text, /^# Root-cause analysis/);
  const file = await m.input("liked-rca.md", LIKED);
  const plan = await m.ok(["template", "from", "--file", file, "--kind", "rca"]);
  assert.deepEqual(plan.headings, [{ level: 1, text: "<title>" }, { level: 2, text: "What broke" }, { level: 2, text: "Why it broke" }, { level: 2, text: "Fixes" }, { level: 3, text: "Now" }, { level: 3, text: "Later" }]);
  assert.equal(plan.replaces, "starter");
  assert.equal((await m.ok(["template", "show", "--kind", "rca"])).source, "starter", "the preview saves nothing");
  await m.ok(["template", "from", "--file", file, "--kind", "rca", "--apply", "--plan-fingerprint", plan.fingerprint]);
  const mine = await m.ok(["template", "show", "--kind", "rca"]);
  assert.equal(mine.source, "personal");
  assert.match(mine.text, /^# <title>\n\n## What broke\n/);
  assert.doesNotMatch(mine.text, /payments queue|Text\./, "only the structure is saved");
  assert.equal((await m.ok(["template", "show", "--kind", "rca", "--format", "html"])).source, "starter", "the HTML starter stays");
  const list = (await m.ok(["template", "list"])).templates;
  assert.deepEqual(list.find((x) => x.kind === "rca" && x.format === "md"), { kind: "rca", format: "md", source: "personal", replacesStarter: true });
  assert.ok(["decision", "report"].every((k) => list.some((x) => x.kind === k && x.source === "starter")));
});

test("a source file with a credential is refused, and the result says where", async (t) => {
  const m = await machine(t);
  const file = await m.input("leaky.md", "# Report\n\n## Setup\n\nexport API_" + "KEY=" + "sk-" + "ant-abcdefghijklmnopqrstuvwxyz\n");
  const err = await m.fail(["template", "from", "--file", file, "--kind", "report"], "DEVTWIN_SENSITIVE_CONTENT");
  assert.equal(err.details.line, 5);
});

test("a file with no headings is refused as no structure, and a heading that names a scope is refused", async (t) => {
  const m = await machine(t);
  const flat = await m.input("flat.md", "Just a paragraph.\nAnd another one.\n");
  assert.equal((await m.fail(["template", "from", "--file", flat, "--kind", "report"], "DEVTWIN_INVALID_INPUT")).details.reason, "no-structure");
  const titleOnly = await m.input("title-only.md", "# Just a title\n\nSome text.\n");
  assert.equal((await m.fail(["template", "from", "--file", titleOnly, "--kind", "report"], "DEVTWIN_INVALID_INPUT")).details.reason, "no-structure");
  const named = await m.input("named.html", "<h1>Title</h1>\n<h2>Notes for Alpha</h2>\n");
  const err = await m.fail(["template", "from", "--file", named, "--kind", "report"], "DEVTWIN_ISOLATION");
  assert.deepEqual([err.details.scopes, err.details.line], [["alpha"], 2]);
  await m.fail(["template", "from", "--file", join(m.p.inputsRoot, "..", "outside.md"), "--kind", "report"], "DEVTWIN_GATE_REQUIRED");
});

test("HTML headings are extracted in order without tags", () => {
  assert.deepEqual(extractHeadings("<h1 class=\"t\">A &amp; B</h1><p>x</p><h2>Why <em>it</em> broke</h2>", "html").map((h) => [h.level, h.text]), [[1, "A & B"], [2, "Why it broke"]]);
});

test("the starter templates pass the STE check", () => {
  for (const kind of ["rca", "report", "decision"]) {
    assert.deepEqual(checkMarkdown(readFileSync(join(STARTERS, kind + ".md"), "utf8")), [], kind + ".md");
    const html = readFileSync(join(STARTERS, kind + ".html"), "utf8");
    const text = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<h(\d)>/g, (m, n) => "#".repeat(Number(n)) + " ").replace(/<[^>]+>/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.deepEqual(checkMarkdown(text), [], kind + ".html");
    assert.deepEqual(extractHeadings(html, "html").map((h) => h.text), extractHeadings(readFileSync(join(STARTERS, kind + ".md"), "utf8"), "md").map((h) => h.text), kind + " formats match");
  }
});
