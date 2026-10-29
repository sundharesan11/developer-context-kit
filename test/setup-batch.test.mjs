import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, chmod, readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { sandbox, makeRepo, fixtureGit, treeSnapshot, makePilot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { SKILL_NAMES } from "../src/agents/install.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { BATCH_ORDER } from "../src/setup/batch.mjs";
import { BATCH_GRANT, issueBatchGrant, requireOwnerApproval, revokeBatchGrant } from "../src/owner/dialog.mjs";
import { readAudit } from "../src/audit/log.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";

const SKILLS = join(import.meta.dirname, "..", "skills");
const DUMP = process.env.SETUP_BATCH_DUMP === "1";
// A fresh fixture home with a private ~/.devtwin, a pinned kit clone, the agent folders and one repository. live init and
// init run through the CLI, as the owner runs them before setup. Every owner dialog goes to a recording fake, and
// launchctl is a fake: no test shows a real dialog or loads a real job.
async function setupHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".codex", "Library/LaunchAgents"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kitFiles = { "README.md": "kit\n" };
  for (const name of SKILL_NAMES) kitFiles["skills/" + name + "/SKILL.md"] = await readFile(join(SKILLS, name, "SKILL.md"), "utf8");
  const kit = await makeRepo(join(devtwin, "kit"), kitFiles);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\nBilling API.\n", "package.json": "{\"name\":\"atlas\",\"scripts\":{\"test\":\"node --test\"}}" });
  const liveConfig = join(devtwin, "live.json"), backups = join(home, "devtwin-backups");
  const dialogs = [], loaded = [];
  let answer = () => "approved", onLaunchctl = () => null, kitNow = kit;
  const launchctl = (args) => { loaded.push(args.join(" ")); onLaunchctl(args); return { status: 0, stdout: "", stderr: "" }; };
  const cli = async (args, env = {}) => {
    const chunks = [];
    const code = await main(args, { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home, env, kitRoot: kitNow, launchctl,
      ownerDialog: async (content) => { dialogs.push(content); return answer(content); } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => {
    const out = await cli(args);
    assert.equal(out.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(out.json.error));
    return out.json.result;
  };
  const initArgs = ["--pilot", liveConfig, "--agent", "claude", "--agent", "codex", "--repo", repo];
  const preview = await ok(["live", "init", ...initArgs]);
  await ok(["live", "init", ...initArgs, "--apply", "--plan-fingerprint", preview.fingerprint]);
  await ok(["init", "--pilot", liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  const roots = async () => rootsFromPilot(await loadPilot(liveConfig, { home, env: {}, kitRoot: kitNow }));
  // A second pinned clone, as an upgrade makes; useKit runs the CLI from it, as the owner does for live set-kit.
  const nextKit = async (name = "kit-next") => {
    const next = await makeRepo(join(devtwin, name), { ...kitFiles, "README.md": "kit next\n" });
    await fixtureGit(next, ["checkout", "-q", "--detach"]);
    return { kit: next, commit: (await fixtureGit(next, ["rev-parse", "HEAD"])).trim() };
  };
  return { sb, home, kit, repo, liveConfig, backups, cli, ok, roots, dialogs, loaded, nextKit, useKit: (path) => { kitNow = path; }, setAnswer: (fn) => { answer = fn; }, setLaunchctl: (fn) => { onLaunchctl = fn; } };
}
const plan = (h, extra = []) => h.ok(["setup", "plan", "--pilot", h.liveConfig, "--all-pending", "--backup-target", h.backups, ...extra]);
const apply = (h, fingerprint, extra = []) => h.cli(["setup", "apply", "--pilot", h.liveConfig, "--all-pending", "--backup-target", h.backups, ...extra, "--apply", "--plan-fingerprint", fingerprint]);

test("setup batch shows one dialog that lists every planned change one per line, and nothing else asks", async (t) => {
  const h = await setupHome(t);
  const p = await plan(h);
  if (DUMP) console.log(p.dialog.title + "\n" + p.dialog.body + "\n" + JSON.stringify({ excluded: p.excluded, skipped: p.skipped }, null, 2));
  assert.deepEqual(p.items.map((i) => i.id), ["config", "skills-claude", "skills-codex", "job-review-reminder", "job-backup", "paths-confirm", "hooks-claude", "hooks-codex"]);
  assert.deepEqual(p.items[0].covers, ["write-classes-hooks", "backup-folder"]);
  assert.deepEqual(h.dialogs, [], "a plan shows no dialog");
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(h.dialogs.length, 1, "one owner dialog for the whole batch");
  assert.equal(h.dialogs[0].body, "Approve only if you started this action yourself.\n\n" + p.dialog.body);
  const lines = p.dialog.body.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(p.dialog.title, "Approve " + lines.length + " setup changes");
  assert.deepEqual(lines.map((line) => line.replace(/^\d+\. /, "")), p.items.flatMap((i) => i.lines));
  assert.deepEqual(out.json.result.done.map((d) => d.id), p.items.map((i) => i.id));
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig, "--backup-target", h.backups]);
  for (const id of ["write-classes-hooks", "backup-folder", "skills-claude", "skills-codex", "job-review-reminder", "job-backup", "paths-confirm", "hooks-claude", "hooks-codex"]) assert.equal(status.steps.find((s) => s.id === id).done, true, id);
  // One audit entry per step run, each with the batch ID.
  const entries = (await readAudit(await h.roots())).entries.filter((e) => e.kind === "setup-batch");
  assert.deepEqual(entries.map((e) => e.target), p.items.map((i) => i.id));
  assert.ok(entries.every((e) => e.itemIds[0] === out.json.result.batch && e.route === "setup apply" && e.tier === "always-ask"));
});

test("setup batch after a config change confirms the paths again and refreshes the kit receipt", async (t) => {
  const h = await setupHome(t);
  const first = await plan(h);
  assert.ok(first.skipped.some((s) => s.id === "hook-verify"), "the hook install writes the receipt");
  assert.equal((await apply(h, first.fingerprint)).json.ok, true);
  // A second backup folder changes the config: the paths confirmation and the receipt follow in the same dialog.
  const more = join(h.home, "more-backups");
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--all-pending", "--backup-target", h.backups, "--backup-target", more]);
  assert.deepEqual(p.items.map((i) => i.id), ["config", "paths-confirm", "hook-verify"]);
  assert.deepEqual(p.items[0].lines, ["Approve backup folder ~/more-backups"]);
  assert.match(p.items[2].lines[0], /^Write the kit receipt that the hook trusts at ~\/\.devtwin\/store\/state\/hooks\/kit-receipt\.json$/);
  const out = await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--all-pending", "--backup-target", h.backups, "--backup-target", more, "--apply", "--plan-fingerprint", p.fingerprint]);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.deepEqual(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses.backupTargets, [h.backups, more]);
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig]);
  for (const id of ["paths-confirm", "hook-verify"]) assert.equal(status.steps.find((s) => s.id === id).done, true, id);
  assert.equal(h.dialogs.length, 2, "one dialog for each batch");
});

test("setup batch: a denied dialog changes nothing", async (t) => {
  const h = await setupHome(t);
  const p = await plan(h);
  const before = await treeSnapshot(h.sb);
  h.setAnswer(() => "denied");
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.error.code, "DEVTWIN_OWNER_DENIED");
  assert.equal(h.dialogs.length, 1);
  assert.equal(await treeSnapshot(h.sb), before, "nothing was written");
  assert.deepEqual(h.loaded, [], "no job was loaded");
  // A wrong fingerprint is refused before any dialog.
  assert.equal((await apply(h, "sha256:" + "0".repeat(64))).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.equal(h.dialogs.length, 1);
});

test("setup batch: a step that changed after the preview stops the batch with STALE_VERSION and reports done and not run", async (t) => {
  const h = await setupHome(t);
  const p = await plan(h);
  // The owner approves, and the Claude settings file changes before the hook step runs.
  h.setAnswer(async () => { await writeFile(join(h.home, ".claude/settings.json"), "{\"theme\":\"dark\"}\n"); return "approved"; });
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "DEVTWIN_STALE_VERSION");
  const d = out.json.error.details;
  assert.equal(d.failed, "hooks-claude");
  assert.deepEqual(d.done, ["config", "skills-claude", "skills-codex", "job-review-reminder", "job-backup", "paths-confirm"]);
  assert.deepEqual(d.notRun, ["hooks-codex"]);
  assert.match(d.batch, /^batch_[a-f0-9]{16}$/);
  assert.equal(await readFile(join(h.home, ".claude/settings.json"), "utf8"), "{\"theme\":\"dark\"}\n", "the changed file is left alone");
  assert.equal(h.dialogs.length, 1);
  const entries = (await readAudit(await h.roots())).entries.filter((e) => e.kind === "setup-batch");
  assert.deepEqual(entries.map((e) => e.target), d.done, "no audit entry for the step that did not run");
});

test("setup batch merges new launch agents with the approved list and orders config, jobs, paths confirm, hooks", async (t) => {
  const h = await setupHome(t);
  const earlier = join(h.home, "Library/LaunchAgents/devtwin.activity-weekly.plist");
  const pre = await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", earlier]);
  await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", earlier, "--apply", "--plan-fingerprint", pre.fingerprint]);
  // The order given does not matter: the batch puts config first, then jobs, then paths confirm, then hooks.
  const args = ["--steps", "hooks-claude,paths-confirm", "--steps", "job-review-reminder,write-classes-hooks"];
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, ...args]);
  assert.deepEqual(p.items.map((i) => i.id), ["config", "job-review-reminder", "paths-confirm", "hooks-claude"]);
  assert.deepEqual(p.items[0].lines, ["Approve hook settings file ~/.claude/settings.json", "Approve hook settings file ~/.codex/hooks.json", "Approve launch agent ~/Library/LaunchAgents/devtwin.review-monthly.plist"]);
  assert.ok(BATCH_ORDER.indexOf("job-review-reminder") < BATCH_ORDER.indexOf("paths-confirm") && BATCH_ORDER.indexOf("paths-confirm") < BATCH_ORDER.indexOf("hooks-claude"));
  const out = await h.cli(["setup", "apply", "--pilot", h.liveConfig, ...args, "--apply", "--plan-fingerprint", p.fingerprint]);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  const config = JSON.parse(await readFile(h.liveConfig, "utf8"));
  assert.deepEqual(config.writeClasses.launchAgents, [earlier, join(h.home, "Library/LaunchAgents/devtwin.review-monthly.plist")], "the earlier plist stays");
  // paths confirm ran after the config change, so the confirmation matches the final config.
  assert.equal((await h.ok(["paths", "check", "--pilot", h.liveConfig])).state, "confirmed");
  assert.equal(h.dialogs.length, 1);
});

test("setup batch reports excluded steps with a reason and never cuts a consent's rules", async (t) => {
  const h = await setupHome(t);
  const inputs = ["--scope", "example", "--project", "example.atlas", "--repo", h.repo, "--accept", "all"];
  for (const id of ["scope", "first-project"]) {
    const s = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--step", id, ...inputs]);
    await h.ok(["setup", "apply", "--pilot", h.liveConfig, "--step", id, ...inputs, "--plan-fingerprint", s.fingerprint]);
  }
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--steps", "profile,hub-join,starter-templates,consent-repo,job-review-reminder", "--push-repo", h.repo, "--scope", "example", "--hub-remote", "ssh://git@example.com/hub.git"]);
  assert.deepEqual(p.excluded.map((e) => e.id), ["profile", "hub-join", "starter-templates"]);
  for (const e of p.excluded) assert.ok(e.reason.length > 10, e.id);
  assert.match(p.excluded[0].reason, /needs no owner approval/);
  assert.deepEqual(p.items.map((i) => i.id), ["config", "consent-repo", "job-review-reminder"]);
  // The consent's full dialog text is in the batch dialog, line for line.
  const { grantDialog } = await import("../src/consent/commands.mjs");
  const consent = p.items.find((i) => i.id === "consent-repo");
  for (const line of grantDialog(consent.preview).body.split("\n")) assert.ok(p.dialog.body.includes("    " + line), line);
  assert.deepEqual(p.separate.map((s) => s.command), ["live set-kit", "instructions apply", "backup key export"]);
  const args = ["--steps", "consent-repo,job-review-reminder", "--push-repo", h.repo];
  const fresh = await h.ok(["setup", "plan", "--pilot", h.liveConfig, ...args]);
  const out = await h.cli(["setup", "apply", "--pilot", h.liveConfig, ...args, "--apply", "--plan-fingerprint", fresh.fingerprint]);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(h.dialogs.length, 1, "the consent's own dialog did not show");
  assert.equal((await h.ok(["consent", "list", "--pilot", h.liveConfig])).consents.filter((c) => c.kind === "repo-push").length, 1);
});

test("setup batch fit: long consent text leaves the batch whole, and a batch that cannot fit stops with LIMIT", async () => {
  const { fitItems } = await import("../src/setup/batch.mjs");
  const line = (id) => ({ id, lines: ["Install job " + id] });
  const long = { id: "consent-repo", lines: ["Grant consent repo-push"], text: Array.from({ length: 40 }, (_, i) => "Rule " + i + ": " + "x".repeat(60)) };
  const fit = fitItems([line("a"), long, line("b")]);
  assert.deepEqual(fit.batch.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(fit.dropped.map((x) => x.id), ["consent-repo"]);
  assert.ok(!fit.dialog.body.includes("Rule 0"), "the consent is left out, not cut");
  const small = fitItems([line("a"), { ...long, text: ["Rule 0: short"] }]);
  assert.deepEqual(small.batch.map((x) => x.id), ["a", "consent-repo"]);
  assert.ok(small.dialog.body.endsWith("    Rule 0: short"));
  assert.throws(() => fitItems(Array.from({ length: 60 }, (_, i) => ({ id: "s" + i, lines: ["Install job " + "y".repeat(40) + i] }))), (e) => e.code === "DEVTWIN_LIMIT");
});

test("setup apply --steps and --all-pending are denied from an agent shell; setup plan stays open", async (t) => {
  const p = await makePilot(t);
  const bash = (command) => ({ session_id: "s-batch", cwd: p.reposDir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_01Example" });
  const KIT = 'node "$DEVTWIN_KIT/bin/devtwin.mjs"';
  for (const command of [
    `${KIT} setup apply --pilot /x/live.json --all-pending --apply --plan-fingerprint sha256:00`,
    `${KIT} setup apply --pilot /x/live.json --steps hooks-claude,job-radar --apply --plan-fingerprint sha256:00`,
    `${KIT} setup apply --pilot /x/live.json --steps=profile,sandbox --apply`,
    `${KIT} setup apply --pilot /x/live.json --step profile,job-backup`
  ]) {
    assert.ok(ownerAction("claude", bash(command)), command);
    const chunks = [];
    await main(["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(bash(command)), now });
    assert.equal(JSON.parse(chunks.join("")).hookSpecificOutput.permissionDecision, "deny", command);
  }
  for (const command of [`${KIT} setup plan --pilot /x/live.json --all-pending`, `${KIT} setup plan --pilot /x/live.json --steps hooks-claude,job-radar`]) assert.equal(ownerAction("claude", bash(command)), null, command);
});

test("hook install rebuilds the lesson index and summaries, so an upgraded store with a bound project and no index resolves the project", async (t) => {
  const h = await setupHome(t);
  const inputs = ["--scope", "example", "--project", "example.atlas", "--repo", h.repo, "--accept", "all"];
  for (const id of ["scope", "first-project"]) {
    const s = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--step", id, ...inputs]);
    await h.ok(["setup", "apply", "--pilot", h.liveConfig, "--step", id, ...inputs, "--plan-fingerprint", s.fingerprint]);
  }
  // An older kit wrote the store: no lesson index and no session summary.
  const state = (await h.roots()).stateRoot;
  await rm(join(state, "lessons"), { recursive: true, force: true });
  await rm(join(state, "summaries"), { recursive: true, force: true });
  const settings = join(h.home, ".claude/settings.json");
  const wc = await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--hook-target", settings]);
  await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--hook-target", settings, "--apply", "--plan-fingerprint", wc.fingerprint]);
  const hooks = await h.ok(["agents", "install", "--hooks", "--pilot", h.liveConfig, "--agent", "claude"]);
  const installed = await h.ok(["agents", "install", "--hooks", "--pilot", h.liveConfig, "--agent", "claude", "--apply", "--plan-fingerprint", hooks.fingerprint]);
  assert.deepEqual(installed.derived, [{ scope: "example", written: true }]);
  assert.ok(existsSync(join(state, "lessons", "example.json")), "the index is back");
  assert.ok(existsSync(join(state, "summaries", "example", "example.atlas.json")), "the session summary is back");
  const chunks = [];
  await main(["hook", "--event", "session-start", "--agent", "claude", "--pilot", h.liveConfig], { now, kitRoot: h.kit, stdin: JSON.stringify({ session_id: "s-upgrade", cwd: h.repo, hook_event_name: "SessionStart", source: "startup" }), stdout: { write: (v) => { chunks.push(v); return true; } } });
  const context = JSON.parse(chunks.join("")).hookSpecificOutput.additionalContext;
  assert.match(context, /for example\.atlas\./);
  assert.doesNotMatch(context, /not a bound project/);
});

test("setup batch approval is an in-process grant that no argument or environment variable can stand for", async (t) => {
  const h = await setupHome(t);
  assert.equal(typeof BATCH_GRANT, "symbol");
  // An unknown flag is a usage error, so no argument can carry a grant.
  for (const flag of ["--grant", "--batch-grant", "--approved"]) assert.equal((await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--steps", "job-review-reminder", flag, "x", "--apply"])).json.error.code, "DEVTWIN_USAGE", flag);
  // Environment variables do not skip a step's own dialog.
  const plist = join(h.home, "Library/LaunchAgents/devtwin.review-monthly.plist");
  const pre = await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", plist]);
  await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", plist, "--apply", "--plan-fingerprint", pre.fingerprint]);
  const s = await h.ok(["schedule", "plan", "--pilot", h.liveConfig, "--job", "review-monthly"]);
  h.setAnswer(() => "denied");
  const env = { DEVTWIN_BATCH_GRANT: "1", BATCH_GRANT: "approved", DEVTWIN_APPROVED: "1" };
  assert.equal((await h.cli(["schedule", "apply", "--pilot", h.liveConfig, "--job", "review-monthly", "--plan-fingerprint", s.fingerprint], env)).json.error.code, "DEVTWIN_OWNER_DENIED");
  // A real batch with the same variables still shows its one dialog: denied, it changes nothing.
  const batchArgs = ["setup", "apply", "--pilot", h.liveConfig, "--steps", "job-review-reminder"];
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--steps", "job-review-reminder"]);
  assert.deepEqual(p.items.map((i) => i.id), ["job-review-reminder"]);
  const before = await treeSnapshot(h.sb), shown = h.dialogs.length;
  assert.equal((await h.cli([...batchArgs, "--apply", "--plan-fingerprint", p.fingerprint], env)).json.error.code, "DEVTWIN_OWNER_DENIED");
  assert.equal(h.dialogs.length, shown + 1, "the batch dialog showed");
  assert.equal(await treeSnapshot(h.sb), before, "nothing was written");
  assert.deepEqual(h.loaded, [], "no job was loaded");
  // Approved, the batch runs the step with no second dialog.
  h.setAnswer(() => "approved");
  const out = await h.cli([...batchArgs, "--apply", "--plan-fingerprint", p.fingerprint], env);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(h.dialogs.length, shown + 2);
  assert.deepEqual(out.json.result.done.map((d) => d.id), ["job-review-reminder"]);
  // A look-alike object is not a grant; a real grant counts for one dialog and ends when revoked.
  const denied = async (ctx, options) => { await assert.rejects(requireOwnerApproval({ ...ctx, ownerDialog: () => "denied" }, { title: "t", body: "b" }, options), (e) => e.code === "DEVTWIN_OWNER_DENIED"); };
  const fp = "sha256:" + "a".repeat(64);
  await denied({ [BATCH_GRANT]: Object.freeze({ batchFingerprint: "sha256:00", step: "x", stepFingerprint: fp }) }, { fingerprint: fp });
  await denied({ [BATCH_GRANT]: "approved" }, { fingerprint: fp });
  // Review fix: a grant stands only for the dialog of the step's own plan. A dialog with no fingerprint or another
  // fingerprint is shown (and here denied), and leaves the grant unused.
  const grant = issueBatchGrant({ batchFingerprint: "sha256:00", step: "x", stepFingerprint: fp });
  await denied({ [BATCH_GRANT]: grant });
  await denied({ [BATCH_GRANT]: grant }, { fingerprint: "sha256:" + "b".repeat(64) });
  assert.equal((await requireOwnerApproval({ [BATCH_GRANT]: grant, ownerDialog: () => "denied" }, { title: "t", body: "b" }, { fingerprint: fp })).step, "x");
  await denied({ [BATCH_GRANT]: grant }, { fingerprint: fp });
  const other = issueBatchGrant({ batchFingerprint: "sha256:00", step: "y", stepFingerprint: fp });
  revokeBatchGrant(other);
  await denied({ [BATCH_GRANT]: other }, { fingerprint: fp });
});

test("setup batch excludes only the step whose write-class path cannot be approved, and batches the rest", async (t) => {
  const h = await setupHome(t);
  // The Claude settings file is a symlink: its hook target cannot be approved.
  const real = join(h.sb, "elsewhere-settings.json");
  await writeFile(real, "{}\n");
  await symlink(real, join(h.home, ".claude/settings.json"));
  const p = await plan(h);
  const excluded = Object.fromEntries(p.excluded.map((e) => [e.id, e]));
  for (const id of ["write-classes-hooks", "hooks-claude"]) assert.ok(excluded[id], id + " is excluded");
  assert.match(excluded["hooks-claude"].reason, /cannot be approved in the live config: DEVTWIN_/);
  assert.match(excluded["hooks-claude"].code, /^DEVTWIN_/);
  const ids = p.items.map((i) => i.id);
  for (const id of ["config", "skills-claude", "skills-codex", "job-review-reminder", "job-backup", "paths-confirm", "hooks-codex"]) assert.ok(ids.includes(id), id + " is batched");
  assert.ok(!ids.includes("hooks-claude"));
  assert.doesNotMatch(p.dialog.body, /\.claude\/settings\.json/);
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(out.json.result.done.map((d) => d.id), ids);
  assert.equal(await readFile(real, "utf8"), "{}\n", "the symlink target is left alone");
});

test("setup batch dialog lines are single lines, and a path with a control character is refused", async (t) => {
  const { fitItems, oneLine } = await import("../src/setup/batch.mjs");
  const { validateRoot } = await import("../src/config/roots.mjs");
  // Review repro: a value with a line break forged a numbered line of its own.
  const forged = fitItems([{ id: "a", lines: ["Approve backup folder /b/x\n2. Install job radar-weekly (weekly)"] }, { id: "b", lines: ["Install job b " + "3. Fake"], text: ["rule\r4. Fake"] }]);
  const numbered = forged.dialog.body.split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(numbered.length, 2, forged.dialog.body);
  assert.equal(forged.dialog.title, "Approve 2 setup changes");
  assert.equal(numbered[0], "1. Approve backup folder /b/x\\u{a}2. Install job radar-weekly (weekly)");
  assert.equal(oneLine("a‮b​c\td"), "a\\u{202e}b\\u{200b}c\\u{9}d");
  for (const path of ["/tmp/a\nb", "/tmp/a b", "/tmp/a‮b", "/tmp/a\u0000b", "/tmp/a​b"]) assert.throws(() => validateRoot(path, "test"), (e) => e.code === "DEVTWIN_PATH_UNSAFE", JSON.stringify(path));
  // Through the CLI: a backup folder with a line break leaves the batch, and no dialog line holds its text.
  const h = await setupHome(t);
  const bad = join(h.home, "b\n9. Install job evil");
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--steps", "backup-folder,job-review-reminder", "--backup-target", bad]);
  assert.equal(p.excluded.find((e) => e.id === "backup-folder")?.code, "DEVTWIN_PATH_UNSAFE");
  assert.deepEqual(p.items.map((i) => i.id), ["config", "job-review-reminder"]);
  assert.ok(!p.dialog.body.split("\n").some((line) => /^9\. /.test(line)), p.dialog.body);
});

test("setup batch: a step that fails in its own apply has no audit entry, and an error that is not a devtwin error keeps done and not run", async (t) => {
  const h = await setupHome(t);
  const args = ["--steps", "job-review-reminder,paths-confirm"];
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, ...args]);
  assert.deepEqual(p.items.map((i) => i.id), ["config", "job-review-reminder", "paths-confirm"]);
  // launchctl fails after the replan, inside the job step's own apply.
  h.setLaunchctl((cmd) => { if (cmd[0] === "bootstrap") throw new TypeError("launchctl broke"); });
  const out = await h.cli(["setup", "apply", "--pilot", h.liveConfig, ...args, "--apply", "--plan-fingerprint", p.fingerprint]);
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "DEVTWIN_INTERNAL");
  const d = out.json.error.details;
  assert.equal(d.failed, "job-review-reminder");
  assert.deepEqual(d.done, ["config"]);
  assert.deepEqual(d.notRun, ["paths-confirm"]);
  assert.match(d.batch, /^batch_[a-f0-9]{16}$/);
  assert.match(d.error.message, /launchctl broke/);
  const entries = (await readAudit(await h.roots())).entries.filter((e) => e.kind === "setup-batch");
  assert.deepEqual(entries.map((e) => e.target), ["config"], "the log names only the step that ran");
  assert.equal(h.dialogs.length, 1);
});

test("setup batch: a failure after the last step is reported in derived.error and keeps the steps done", async (t) => {
  const h = await setupHome(t);
  const args = ["--steps", "job-review-reminder"];
  const p = await h.ok(["setup", "plan", "--pilot", h.liveConfig, ...args]);
  assert.deepEqual(p.items.map((i) => i.id), ["config", "job-review-reminder"]);
  // The last step loads its job, and then the live config breaks: the reload before the derived rebuild fails.
  h.setLaunchctl((cmd) => { if (cmd[0] === "bootstrap") writeFileSync(h.liveConfig, "{"); });
  const out = await h.cli(["setup", "apply", "--pilot", h.liveConfig, ...args, "--apply", "--plan-fingerprint", p.fingerprint]);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.deepEqual(out.json.result.done.map((d) => d.id), ["config", "job-review-reminder"]);
  assert.match(out.json.result.derived.error.code, /^DEVTWIN_/);
});

// Upgrade fix: after live set-kit, a job that is on keeps the old kit in its plist until the plist is written again.
const AGENTS_DIR = "Library/LaunchAgents";
const rewriteLines = (p) => p.items.flatMap((i) => i.lines).filter((line) => line.startsWith("Rewrite job "));
async function enableActivityJob(h) {
  const plist = join(h.home, AGENTS_DIR, "devtwin.activity-weekly.plist");
  const pre = await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", plist]);
  await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--launch-agent", plist, "--apply", "--plan-fingerprint", pre.fingerprint]);
  const job = await h.ok(["schedule", "plan", "--pilot", h.liveConfig, "--job", "activity-weekly"]);
  await h.ok(["schedule", "apply", "--pilot", h.liveConfig, "--job", "activity-weekly", "--plan-fingerprint", job.fingerprint]);
  return plist;
}

test("setup batch after live set-kit lists every enabled job as a rewrite line and one approval rewrites their plists for the new kit", async (t) => {
  const h = await setupHome(t);
  // activity-weekly has no setup step; review-monthly and backup-daily come from the first batch.
  const activity = await enableActivityJob(h);
  const first = await plan(h);
  assert.equal((await apply(h, first.fingerprint)).json.ok, true);
  const plists = ["review-monthly", "backup-daily", "activity-weekly"].map((job) => join(h.home, AGENTS_DIR, "devtwin." + job + ".plist"));
  assert.equal(plists[2], activity);
  const settled = await plan(h);
  assert.deepEqual(rewriteLines(settled), [], "an up-to-date enabled job is not listed");
  assert.ok(!settled.items.some((i) => i.id.startsWith("job-")), JSON.stringify(settled.items.map((i) => i.id)));
  // live set-kit from the new clone, as docs/LIVE.md describes.
  const next = await h.nextKit();
  h.useKit(next.kit);
  const kitPlan = await h.ok(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit]);
  await h.ok(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit, "--apply", "--plan-fingerprint", kitPlan.fingerprint]);
  // schedule status and setup status report the outdated jobs.
  const sched = await h.ok(["schedule", "status", "--pilot", h.liveConfig]);
  for (const job of ["review-monthly", "backup-daily", "activity-weekly"]) {
    const row = sched.jobs.find((j) => j.job === job);
    assert.deepEqual([row.enabled, row.plistState, row.outdated], [true, "outdated", true], job);
  }
  assert.deepEqual(sched.outdated.map((o) => o.job).sort(), ["activity-weekly", "backup-daily", "review-monthly"]);
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig, "--backup-target", h.backups]);
  for (const id of ["job-review-reminder", "job-backup"]) {
    const step = status.steps.find((s) => s.id === id);
    assert.deepEqual([step.done, step.status], [false, "outdated"], id);
  }
  assert.ok(status.outdatedJobs.some((o) => o.job === "activity-weekly" && o.state === "outdated"));
  const p = await plan(h);
  if (DUMP) console.log(p.dialog.body);
  const kitShown = "~/.devtwin/kit-next";
  assert.deepEqual(rewriteLines(p), ["review-monthly", "backup-daily", "activity-weekly"].map((job) => "Rewrite job " + job + " at ~/" + AGENTS_DIR + "/devtwin." + job + ".plist for kit " + kitShown));
  assert.ok(["job-review-reminder", "job-backup", "job-rewrite-activity-weekly"].every((id) => p.items.some((i) => i.id === id)));
  const ids = p.items.map((i) => i.id);
  assert.ok(ids.indexOf("job-rewrite-activity-weekly") < ids.indexOf("paths-confirm"), "the rewrites run before paths confirm");
  const dialogs = h.dialogs.length;
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(h.dialogs.length, dialogs + 1, "one approval for the whole batch");
  for (const path of plists) {
    const xml = await readFile(path, "utf8");
    assert.ok(xml.includes("<string>" + join(next.kit, "bin/devtwin.mjs") + "</string>"), path);
    assert.ok(!xml.includes(join(h.kit, "bin/devtwin.mjs")), path);
  }
  const after = await h.ok(["schedule", "status", "--pilot", h.liveConfig]);
  assert.deepEqual(after.outdated, []);
  assert.ok(after.jobs.filter((j) => j.enabled).every((j) => j.plistState === "current" && !j.outdated));
  assert.deepEqual(rewriteLines(await plan(h)), [], "nothing is left to rewrite");
});

test("setup batch lists an enabled job whose plist is missing and does not read a plist through a link", async (t) => {
  const h = await setupHome(t);
  const first = await plan(h);
  assert.equal((await apply(h, first.fingerprint)).json.ok, true);
  const review = join(h.home, AGENTS_DIR, "devtwin.review-monthly.plist"), backup = join(h.home, AGENTS_DIR, "devtwin.backup-daily.plist");
  // A missing plist for an enabled job is outdated; the current one is not listed.
  const kept = await readFile(review, "utf8");
  await rm(review);
  const sched = await h.ok(["schedule", "status", "--pilot", h.liveConfig]);
  assert.deepEqual(sched.outdated.map((o) => [o.job, o.state]), [["review-monthly", "missing"]]);
  assert.equal(sched.jobs.find((j) => j.job === "backup-daily").plistState, "current");
  const p = await plan(h);
  assert.deepEqual(rewriteLines(p), ["Rewrite job review-monthly at ~/" + AGENTS_DIR + "/devtwin.review-monthly.plist for kit ~/.devtwin/kit"]);
  assert.ok(p.skipped.some((s) => s.id === "job-backup" && s.reason === "done"));
  const out = await apply(h, p.fingerprint);
  assert.equal(out.json.ok, true, JSON.stringify(out.json.error));
  assert.equal(await readFile(review, "utf8"), kept, "the plist is written again with the same bytes");
  assert.equal((await h.ok(["schedule", "status", "--pilot", h.liveConfig])).jobs.find((j) => j.job === "review-monthly").plistState, "current");
  // A plist that is a link is never read or written through: the live config refuses to load, and the target stays.
  const elsewhere = join(h.sb, "elsewhere.plist"), bytes = await readFile(backup, "utf8");
  await writeFile(elsewhere, bytes);
  await rm(backup);
  await symlink(elsewhere, backup);
  const refused = await h.cli(["setup", "plan", "--pilot", h.liveConfig, "--all-pending", "--backup-target", h.backups]);
  assert.equal(refused.json.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(await readFile(elsewhere, "utf8"), bytes, "the link target is left alone");
  assert.ok((await lstat(backup)).isSymbolicLink(), "the link is not replaced");
});
