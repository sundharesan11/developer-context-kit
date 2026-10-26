import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makePilot, onboardFixture, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex } from "../src/lessons/index.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { ownerAction, OWNER_ACTIONS } from "../src/hooks/owner-block.mjs";
import { draftFor } from "./helpers.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures/hooks");
async function payload(name, cwd, patch = {}) {
  const text = (await readFile(join(FIXTURES, name + ".json"), "utf8")).replaceAll("{{cwd}}", cwd);
  return { ...JSON.parse(text), ...patch };
}
async function hook(path, agent, body, event = "pre-tool") {
  const chunks = [];
  const code = await main(["hook", "--event", event, "--agent", agent, "--pilot", path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(body), now });
  const out = chunks.join("");
  return { code, out, json: out ? JSON.parse(out) : null };
}
const claudeBash = (cwd, command, session = "s-owner") => ({ session_id: session, cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: "toolu_01Example" });
const isDeny = (result) => result.json?.hookSpecificOutput?.permissionDecision === "deny";
const KIT = 'node "$DEVTWIN_KIT/bin/devtwin.mjs"';
const OWNER_COMMANDS = [
  "devtwin lesson accept --pilot /x/live.json --id rec_1 --apply",
  `${KIT} lesson accept --pilot '/x/live.json' --target hub --apply --plan-fingerprint 'sha256:00'`,
  `${KIT} lesson copy --pilot '/x/live.json' --id rec_1 --apply`,
  `${KIT} published delete --pilot '/x/live.json' --apply`,
  `${KIT} hub join --pilot '/x/live.json' --apply`,
  `${KIT} pref accept --pilot '/x/live.json'`,
  `${KIT} instructions apply --pilot '/x/live.json'`,
  `${KIT} live migrate --pilot '/x/live.json' --legacy '/x/old' --apply --plan-fingerprint 'sha256:00'`,
  `${KIT} record publish --pilot '/x/live.json' --apply`,
  `${KIT} agents install --pilot '/x/live.json' --agent claude --apply --plan-fingerprint 'sha256:00'`,
  `${KIT} agents uninstall --pilot '/x/live.json' --agent claude --hooks --apply`,
  `${KIT} live set-kit --pilot '/x/live.json' --commit abc --apply`,
  `${KIT} live add-repo --pilot '/x/live.json' --repo /r --apply`,
  `${KIT} live init --pilot '/x/live.json' --agent claude --apply`
];
const WRAPPED = [
  "script -q /dev/null devtwin lesson accept --id rec_1 --apply",
  "script -q /dev/null node \"$DEVTWIN_KIT/bin/devtwin.mjs\" lesson accept --id rec_1 --apply",
  "bash -c \"devtwin lesson accept --id rec_1 --apply\"",
  "sh -c 'node ~/.devtwin/kit/bin/devtwin.mjs lesson   accept --apply'",
  "zsh -c 'cd /tmp && devtwin \"lesson\" \"accept\" \"--apply\"'",
  "env X=1 node $DEVTWIN_KIT/bin/devtwin.mjs lesson accept --pilot /x/live.json --apply",
  "expect -c 'spawn devtwin lesson accept --apply; expect eof'",
  "unbuffer devtwin hub join --pilot /x --apply",
  "npx devtwin lesson accept --apply",
  "npx --yes ./bin/devtwin.mjs pref accept",
  "nohup devtwin published delete --apply &",
  "time sudo devtwin instructions apply",
  "echo accept | xargs devtwin lesson --apply",
  "A=accept; devtwin lesson $A --apply",
  "devtwin\\\n lesson accept --apply",
  "DEVTWIN LESSON ACCEPT --APPLY"
];
const ALLOWED = [
  `${KIT} lesson match --pilot '/x/live.json' --scope example --path db/a.sql`,
  `${KIT} lesson show --pilot '/x/live.json' --scope example --id rec_1`,
  `${KIT} live migrate --pilot '/x/live.json' --legacy '/x/old'`,
  `${KIT} agents install --pilot '/x/live.json' --agent claude`,
  // Previews of the four lesson and hub owner actions stay open to agents; only the apply is owner-only.
  `${KIT} lesson accept --pilot '/x/live.json' --id prop_1 --target hub`,
  `${KIT} lesson copy --pilot '/x/live.json' --id rec_1 --to-scope example`,
  `${KIT} published delete --pilot '/x/live.json' --scope example --id lsn_1`,
  `${KIT} hub join --pilot '/x/live.json' --scope example --remote ssh://git.example.com/hub.git`,
  `${KIT} record propose --pilot '/x/live.json' --scope example --apply`,
  `${KIT} profile apply --pilot '/x/live.json' --plan-fingerprint 'sha256:00'`,
  "git status",
  "rg -n 'lesson accept' docs/",
  "npm test"
];

test("owner block denies devtwin owner-only actions run directly from an agent shell", async (t) => {
  const p = await makePilot(t);
  for (const command of OWNER_COMMANDS) {
    const result = await hook(p.path, "claude", claudeBash(p.reposDir, command));
    assert.equal(result.code, 0, command);
    assert.ok(isDeny(result), command + " => " + result.out);
    assert.deepEqual(Object.keys(result.json), ["hookSpecificOutput"]);
    const out = result.json.hookSpecificOutput;
    assert.deepEqual(Object.keys(out).sort(), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    assert.equal(out.hookEventName, "PreToolUse");
    assert.match(out.permissionDecisionReason, /owner-only/);
    assert.match(out.permissionDecisionReason, /Ask your developer to run it themselves/);
    assert.doesNotMatch(result.out, /additionalContext/);
  }
  assert.deepEqual(OWNER_ACTIONS.map((a) => a.words.join(" ")).sort(), ["agents install", "agents uninstall", "hub join", "hub leave", "hub schedule", "instructions apply", "lesson accept", "lesson copy", "lesson notices", "live add-repo", "live init", "live migrate", "live set-kit", "live write-classes", "note consent", "note revoke", "pref accept", "published delete", "record publish"]);
});

test("owner block denies owner-only actions through terminal wrappers", async (t) => {
  const p = await makePilot(t);
  for (const command of WRAPPED) {
    assert.ok(ownerAction("claude", claudeBash(p.reposDir, command)), command);
    assert.ok(isDeny(await hook(p.path, "claude", claudeBash(p.reposDir, command))), command);
  }
});

test("owner block allows a live migrate preview and gives no decision for non-owner commands", async (t) => {
  const p = await makePilot(t);
  for (const command of ALLOWED) {
    assert.equal(ownerAction("claude", claudeBash(p.reposDir, command)), null, command);
    const result = await hook(p.path, "claude", claudeBash(p.reposDir, command));
    assert.deepEqual([result.code, result.out], [0, ""], command);
  }
  // Only shell tools are checked: an Edit whose text names an owner action is not a command.
  const edit = { ...claudeBash(p.reposDir, ""), tool_name: "Write", tool_input: { file_path: join(p.reposDir, "notes.md"), content: "devtwin lesson accept" } };
  assert.equal(ownerAction("claude", edit), null);
  assert.equal((await hook(p.path, "claude", edit)).out, "");
  // Only the pre-tool event blocks; a post-tool event never returns a decision.
  const post = { ...claudeBash(p.reposDir, OWNER_COMMANDS[0]), hook_event_name: "PostToolUse" };
  assert.equal((await hook(p.path, "claude", post, "post-tool")).out, "");
});

test("owner block denies a Codex shell payload and keeps lesson delivery decision-free", async (t) => {
  const s = await onboardFixture(t, { scope: "example", project: "example.atlas" });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const input = draftFor("example", "example.atlas", { requestId: "req_ownerlsn01", kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
  input.draft = { ...input.draft, title: "Migrations before seeds", class: "lesson", reach: "project", match: { paths: ["db/migrations/**"], packages: ["pg"], topics: ["migrations"] } };
  await addRecord(s.roots, input, { now });
  await rebuildIndex(s.roots, "example");
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  const bash = await payload("codex-post-tool-bash", s.repo, { hook_event_name: "PreToolUse" });
  for (const command of [`${KIT} lesson accept --pilot '${s.path}' --apply`, "bash -lc 'devtwin hub join --apply'"]) {
    for (const tool of [{ tool_name: "Bash", tool_input: { command } }, { tool_name: "shell", tool_input: { command: ["bash", "-lc", command] } }]) {
      const result = await hook(s.path, "codex", { ...bash, ...tool });
      assert.ok(isDeny(result), command + " " + tool.tool_name);
      assert.equal(result.json.hookSpecificOutput.hookEventName, "PreToolUse");
    }
  }
  // A shell read of a matching file still gets the lesson line, with no decision.
  const read = await hook(s.path, "codex", { ...bash, tool_input: { command: "sed -n '1,40p' db/migrations/001_init.sql" } });
  assert.match(read.json.hookSpecificOutput.additionalContext, /Migrations before seeds/);
  assert.doesNotMatch(read.out, /permissionDecision|"decision"/);
  // An owner command that also names a matching file gets only the deny, never lesson lines.
  const both = await hook(s.path, "claude", claudeBash(s.repo, `${KIT} lesson accept db/migrations/001_init.sql --apply`, "s-both"));
  assert.ok(isDeny(both));
  assert.doesNotMatch(both.out, /additionalContext|Migrations before seeds/);
  // A Claude edit of a matching file gets lesson lines and no decision.
  const edit = await hook(s.path, "claude", await payload("claude-pre-tool-edit", s.repo));
  assert.match(edit.json.hookSpecificOutput.additionalContext, /Migrations before seeds/);
  assert.doesNotMatch(edit.out, /permissionDecision|"decision"/);
});
