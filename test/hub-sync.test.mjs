import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile, readdir, rename, symlink, chmod, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd, readHubBinding } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { addPersonalRecord, readPersonalSnapshot } from "../src/records/personal.mjs";
import { renderHubLesson, HUB_LIMITS } from "../src/hubs/read.mjs";
import { publishToHub, enqueueOutbox, listOutbox } from "../src/hubs/git-write.mjs";
import { dialogArgv, dialogText, osascriptDialog, DIALOG_SCRIPT } from "../src/owner/dialog.mjs";
import { ownerAction, OWNER_ACTIONS } from "../src/hooks/owner-block.mjs";
import { RELEASABLE_LOCKS } from "../src/storage/lock.mjs";
import { stableNodePath } from "../src/schedule/launchd.mjs";

const SCOPE = "example";
const HOUR = 3600 * 1000;
const at = (hours) => () => new Date(now().getTime() + hours * HOUR);
const lessonId = (c) => "lsn_" + c.repeat(24);
const noteId = (c) => "note_" + c.repeat(24);
// The fixture transport: Git runs the SSH command with a host and the remote service; this runs the service locally.
const FAKE_SSH = "#!/bin/sh\n[ \"$1\" = \"-G\" ] && exit 1\nfor last; do :; done\ncase \"$last\" in\n  \"git-upload-pack \"*|\"git-receive-pack \"*) exec sh -c \"git ${last#git-}\" ;;\nesac\nexit 1\n";

// One shared bare hub repository with hub.json, plus a colleague working clone that pushes with the fixture Git.
async function hubFixture(t, { schemaVersion = 1 } = {}) {
  const sb = await sandbox(t), bare = join(sb, "hub.git"), work = join(sb, "colleague");
  await mkdir(bare);
  await fixtureGit(bare, ["init", "-q", "--bare", "-b", "main"]);
  await makeRepo(work, { "hub.json": JSON.stringify({ hubId: "example-hub", schemaVersion }) + "\n", "README.md": "hub\n" });
  await fixtureGit(work, ["remote", "add", "origin", bare]);
  await fixtureGit(work, ["push", "-q", "origin", "main"]);
  const ssh = join(sb, "fake-ssh");
  await writeFile(ssh, FAKE_SSH);
  await chmod(ssh, 0o755);
  const push = async (files, { symlinks = {} } = {}) => {
    await fixtureGit(work, ["pull", "-q", "--rebase", "origin", "main"]);
    for (const [rel, content] of Object.entries(files)) { await mkdir(join(work, rel, ".."), { recursive: true }); await writeFile(join(work, rel), content); }
    for (const [rel, target] of Object.entries(symlinks)) { await mkdir(join(work, rel, ".."), { recursive: true }); await symlink(target, join(work, rel)); }
    await fixtureGit(work, ["add", "-A"]);
    await fixtureGit(work, ["commit", "-q", "-m", "colleague change"]);
    await fixtureGit(work, ["push", "-q", "origin", "main"]);
  };
  return { sb, bare, work, ssh, remote: "ssh://hub.example.invalid" + bare, push };
}

const lessonText = (id, { author = "handle:bob", title = "Retry the billing client", paths = ["src/billing/**"], body = "Wrap billing calls in the retry helper.\n" } = {}) =>
  renderHubLesson({ schemaVersion: 1, id, author, title, match: { paths, packages: [], topics: [] }, createdAt: "2026-10-06T00:00:00.000Z", revisitAfter: null }, body);

// One developer machine: a disposable pilot with a hub root and the hub-sync launch agent approved.
async function machine(t, { handle = "alice" } = {}) {
  const p = await initPilot(t);
  const hubRoot = join(p.pilot.pilotRoot, "hubs"), agents = join(p.agentHomes[0], "Library/LaunchAgents");
  const plist = join(agents, "devtwin.hub-sync." + SCOPE + ".plist");
  await mkdir(agents, { recursive: true });
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot], launchAgents: [plist] } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  await applyScopeAdd(await roots(), { scope: SCOPE, hubs: [], policies: [], now });
  const dialogs = [], launchctl = [];
  let decision = "approved";
  const options = (clock = now) => ({ now: clock, home: p.fakeHome, env: {}, ownerDialog: async (content) => { dialogs.push(content); return decision; }, launchctl: (args) => { launchctl.push(args); return { status: 0, stdout: "", stderr: "" }; } });
  const cli = async (args, clock) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { ...options(clock), stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, clock) => { const out = await cli(args, clock); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const join_ = async (hub, extra = []) => {
    const args = ["hub", "join", "--scope", SCOPE, "--remote", hub.remote, "--handle", handle, "--email", handle + "@example.com", "--ssh-command", hub.ssh, ...extra];
    const plan = await ok(args);
    return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  };
  return { p, path, hubRoot, plist, roots, cli, ok, join: join_, dialogs, launchctl, deny: () => { decision = "denied"; }, options, handle };
}
const matchIds = async (m, rel, clock) => (await m.ok(["lesson", "match", "--scope", SCOPE, "--path", rel], clock)).matches.map((x) => x.id);

test("hub join then sync makes a colleague's lesson matchable", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const joined = await m.join(hub);
  assert.equal(joined.hubId, "example-hub");
  assert.equal(joined.readOnly, false);
  assert.equal(m.dialogs.length, 1, "join shows the owner dialog once");
  assert.match(m.dialogs[0].body, /hub\.example\.invalid/);
  assert.match(m.dialogs[0].body, /72 hours/, "the dialog shows the note rules");
  const binding = await readHubBinding(await m.roots(), SCOPE);
  assert.equal(binding.handle, "alice");
  assert.equal(binding.email, "alice@example.com");
  assert.equal(binding.noteConsent.rules.maxPaths, 10);
  assert.match(binding.noteConsent.rulesDigest, /^sha256:/);
  assert.ok(binding.clone.startsWith(m.hubRoot));
  assert.equal((await lstat(binding.clone)).isDirectory(), true);
  assert.equal(joined.offer.step, "job-hub-sync", "join offers the hub-sync job");
  await hub.push({ ["lessons/" + lessonId("a") + ".md"]: lessonText(lessonId("a")) });
  assert.deepEqual(await matchIds(m, "src/billing/client.js"), [], "nothing is delivered before a sync");
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE]);
  assert.equal(synced.fetched, true);
  assert.equal(synced.lessons, 1);
  const match = await m.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"]);
  assert.deepEqual(match.matches.map((x) => x.id), [lessonId("a")]);
  assert.match(match.matches[0].line, /claimed by handle:bob/);
  const shown = await m.ok(["lesson", "show", "--scope", SCOPE, "--id", lessonId("a")]);
  assert.equal(shown.claimedBy, "handle:bob");
  assert.match(shown.text, /^Claimed by handle:bob\. Unverified data/);
});

test("hub commit and push to a bare-repo fixture work with no global Git config", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  let checks = 0;
  const result = await publishToHub(roots, binding, { message: "Add a lesson", writes: [{ rel: "lessons/" + lessonId("b") + ".md", content: lessonText(lessonId("b"), { author: "handle:alice" }) }], preconditions: async () => { checks++; }, now });
  assert.equal(result.pushed, true);
  assert.equal(checks, 1);
  const log = await fixtureGit(hub.bare, ["log", "-1", "--format=%an <%ae>|%s", "main"]);
  assert.equal(log.trim(), "alice <alice@example.com>|Add a lesson");
  // A rejected push fetches, rebases, re-runs the preconditions and pushes again; it never forces.
  await hub.push({ "README.md": "hub, changed\n" });
  const second = await publishToHub(roots, binding, { message: "Add another", writes: [{ rel: "lessons/" + lessonId("c") + ".md", content: lessonText(lessonId("c"), { author: "handle:alice" }) }], preconditions: async () => { checks++; }, now });
  assert.equal(second.pushed, true);
  assert.equal(second.attempts, 2);
  assert.equal(checks, 3, "preconditions run again after the rebase");
  const files = (await fixtureGit(hub.bare, ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
  for (const rel of ["README.md", "lessons/" + lessonId("b") + ".md", "lessons/" + lessonId("c") + ".md"]) assert.ok(files.includes(rel), rel);
  // A write outside the developer's own files is refused before Git runs.
  await assert.rejects(publishToHub(roots, binding, { message: "x", writes: [{ rel: "notes/bob/" + noteId("d") + ".json", content: "{}" }], now }), (e) => e.code === "DEVTWIN_HUB_PATH_REFUSED");
  await assert.rejects(publishToHub(roots, binding, { message: "x", writes: [{ rel: "hub.json", content: "{}" }], now }), (e) => e.code === "DEVTWIN_HUB_PATH_REFUSED");
});

test("hub offline sync keeps the old clone and shows the last sync age", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const roots = await m.roots();
  const repo = await makeRepo(join(m.p.reposDir, "atlas"), { "README.md": "# Atlas\n" });
  const input = { scope: SCOPE, project: "example.atlas", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_hubsync01" };
  const plan = await planOnboard(roots, roots.pilot, input);
  await applyOnboard(roots, roots.pilot, input, { fingerprint: plan.fingerprint, now });
  await hub.push({ ["lessons/" + lessonId("a") + ".md"]: lessonText(lessonId("a")) });
  await m.join(hub);
  await m.ok(["hub", "sync", "--scope", SCOPE]);
  const fresh = await m.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo]);
  assert.ok(!fresh.warnings.some((w) => w.code === "HUB_STALE"));
  await rename(hub.bare, hub.bare + ".offline");
  const offline = await m.ok(["hub", "sync", "--scope", SCOPE], at(30));
  assert.equal(offline.fetched, false);
  assert.equal(offline.warning, "hub last synced 30 h ago");
  const binding = await readHubBinding(roots, SCOPE);
  assert.ok(existsSync(join(binding.clone, "lessons", lessonId("a") + ".md")), "the old clone stays");
  assert.deepEqual(await matchIds(m, "src/billing/a.js", at(30)), [lessonId("a")], "delivery reads the old clone");
  const status = await m.ok(["hub", "status", "--scope", SCOPE], at(30));
  assert.equal(status.warning, "hub last synced 30 h ago");
  assert.equal(status.lastResult, "fetch-failed");
  const brief = await m.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo], at(30));
  assert.ok(brief.warnings.some((w) => w.code === "HUB_STALE" && w.message === "hub last synced 30 h ago"), JSON.stringify(brief.warnings));
});

test("hub leave removes delivery and the job, and keeps personal copies", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await hub.push({ ["lessons/" + lessonId("a") + ".md"]: lessonText(lessonId("a")) });
  await m.join(hub);
  await m.ok(["hub", "sync", "--scope", SCOPE]);
  const personal = await addPersonalRecord(await m.roots(), { requestId: "req_personal01", recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: "lesson", status: "observed", title: "Keep this copy", body: "Copied from the hub by hand.\n", reach: "personal", match: { paths: ["src/billing/**"] } } }, { now });
  const schedule = await m.ok(["hub", "schedule", "--scope", SCOPE]);
  await m.ok(["hub", "schedule", "--scope", SCOPE, "--apply", "--plan-fingerprint", schedule.fingerprint]);
  assert.ok(existsSync(m.plist));
  assert.deepEqual((await matchIds(m, "src/billing/a.js")).sort(), [lessonId("a"), personal.recordId].sort());
  const binding = await readHubBinding(await m.roots(), SCOPE);
  const preview = await m.ok(["hub", "leave", "--scope", SCOPE]);
  assert.equal(preview.removeClone, binding.clone);
  assert.equal(preview.job.installed, true);
  assert.match(preview.offSwitch, /notes and lesson updates/);
  const dialogsBefore = m.dialogs.length;
  const left = await m.ok(["hub", "leave", "--scope", SCOPE, "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.equal(left.left, true);
  assert.equal(m.dialogs.length, dialogsBefore + 1, "leave shows the owner dialog");
  assert.ok(!existsSync(binding.clone), "the clone is deleted");
  assert.ok(!existsSync(m.plist), "the job's plist is removed");
  assert.ok(m.launchctl.some((args) => args[0] === "bootout" && args[1].endsWith("/devtwin.hub-sync." + SCOPE)), JSON.stringify(m.launchctl));
  const after = await readHubBinding(await m.roots(), SCOPE);
  assert.equal(after.status, "left");
  assert.equal(after.noteConsent, null, "note consent is revoked");
  assert.equal(after.delivery, "off");
  assert.deepEqual(await matchIds(m, "src/billing/a.js"), [personal.recordId], "hub lessons stop; the personal copy stays");
  assert.ok((await readPersonalSnapshot(await m.roots())).records.some((r) => r.id === personal.recordId));
  const sync = await m.cli(["hub", "sync", "--scope", SCOPE]);
  assert.equal(sync.json.error.code, "DEVTWIN_HUB_NOT_JOINED");
});

test("hub join refuses an HTTPS remote and remotes with a password", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  for (const remote of ["https://hub.example.invalid/hub.git", "http://hub.example.invalid/hub.git", "git://hub.example.invalid/hub.git", "file://" + hub.bare, hub.bare, "ext::sh -c touch% /tmp/x", ["ssh://dev", "pw"].join(":") + "@" + "hub.example.invalid/hub.git", "ssh://hub.example.invalid/hub.git?x=1", "-oProxyCommand=x:hub.git", "hub.example.invalid:-x"]) {
    const out = await m.cli(["hub", "join", "--scope", SCOPE, "--remote=" + remote, "--handle", "alice", "--email", "alice@example.com"]);
    assert.equal(out.json.error.code, "DEVTWIN_HUB_REMOTE_REFUSED", remote);
  }
  assert.deepEqual(await readdir(m.p.pilot.pilotRoot).then((names) => names.includes("hubs")), false, "nothing is cloned");
  // An unreachable SSH remote is refused at preview.
  const gone = await m.cli(["hub", "join", "--scope", SCOPE, "--remote", "ssh://hub.example.invalid" + hub.bare + "-missing", "--handle", "alice", "--email", "alice@example.com", "--ssh-command", hub.ssh]);
  assert.equal(gone.json.error.code, "DEVTWIN_HUB_UNREACHABLE");
});

test("hub lesson committed as a symlink to a file outside the clone is refused and its target is not read", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const outside = join(hub.sb, "outside-target.md");
  await writeFile(outside, lessonText(lessonId("e"), { title: "CANARY-OUTSIDE-TARGET" }));
  await hub.push({ ["lessons/" + lessonId("a") + ".md"]: lessonText(lessonId("a")) }, { symlinks: { ["lessons/" + lessonId("e") + ".md"]: outside } });
  await m.join(hub);
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE]);
  assert.equal(synced.lessons, 1);
  assert.deepEqual(synced.refused, [{ rel: "lessons/" + lessonId("e") + ".md", reason: "not-regular" }]);
  const binding = await readHubBinding(await m.roots(), SCOPE);
  const node = await lstat(join(binding.clone, "lessons", lessonId("e") + ".md"));
  assert.equal(node.isSymbolicLink(), false, "the clone keeps symlinks off");
  const index = await m.ok(["lesson", "index", "--scope", SCOPE]);
  assert.equal(index.counts.hub, 1);
  const match = await m.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/a.js"]);
  assert.ok(!JSON.stringify(match).includes("CANARY-OUTSIDE-TARGET"));
});

test("hub oversized note file is refused", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const note = (line) => JSON.stringify({ schemaVersion: 1, id: noteId("f"), handle: "bob", area: { paths: ["src/billing"], packages: [] }, line, createdAt: now().toISOString(), expiresAt: at(72)().toISOString() });
  await hub.push({ ["notes/bob/" + noteId("f") + ".json"]: note("x".repeat(HUB_LIMITS.noteBytes)), ["notes/bob/" + noteId("a") + ".json"]: note("bob on main touching src/billing").replace(noteId("f"), noteId("a")) });
  await m.join(hub);
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE]);
  assert.equal(synced.notes, 1);
  assert.deepEqual(synced.refused, [{ rel: "notes/bob/" + noteId("f") + ".json", reason: "too-large" }]);
});

test("hub with a newer schema version is read-only with a warning", async (t) => {
  const hub = await hubFixture(t, { schemaVersion: 2 }), m = await machine(t);
  await hub.push({ ["lessons/" + lessonId("a") + ".md"]: lessonText(lessonId("a")) });
  const joined = await m.join(hub);
  assert.equal(joined.readOnly, true);
  assert.deepEqual(joined.warnings.map((w) => w.code), ["HUB_SCHEMA_NEWER"]);
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE]);
  assert.equal(synced.readOnly, true);
  assert.equal(synced.lessons, 0, "a newer hub is not read");
  assert.deepEqual(await matchIds(m, "src/billing/a.js"), []);
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  const head = await fixtureGit(hub.bare, ["rev-parse", "main"]);
  await assert.rejects(publishToHub(roots, binding, { message: "x", writes: [{ rel: "lessons/" + lessonId("b") + ".md", content: lessonText(lessonId("b"), { author: "handle:alice" }) }], now }), (e) => e.code === "DEVTWIN_HUB_READ_ONLY");
  assert.equal(await fixtureGit(hub.bare, ["rev-parse", "main"]), head, "nothing is written to a newer hub");
});

test("hub second join for the same scope is refused", async (t) => {
  const hub = await hubFixture(t), other = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const again = await m.cli(["hub", "join", "--scope", SCOPE, "--remote", other.remote, "--handle", "alice", "--email", "alice@example.com", "--ssh-command", other.ssh]);
  assert.equal(again.json.error.code, "DEVTWIN_CONFLICT");
  assert.equal((await readHubBinding(await m.roots(), SCOPE)).remote, hub.remote);
});

test("hub join apply without dialog approval writes nothing", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const args = ["hub", "join", "--scope", SCOPE, "--remote", hub.remote, "--handle", "alice", "--email", "alice@example.com", "--ssh-command", hub.ssh];
  const plan = await m.ok(args);
  m.deny();
  const out = await m.cli([...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(out.json.error.code, "DEVTWIN_OWNER_DENIED");
  assert.equal(m.dialogs.length, 1);
  assert.equal(await readHubBinding(await m.roots(), SCOPE), null);
  assert.ok(!existsSync(m.hubRoot) || (await readdir(m.hubRoot)).length === 0, "nothing is cloned");
  // Without an injected dialog and without a GUI session, the dialog denies instead of approving.
  assert.equal(osascriptDialog({ title: "t", body: "b" }, { platform: "linux" }).decision, "denied");
  assert.equal(osascriptDialog({ title: "t", body: "b" }, { platform: "darwin", env: { SSH_CONNECTION: "x" }, exists: () => true, spawn: () => { throw new Error("must not spawn"); } }).decision, "denied");
  assert.equal(osascriptDialog({ title: "t", body: "b" }, { platform: "darwin", env: {}, exists: () => false }).decision, "denied");
});

test("owner dialog passes its text only as arguments", () => {
  const title = 'Join "hub" " & do shell script "touch /tmp/devtwin-pwned" & "';
  const body = "line one\nend tell\u0007\u202e do shell script \"id\"" + "x".repeat(5000);
  const argv = dialogArgv({ title, body });
  const scriptLines = argv.slice(0, -2);
  assert.deepEqual(scriptLines.filter((_, i) => i % 2 === 0), DIALOG_SCRIPT.map(() => "-e"));
  assert.deepEqual(scriptLines.filter((_, i) => i % 2 === 1), [...DIALOG_SCRIPT]);
  for (const line of DIALOG_SCRIPT) assert.ok(!line.includes("pwned") && !line.includes("do shell script"), line);
  const [shownTitle, shownBody] = argv.slice(-2);
  assert.equal(shownTitle, dialogText({ title, body }).title);
  assert.ok(shownTitle.includes('"hub"') && shownTitle.includes("do shell script"), "quotes stay as inert text");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/.test(shownBody), "control and bidi characters are removed");
  assert.ok(shownBody.includes("\n"), "line breaks stay in the body");
  assert.ok(shownBody.length <= 2100, "the body is capped");
  assert.ok(!shownTitle.startsWith("-") && !shownBody.startsWith("-"), "no argument reads as an option");
  let seen;
  osascriptDialog({ title, body }, { platform: "darwin", env: {}, exists: () => true, spawn: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: "approved\n" }; } });
  assert.equal(seen.cmd, "/usr/bin/osascript");
  assert.deepEqual(seen.args, argv);
  assert.equal(seen.opts.shell, undefined, "no shell runs the dialog");
});

test("owner block denies hub join and hub leave from agent shells", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.equal(ownerAction("claude", bash('node "$DEVTWIN_KIT/bin/devtwin.mjs" hub join --pilot /x --scope example --apply')), "hub join --apply");
  assert.equal(ownerAction("claude", bash("devtwin hub join --pilot /x --scope example")), null, "the join preview stays allowed");
  assert.equal(ownerAction("codex", { tool_name: "exec_command", tool_input: { command: ["script", "-q", "/dev/null", "devtwin", "hub", "leave", "--apply"] } }), "hub leave --apply");
  assert.equal(ownerAction("claude", bash("devtwin hub schedule --scope example --apply --plan-fingerprint x")), "hub schedule --apply");
  assert.equal(ownerAction("claude", bash("devtwin hub leave --scope example")), null, "the leave preview stays allowed");
  assert.equal(ownerAction("claude", bash("devtwin hub sync --scope example")), null);
  assert.ok(OWNER_ACTIONS.some((a) => a.words.join(" ") === "hub leave"));
  assert.ok(RELEASABLE_LOCKS.includes("hub-sync"));
});

test("hub-sync launchd plist runs hub sync every 10 minutes through the launchctl seam", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const plan = await m.ok(["hub", "schedule", "--scope", SCOPE]);
  assert.equal(plan.action, "install");
  assert.equal(plan.plist, m.plist);
  assert.equal(plan.interval, 600);
  assert.match(plan.offSwitch, /notes and lesson updates stop/);
  assert.ok(!existsSync(m.plist), "the preview writes nothing");
  const applied = await m.ok(["hub", "schedule", "--scope", SCOPE, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(applied.enabled, true);
  const xml = await readFile(m.plist, "utf8");
  assert.match(xml, /<key>Label<\/key>\s*<string>devtwin\.hub-sync\.example<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>600<\/integer>/);
  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
  for (const word of ["hub", "sync", "--scope", SCOPE, "--job", m.path]) assert.ok(args.includes(word), word);
  assert.deepEqual(m.launchctl.at(-1).slice(0, 1), ["bootstrap"]);
  assert.equal(m.launchctl.at(-1)[2], m.plist);
  assert.equal((await lstat(m.plist)).mode & 0o777, 0o600);
  // The job runs, writes its receipt and skips a second run within its period.
  const first = await m.ok(["hub", "sync", "--scope", SCOPE, "--job"]);
  assert.equal(first.fetched, true);
  assert.equal((await m.ok(["hub", "sync", "--scope", SCOPE, "--job"], at(0.05))).skipped, "ran-recently");
  assert.equal((await m.ok(["hub", "sync", "--scope", SCOPE, "--job"], at(0.2))).fetched, true);
  // The off switch removes the job; a disabled job makes no network call.
  const off = await m.ok(["hub", "schedule", "--scope", SCOPE, "--off"]);
  assert.equal(off.action, "remove");
  await m.ok(["hub", "schedule", "--scope", SCOPE, "--off", "--apply", "--plan-fingerprint", off.fingerprint]);
  assert.ok(!existsSync(m.plist));
  await rename(hub.bare, hub.bare + ".offline");
  const disabled = await m.ok(["hub", "sync", "--scope", SCOPE, "--job"], at(5));
  assert.equal(disabled.skipped, "job-disabled");
  const status = await m.ok(["hub", "status", "--scope", SCOPE], at(5));
  assert.equal(status.lastResult, "ok", "the disabled job recorded no fetch attempt");
});

test("hub outbox drain re-runs isolation and drops a stale note", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  const note = { schemaVersion: 1, id: noteId("b"), handle: "alice", area: { paths: ["src/billing"], packages: [] }, line: "alice on main touching src/billing", createdAt: now().toISOString(), expiresAt: at(72)().toISOString() };
  await enqueueOutbox(roots, binding, { kind: "note", message: "Add a note", writes: [{ rel: "notes/alice/" + noteId("b") + ".json", content: JSON.stringify(note) + "\n" }], createdAt: note.createdAt, expiresAt: note.expiresAt }, { now });
  await enqueueOutbox(roots, binding, { kind: "lesson", message: "Add a lesson", writes: [{ rel: "lessons/" + lessonId("c") + ".md", content: lessonText(lessonId("c"), { author: "handle:alice", body: "Call the northwind ledger through the retry helper.\n" }) }], createdAt: now().toISOString() }, { now });
  await enqueueOutbox(roots, binding, { kind: "lesson", message: "Add a clean lesson", writes: [{ rel: "lessons/" + lessonId("d") + ".md", content: lessonText(lessonId("d"), { author: "handle:alice" }) }], createdAt: now().toISOString() }, { now });
  assert.equal((await listOutbox(roots, binding)).length, 3);
  // A scope added after the item was queued is still checked when the item is pushed.
  await applyScopeAdd(roots, { scope: "northwind", hubs: [], policies: [], now });
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], at(40));
  assert.deepEqual(synced.outbox.pushed.length, 1);
  assert.deepEqual(synced.outbox.dropped.map((d) => d.reason).sort(), ["isolation", "stale"]);
  assert.equal((await listOutbox(roots, binding)).length, 0);
  const files = (await fixtureGit(hub.bare, ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
  assert.ok(files.includes("lessons/" + lessonId("d") + ".md"));
  assert.ok(!files.includes("lessons/" + lessonId("c") + ".md"), "the isolation check ran again at push time");
  assert.ok(!files.includes("notes/alice/" + noteId("b") + ".json"), "a note past half its expiry is dropped");
});

test("hub two fixture machines exchange a lesson and a note through one bare repo with only the sync job running", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  for (const m of [a, b]) {
    const plan = await m.ok(["hub", "schedule", "--scope", SCOPE]);
    await m.ok(["hub", "schedule", "--scope", SCOPE, "--apply", "--plan-fingerprint", plan.fingerprint]);
  }
  const job = async (m, clock) => {
    const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(await readFile(m.plist, "utf8"))[1];
    const args = [...program.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]), chunks = [];
    assert.equal(args[0], stableNodePath(), "the job runs a stable Node path");
    assert.match(args[1], /bin\/devtwin\.mjs$/);
    await main(args.slice(2), { ...m.options(clock), stdout: { write: (v) => { chunks.push(v); return true; } } });
    const out = JSON.parse(chunks.join(""));
    assert.equal(out.ok, true, JSON.stringify(out.error));
    return out.result;
  };
  const rootsA = await a.roots(), bindingA = await readHubBinding(rootsA, SCOPE);
  await enqueueOutbox(rootsA, bindingA, { kind: "lesson", message: "Add a lesson", writes: [{ rel: "lessons/" + lessonId("a") + ".md", content: lessonText(lessonId("a"), { author: "handle:alice", title: "Use the ledger retry helper" }) }], createdAt: now().toISOString() }, { now });
  const note = { schemaVersion: 1, id: noteId("a"), handle: "alice", area: { paths: ["src/billing"], packages: [] }, line: "alice on main touching src/billing", createdAt: now().toISOString(), expiresAt: at(72)().toISOString() };
  await enqueueOutbox(rootsA, bindingA, { kind: "note", message: "Add a note", writes: [{ rel: "notes/alice/" + noteId("a") + ".json", content: JSON.stringify(note) + "\n" }], createdAt: note.createdAt, expiresAt: note.expiresAt }, { now });
  assert.equal((await job(a)).outbox.pushed.length, 2);
  const received = await job(b, at(0.2));
  assert.equal(received.lessons, 1);
  assert.equal(received.notes, 1);
  const match = await b.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/a.js"], at(0.2));
  assert.deepEqual(match.matches.map((x) => x.id), [lessonId("a")]);
  assert.match(match.matches[0].line, /claimed by handle:alice/);
});

test("setup hub-join and job-hub-sync steps join the hub and install the job through the owner dialog", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  const flags = ["--scope", SCOPE, "--hub-remote", hub.remote, "--hub-handle", "alice", "--hub-email", "alice@example.com", "--ssh-command", hub.ssh];
  const solo = await m.ok(["setup", "status", "--scope", SCOPE]);
  assert.match(solo.steps.find((s) => s.id === "hub-join").skipped, /^solo mode/);
  assert.match(solo.steps.find((s) => s.id === "job-hub-sync").skipped, /no hub joined/);
  const plan = await m.ok(["setup", "plan", "--step", "hub-join", ...flags]);
  assert.equal(plan.step.owner, true);
  assert.equal(plan.preview.kind, "hub-join");
  await m.ok(["setup", "apply", "--step", "hub-join", ...flags, "--plan-fingerprint", plan.fingerprint]);
  assert.equal(m.dialogs.length, 1);
  const job = await m.ok(["setup", "plan", "--step", "job-hub-sync", "--scope", SCOPE]);
  assert.equal(job.preview.interval, 600);
  await m.ok(["setup", "apply", "--step", "job-hub-sync", "--scope", SCOPE, "--plan-fingerprint", job.fingerprint]);
  assert.ok(existsSync(m.plist));
  const after = await m.ok(["setup", "status", "--scope", SCOPE]);
  for (const id of ["hub-join", "job-hub-sync"]) assert.equal(after.steps.find((s) => s.id === id).done, true, id);
  for (const id of ["hub-join", "job-hub-sync"]) assert.equal(ownerAction("claude", { tool_name: "Bash", tool_input: { command: "devtwin setup apply --step " + id + " --plan-fingerprint x" } }), "setup apply --step " + id);
});

test("setup batch with job-hub-sync and consent-hub shows one dialog and no step dialog", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const joined = m.dialogs.length;
  const args = ["--steps", "job-hub-sync,consent-hub", "--scope", SCOPE];
  const plan = await m.ok(["setup", "plan", ...args]);
  assert.deepEqual(plan.items.map((i) => i.id), ["consent-hub", "job-hub-sync"]);
  assert.deepEqual(plan.excluded, []);
  assert.equal(plan.dialog.title, "Approve 2 setup changes");
  const out = await m.ok(["setup", "apply", ...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual(out.done.map((d) => d.id), ["consent-hub", "job-hub-sync"]);
  assert.equal(m.dialogs.length, joined + 1, "one dialog for the batch, none from the hub schedule or the consent grant");
  assert.equal(m.dialogs.at(-1).title, "devtwin: Approve 2 setup changes");
  assert.ok(existsSync(m.plist), "the hub sync job is installed");
  assert.ok(m.launchctl.some((args) => args[0] === "bootstrap"), "the job was loaded");
  const status = await m.ok(["setup", "status", "--scope", SCOPE]);
  for (const id of ["job-hub-sync", "consent-hub"]) assert.equal(status.steps.find((s) => s.id === id).done, true, id);
});
