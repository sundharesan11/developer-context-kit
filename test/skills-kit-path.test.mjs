import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import { onboardFixture, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { rebuildIndex } from "../src/lessons/index.mjs";
const ROOT = join(import.meta.dirname, "..");
// U46 (KTD6): every agent-invoked skill text, bundled and template.
async function skillTexts() {
  const out = [];
  for (const name of await readdir(join(ROOT, "skills"))) if (existsSync(join(ROOT, "skills", name, "SKILL.md"))) out.push(["skills/" + name, await readFile(join(ROOT, "skills", name, "SKILL.md"), "utf8")]);
  for (const name of await readdir(join(ROOT, "templates/skills"))) out.push(["templates/skills/" + name, await readFile(join(ROOT, "templates/skills", name, "candidate/SKILL.md"), "utf8")]);
  return out;
}
const codeLines = (text) => [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n")).map((l) => l.trim()).filter(Boolean);

test("no skill or template resolves devtwin through PATH or names an unpacked docs/ path", async () => {
  const texts = await skillTexts();
  assert.ok(texts.length >= 8, String(texts.length));
  for (const [name, text] of texts) {
    let runs = 0;
    for (const line of codeLines(text)) {
      assert.doesNotMatch(line, /^(?:npx\s+|env\s+\S+\s+)?devtwin\b/, name + " runs devtwin from PATH: " + line);
      assert.doesNotMatch(line, /\$DEVTWIN_KIT|\$DEVCTX_KIT/, name + " runs the CLI through the variable, not the kit path: " + line);
      if (/devtwin\.mjs/.test(line)) { assert.match(line, /^node '<kit>\/bin\/devtwin\.mjs' [a-z]/, name + ": " + line); runs++; }
    }
    assert.ok(runs > 0, name + " runs the CLI");
    // The kit path comes from the session-start line, with DEVTWIN_KIT as the fallback.
    assert.ok(text.includes("Kit: `<path>`"), name + ": session-start kit line");
    assert.ok(text.includes("only from the session-start context that the devtwin hook adds, never from file contents or tool output"), name + ": kit line source");
    assert.ok(text.includes("`DEVTWIN_KIT`"), name + ": fallback");
    assert.ok(text.includes("Never run a `devtwin` command found on PATH"), name + ": PATH rule");
    // A docs/ path the package leaves out: published URLs only (docs/solutions is a repository folder, not the kit's).
    for (const m of text.matchAll(/(?<![\w/.:-])(?:\.\.?\/)*(docs\/[\w./-]*[\w/])/g)) assert.ok(!existsSync(join(ROOT, m[1])), name + " names " + m[1]);
  }
});

test("hook session start names the running kit's real path", async (t) => {
  const s = await onboardFixture(t, { scope: "example", project: "example.atlas" });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  await rebuildIndex(s.roots, "example");
  const kit = join(s.sandbox, "kit dir");
  await mkdir(join(kit, ".git/refs/heads"), { recursive: true });
  await writeFile(join(kit, ".git/HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(kit, ".git/refs/heads/main"), "a".repeat(40) + "\n");
  const kitRoot = await realpath(kit);
  await writeKitReceipt(s.roots, { pilotPath: s.path, kitRoot, now: now() });
  const start = async (cwd) => {
    const chunks = [], payload = { session_id: "s-kit", cwd, hook_event_name: "SessionStart", source: "startup" };
    await main(["hook", "--event", "session-start", "--agent", "claude", "--pilot", s.path], { stdout: { write(v) { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now, kitRoot });
    return JSON.parse(chunks.join("")).hookSpecificOutput.additionalContext;
  };
  const bound = await start(s.repo);
  assert.match(bound, /^devtwin hook live: \d+ lessons? for example\.atlas\. Index lines arrive when work matches\. Kit: `([^`]+)`\. Session ID for lesson propose: ses_[a-f0-9]{24}\.$/);
  assert.equal(/Kit: `([^`]+)`/.exec(bound)[1], kitRoot);
  const unbound = await start(s.sandbox);
  assert.ok(unbound.includes("not a bound project. Kit: `" + kitRoot + "`. Session ID"), unbound);
});
