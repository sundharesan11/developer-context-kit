import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile, readdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd, readHubBinding } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { addPersonalRecord, readPersonalSnapshot } from "../src/records/personal.mjs";
import { readSnapshot } from "../src/records/store.mjs";
import { listOutbox } from "../src/hubs/git-write.mjs";
import { parseHubLesson } from "../src/hubs/read.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { planAccept, applyAccept, planCopy, applyCopy, TARGETS, leavesMachine } from "../src/lessons/publish.mjs";

const SCOPE = "example", OTHER = "contoso";
const HOUR = 3600 * 1000;
const at = (hours) => () => new Date(now().getTime() + hours * HOUR);
// The fixture transport: Git runs the SSH command with a host and the remote service; this runs the service locally.
// It clears the client's per-command config, so a server-side hook in the bare fixture can run.
const FAKE_SSH = "#!/bin/sh\n[ \"$1\" = \"-G\" ] && exit 1\nfor last; do :; done\nunset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT\ncase \"$last\" in\n  \"git-upload-pack \"*|\"git-receive-pack \"*) exec sh -c \"git ${last#git-}\" ;;\nesac\nexit 1\n";

async function hubFixture(t, { hubId = "example-hub" } = {}) {
  const sb = await sandbox(t), bare = join(sb, "hub.git"), work = join(sb, "colleague");
  await mkdir(bare);
  await fixtureGit(bare, ["init", "-q", "--bare", "-b", "main"]);
  await makeRepo(work, { "hub.json": JSON.stringify({ hubId, schemaVersion: 1 }) + "\n", "README.md": "hub\n" });
  await fixtureGit(work, ["remote", "add", "origin", bare]);
  await fixtureGit(work, ["push", "-q", "origin", "main"]);
  const ssh = join(sb, "fake-ssh");
  await writeFile(ssh, FAKE_SSH);
  await chmod(ssh, 0o755);
  const files = async () => (await fixtureGit(bare, ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
  const head = async () => (await fixtureGit(bare, ["rev-parse", "main"])).trim();
  // Every later push is refused by the remote, as a protected branch would refuse it.
  const refusePushes = async () => { await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n"); await chmod(join(bare, "hooks", "pre-receive"), 0o755); };
  return { sb, bare, ssh, remote: "ssh://hub.example.invalid" + bare, files, head, refusePushes };
}

// One developer machine with a pilot, the scope, a hub root and an injected owner dialog.
async function machine(t, { handle = "alice", scopes = [SCOPE] } = {}) {
  const p = await initPilot(t);
  const hubRoot = join(p.pilot.pilotRoot, "hubs");
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot] } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  for (const scope of scopes) await applyScopeAdd(await roots(), { scope, hubs: [], policies: [], now });
  const dialogs = [];
  let decision = "approved";
  const options = (clock = now) => ({ now: clock, home: p.fakeHome, env: {}, ownerDialog: async (content) => { dialogs.push(content); return decision; } });
  const cli = async (args, { clock, stdin } = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { ...options(clock), stdin, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.error; };
  const join_ = async (hub, scope = SCOPE) => {
    const args = ["hub", "join", "--scope", scope, "--remote", hub.remote, "--handle", handle, "--email", handle + "@example.com", "--ssh-command", hub.ssh];
    const plan = await ok(args);
    return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  };
  // Preview, then apply with the fingerprint, as the owner runs it.
  const applied = async (args) => { const plan = await ok(args); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint]); };
  return { p, path, roots, cli, ok, fail, applied, join: join_, dialogs, setDialog: (value) => { decision = value; }, handle };
}

const lessonArgs = ({ session = "ses_one", scope = SCOPE, title = "Retry the billing client", summary = "Do wrap billing calls in the retry helper.", body = "A billing call can fail once under load. The helper retries with backoff.\n", paths = ["src/billing/**"], extra = [] } = {}) =>
  ["lesson", "propose", "--session", session, "--scope", scope, "--title", title, "--summary", summary, "--body", body, ...paths.flatMap((x) => ["--path", x]), ...extra];
// lesson propose with --apply, as an agent runs it after the user's yes.
const propose = async (m, opts) => (await m.ok([...lessonArgs(opts), "--apply"])).proposalId;
const matchIds = async (m, rel, clock = now) => (await m.ok(["lesson", "match", "--scope", SCOPE, "--path", rel], { clock })).matches.map((x) => x.id);
const accept = (id, target, extra = []) => ["lesson", "accept", "--id", id, "--target", target, ...extra];

test("lesson propose then accept to the hub after dialog approval reaches a colleague through hub sync", async (t) => {
  const hub = await hubFixture(t), a = await machine(t), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const preview = await a.ok(lessonArgs());
  assert.equal(preview.preview, true);
  assert.deepEqual(await a.ok(["lesson", "proposals"]), { proposals: [] }, "the preview writes nothing");
  const id = await propose(a);
  assert.equal(id, preview.proposalId);
  const listed = (await a.ok(["lesson", "proposals"])).proposals;
  assert.deepEqual(listed.map((x) => [x.id, x.state, x.session]), [[id, "pending", "ses_one"]]);
  assert.equal(listed[0].summary, "Do wrap billing calls in the retry helper.");
  const proposalFile = join((await a.roots()).dataRoot, "lesson-proposals", id + ".json");
  assert.equal(JSON.parse(await readFile(proposalFile, "utf8")).review, "unreviewed");
  const headBefore = await hub.head();
  const dialogsBefore = a.dialogs.length;
  const plan = await a.ok(accept(id, "hub"));
  assert.equal(plan.target, "hub");
  assert.match(plan.hub.lessonId, /^lsn_[a-f0-9]{24}$/);
  assert.equal(plan.hub.author, "handle:alice");
  assert.equal(await hub.head(), headBefore, "the preview publishes nothing");
  assert.equal(a.dialogs.length, dialogsBefore, "the preview shows no dialog");
  const result = await a.ok([...accept(id, "hub"), "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(a.dialogs.length, dialogsBefore + 1, "the apply shows the owner dialog once");
  const shown = a.dialogs.at(-1);
  for (const text of ["Retry the billing client", "Do wrap billing calls in the retry helper.", "The helper retries with backoff.", "paths: src/billing/**", "Hub: example-hub", "Hub only"]) assert.ok(shown.body.includes(text), "dialog shows " + text);
  assert.equal(result.hub.pushed, true);
  assert.equal(result.hub.lessonId, plan.hub.lessonId);
  assert.equal(result.personal, undefined, "hub only writes no personal copy");
  const rel = "lessons/" + plan.hub.lessonId + ".md";
  assert.ok((await hub.files()).includes(rel));
  const published = parseHubLesson(await fixtureGit(hub.bare, ["show", "main:" + rel]));
  assert.equal(published.meta.author, "handle:alice");
  assert.match(published.meta.localRecordHash, /^sha256:/);
  assert.equal(published.body.split("\n")[0], "Do wrap billing calls in the retry helper.");
  assert.equal((await a.ok(["lesson", "proposals"])).proposals.length, 0, "the accepted proposal is no longer pending");
  assert.deepEqual(await matchIds(a, "src/billing/client.js"), [plan.hub.lessonId], "accept rebuilt the author's index");
  // The colleague's machine gets the lesson on its next sync.
  assert.deepEqual(await matchIds(b, "src/billing/client.js"), []);
  assert.equal((await b.ok(["hub", "sync", "--scope", SCOPE], { clock: at(0.2) })).lessons, 1);
  const match = await b.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"], { clock: at(0.2) });
  assert.deepEqual(match.matches.map((x) => x.id), [plan.hub.lessonId]);
  assert.match(match.matches[0].line, /claimed by handle:alice/);
  assert.match(match.matches[0].line, /Do wrap billing calls/);
  // A second accept of the same proposal is refused.
  await a.fail(accept(id, "hub"), "DEVTWIN_CONFLICT");
});

test("lesson accept to the hub with the dialog dismissed publishes nothing and keeps the proposal pending", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const id = await propose(m);
  const head = await hub.head();
  for (const target of ["hub", "hub+general"]) {
    const plan = await m.ok(accept(id, target));
    m.setDialog(target === "hub" ? "denied" : { decision: "dismissed", reason: "gave-up" });
    const before = m.dialogs.length;
    const error = await m.fail([...accept(id, target), "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
    assert.equal(m.dialogs.length, before + 1, target);
    assert.ok(error.details.reason);
  }
  assert.equal(await hub.head(), head, "no commit reaches the hub");
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  assert.deepEqual(await listOutbox(roots, binding), [], "no outbox item");
  assert.equal((await fixtureGit(binding.clone, ["rev-parse", "HEAD"])).trim(), head, "the clone has no local commit");
  assert.deepEqual((await readPersonalSnapshot(roots)).records, [], "no personal copy");
  assert.deepEqual((await m.ok(["lesson", "proposals"])).proposals.map((x) => [x.id, x.state]), [[id, "pending"]]);
  // A stale fingerprint is refused before the dialog.
  m.setDialog("approved");
  const before = m.dialogs.length;
  await m.fail([...accept(id, "hub"), "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], "DEVTWIN_PLAN_MISMATCH");
  assert.equal(m.dialogs.length, before);
});

test("lesson accept through a terminal wrapper from a hooked agent shell is denied before the dialog", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const id = await propose(m);
  const plan = await m.ok(accept(id, "hub"));
  const before = m.dialogs.length;
  const kit = 'node "$DEVTWIN_KIT/bin/devtwin.mjs"';
  for (const command of [
    `script -q /dev/null ${kit} lesson accept --pilot '${m.path}' --id '${id}' --target hub --apply --plan-fingerprint '${plan.fingerprint}'`,
    `unbuffer devtwin lesson accept --id ${id} --target hub+general --apply`,
    `bash -c "devtwin lesson copy --id rec_x --to-scope ${OTHER} --apply"`
  ]) {
    const payload = { session_id: "s-agent", cwd: m.p.reposDir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "run" }, tool_use_id: "toolu_01Example" };
    assert.ok(ownerAction("claude", payload), command);
    const chunks = [];
    const code = await main(["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", m.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now });
    assert.equal(code, 0);
    const out = JSON.parse(chunks.join(""));
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /owner-only/);
  }
  assert.equal(m.dialogs.length, before, "the denied command never reached the dialog");
  assert.deepEqual((await m.ok(["lesson", "proposals"])).proposals.map((x) => x.state), ["pending"]);
  // The agent-callable routes stay allowed.
  for (const command of ["devtwin lesson propose --session s --scope example --apply", "devtwin lesson proposals", "devtwin lesson match --scope example --path a.js"]) {
    assert.equal(ownerAction("claude", { tool_name: "Bash", tool_input: { command } }), null, command);
  }
});

test("lesson propose refuses a fourth proposal in one session", async (t) => {
  const m = await machine(t);
  const ids = [];
  for (const n of [1, 2, 3]) ids.push(await propose(m, { title: "Lesson number " + n }));
  assert.equal(new Set(ids).size, 3);
  // The same draft again is the same proposal, not a new one.
  assert.equal((await m.ok([...lessonArgs({ title: "Lesson number 1" }), "--apply"])).created, false);
  const error = await m.fail(lessonArgs({ title: "Lesson number 4" }), "DEVTWIN_LIMIT");
  assert.equal(error.details.max, 3);
  await m.fail([...lessonArgs({ title: "Lesson number 4" }), "--apply"], "DEVTWIN_LIMIT");
  // A rejected proposal still counts toward the session's cap.
  await m.applied(["lesson", "reject", "--id", ids[0]]);
  await m.fail([...lessonArgs({ title: "Lesson number 4" }), "--apply"], "DEVTWIN_LIMIT");
  // Another session has its own cap.
  assert.match(await propose(m, { session: "ses_two", title: "Lesson number 4" }), /^prop_/);
  assert.equal((await m.ok(["lesson", "proposals"])).proposals.length, 3);
});

test("lesson accept with a rejected push after three tries lands in the outbox and hub status shows it", async (t) => {
  const hub = await hubFixture(t), m = await machine(t);
  await m.join(hub);
  const id = await propose(m);
  await hub.refusePushes();
  const head = await hub.head();
  const result = await m.applied(accept(id, "hub"));
  assert.equal(result.hub.pushed, false);
  assert.equal(result.hub.reason, "rejected");
  assert.match(result.hub.queued, /^obx_[a-f0-9]{24}$/);
  assert.equal(await hub.head(), head);
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  const outbox = await listOutbox(roots, binding);
  assert.deepEqual(outbox.map((x) => [x.id, x.kind, x.writes[0].rel]), [[result.hub.queued, "lesson", "lessons/" + result.hub.lessonId + ".md"]]);
  const status = await m.ok(["hub", "status", "--scope", SCOPE]);
  assert.equal(status.outbox, 1);
  assert.deepEqual((await m.ok(["lesson", "proposals", "--all"])).proposals.map((x) => [x.state, x.outcome.hub.queued]), [["accepted", result.hub.queued]]);
  // Once the remote takes pushes again, the next sync pushes the queued lesson.
  await writeFile(join(hub.bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(0.2) });
  assert.deepEqual(synced.outbox.pushed, [result.hub.queued]);
  assert.ok((await hub.files()).includes("lessons/" + result.hub.lessonId + ".md"));
  assert.equal((await m.ok(["hub", "status", "--scope", SCOPE], { clock: at(0.2) })).outbox, 0);
});

test("lesson accept as hub+general also writes the personal store", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, { scopes: [SCOPE, OTHER] });
  await m.join(hub);
  const id = await propose(m);
  const result = await m.applied(accept(id, "hub+general"));
  assert.equal(result.hub.pushed, true);
  assert.match(m.dialogs.at(-1).body, /Also saves it to your personal store/);
  const personal = (await readPersonalSnapshot(await m.roots())).records;
  assert.deepEqual(personal.map((r) => [r.id, r.kind, r.reach, r.title]), [[result.personal.recordId, "lesson", "personal", "Retry the billing client"]]);
  assert.deepEqual(personal[0].match.paths, ["src/billing/**"]);
  assert.ok((await hub.files()).includes("lessons/" + result.hub.lessonId + ".md"));
  // The personal copy follows the developer to the other organization's index; the hub copy does not.
  assert.deepEqual(result.index.map((x) => x.scope).sort(), [OTHER, SCOPE]);
  const other = await m.ok(["lesson", "match", "--scope", OTHER, "--path", "src/billing/a.js"]);
  assert.deepEqual(other.matches.map((x) => x.id), [result.personal.recordId]);
  assert.deepEqual((await matchIds(m, "src/billing/a.js")).sort(), [result.hub.lessonId, result.personal.recordId].sort());
  // A general target is checked against the lesson's own scope too: text that names it stays out of the personal store.
  const named = await propose(m, { title: "Example billing retries", session: "ses_named" });
  await m.fail(accept(named, "hub+general"), "DEVTWIN_ISOLATION");
  await m.fail(accept(named, "general"), "DEVTWIN_ISOLATION");
  assert.equal((await m.ok(accept(named, "hub"))).target, "hub", "hub only is allowed: the hub belongs to that scope");
});

test("lesson propose refuses another scope's project name", async (t) => {
  const m = await machine(t, { scopes: [SCOPE] });
  const roots = await m.roots();
  await applyScopeAdd(roots, { scope: "northwind", hubs: [], policies: [], now });
  const repo = await makeRepo(join(m.p.reposDir, "beacon"), { "README.md": "# Ledger\n" });
  const input = { scope: "northwind", project: "northwind.ledger", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_lessoniso01" };
  const plan = await planOnboard(roots, roots.pilot, input);
  await applyOnboard(roots, roots.pilot, input, { fingerprint: plan.fingerprint, now });
  for (const opts of [{ body: "The northwind.ledger service needs a retry.\n" }, { title: "Retries for northwind.ledger" }, { paths: ["src/billing/**"], extra: ["--topic", "northwind"] }]) {
    await m.fail(lessonArgs(opts), "DEVTWIN_ISOLATION");
    await m.fail([...lessonArgs(opts), "--apply"], "DEVTWIN_ISOLATION");
  }
  assert.ok(!existsSync(join(roots.dataRoot, "lesson-proposals")), "nothing is written");
  // A lesson that names its own scope may stay a hub-only proposal.
  assert.match(await propose(m, { body: "The example team retries billing calls.\n" }), /^prop_/);
});

test("lesson propose refuses a credential pattern", async (t) => {
  const m = await machine(t);
  const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  await m.fail(lessonArgs({ body: "Use the key " + key + " for the billing client.\n" }), "DEVTWIN_SENSITIVE_CONTENT");
  await m.fail([...lessonArgs({ summary: "Do set password=" + "hunter2hunter2" + " in the client." }), "--apply"], "DEVTWIN_SENSITIVE_CONTENT");
  // Control and bidi characters are refused, so the dialog shows what leaves the machine.
  await m.fail(lessonArgs({ body: "Retry \u202e twice.\n" }), "DEVTWIN_INVALID_INPUT");
  await m.fail(lessonArgs({ paths: [] }), "DEVTWIN_INVALID_INPUT");
  assert.ok(!existsSync(join((await m.roots()).dataRoot, "lesson-proposals")));
});

test("lesson copy publishes a personal lesson to another scope's hub only after the isolation check and dialog", async (t) => {
  const hubA = await hubFixture(t), hubB = await hubFixture(t, { hubId: "contoso-hub" }), m = await machine(t, { scopes: [SCOPE, OTHER] });
  await m.join(hubA, SCOPE);
  await m.join(hubB, OTHER);
  const roots = await m.roots();
  const clean = await addPersonalRecord(roots, { requestId: "req_copyclean1", recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: "lesson", status: "observed", title: "Pin the test clock", body: "Do pass a fixed clock to time-based tests.\n", reach: "personal", match: { topics: ["testing"] } } }, { now });
  const named = await addPersonalRecord(roots, { requestId: "req_copynamed1", recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: "lesson", status: "observed", title: "Northwind clock", body: "Do pass a fixed clock to northwind tests.\n", reach: "personal", match: { topics: ["testing"] } } }, { now });
  // A scope added after the personal lesson was saved is still checked at copy time.
  await applyScopeAdd(roots, { scope: "northwind", hubs: [], policies: [], now });
  const headB = await hubB.head(), before = m.dialogs.length;
  await m.fail(["lesson", "copy", "--id", named.recordId, "--to-scope", OTHER], "DEVTWIN_ISOLATION");
  await m.fail(["lesson", "copy", "--id", named.recordId, "--to-scope", OTHER, "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], "DEVTWIN_ISOLATION");
  assert.equal(m.dialogs.length, before, "the isolation check runs before the dialog");
  // A dismissed dialog publishes nothing.
  const plan = await m.ok(["lesson", "copy", "--id", clean.recordId, "--to-scope", OTHER]);
  assert.equal(plan.hub.hubId, "contoso-hub");
  m.setDialog("denied");
  await m.fail(["lesson", "copy", "--id", clean.recordId, "--to-scope", OTHER, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
  assert.equal(await hubB.head(), headB);
  m.setDialog("approved");
  const copied = await m.ok(["lesson", "copy", "--id", clean.recordId, "--to-scope", OTHER, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(m.dialogs.length, before + 2);
  for (const text of ["Pin the test clock", "Do pass a fixed clock to time-based tests.", "topics: testing", "To scope: contoso"]) assert.ok(m.dialogs.at(-1).body.includes(text), text);
  assert.equal(copied.hub.pushed, true);
  const rel = "lessons/" + copied.hub.lessonId + ".md";
  assert.ok((await hubB.files()).includes(rel));
  assert.ok(!(await hubA.files()).includes(rel), "the copy goes only to the target scope's hub");
  const meta = parseHubLesson(await fixtureGit(hubB.bare, ["show", "main:" + rel])).meta;
  assert.equal(meta.localRecordHash, (await readPersonalSnapshot(roots)).records.find((r) => r.id === clean.recordId).recordHash);
  const match = await m.ok(["lesson", "match", "--scope", OTHER, "--text", "testing"]);
  assert.ok(match.matches.some((x) => x.id === copied.hub.lessonId));
  await m.fail(["lesson", "copy", "--id", clean.recordId, "--to-scope", "northwind"], "DEVTWIN_HUB_NOT_JOINED");
});

test("lesson publish paths never write to a hub without an approved owner dialog", async (t) => {
  const hubA = await hubFixture(t), hubB = await hubFixture(t, { hubId: "contoso-hub" }), m = await machine(t, { scopes: [SCOPE, OTHER] });
  await m.join(hubA, SCOPE);
  await m.join(hubB, OTHER);
  const roots = await m.roots();
  const heads = async () => [await hubA.head(), await hubB.head()];
  const start = await heads();
  assert.deepEqual(TARGETS.filter(leavesMachine), ["hub", "hub+general"]);
  const personal = await addPersonalRecord(roots, { requestId: "req_denycopy01", recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: "lesson", status: "observed", title: "Pin the test clock", body: "Do pass a fixed clock.\n", reach: "personal", match: { topics: ["testing"] } } }, { now });
  let n = 0;
  for (const answer of ["denied", { decision: "denied", reason: "no-gui-session" }, undefined, async () => { throw new Error("dialog crashed"); }]) {
    const ownerDialog = typeof answer === "function" ? answer : async () => answer;
    for (const target of TARGETS.filter(leavesMachine)) {
      const id = await propose(m, { session: "ses_deny_" + ++n, title: "Denied lesson " + target });
      const plan = await planAccept(roots, { id, target });
      assert.equal(plan.dialog, true, target);
      await assert.rejects(applyAccept(roots, { id, target }, { fingerprint: plan.fingerprint, now, ctx: { ownerDialog } }), (e) => e.code === "DEVTWIN_OWNER_DENIED", target);
      assert.equal((await m.ok(["lesson", "proposals"])).proposals.find((x) => x.id === id).state, "pending");
      await m.applied(["lesson", "reject", "--id", id]);
    }
    const copy = await planCopy(roots, { id: personal.recordId, toScope: OTHER });
    await assert.rejects(applyCopy(roots, { id: personal.recordId, toScope: OTHER }, { fingerprint: copy.fingerprint, now, ctx: { ownerDialog } }), (e) => e.code === "DEVTWIN_OWNER_DENIED");
  }
  // Without an injected dialog and without a desktop session, the dialog denies.
  const id = await propose(m, { session: "ses_nogui", title: "No GUI lesson" });
  const plan = await planAccept(roots, { id, target: "hub" });
  await assert.rejects(applyAccept(roots, { id, target: "hub" }, { fingerprint: plan.fingerprint, now, ctx: { env: { SSH_CONNECTION: "x" } } }), (e) => e.code === "DEVTWIN_OWNER_DENIED");
  assert.deepEqual(await heads(), start, "no hub got a commit");
  for (const scope of [SCOPE, OTHER]) assert.deepEqual(await listOutbox(roots, await readHubBinding(roots, scope)), [], scope);
  assert.deepEqual((await readPersonalSnapshot(roots)).records.map((r) => r.id), [personal.recordId], "no personal copy from a denied accept");
  // Source check: the only calls to publishToHub in the lesson code sit behind requireOwnerApproval.
  const source = await readFile(join(import.meta.dirname, "..", "src", "lessons", "publish.mjs"), "utf8");
  assert.equal(source.match(/publishToHub\(/g).length, 1, "one publish call");
  assert.equal(source.match(/publishLesson\(/g).length, 3, "the helper and its two callers");
  for (const fn of ["applyAccept", "applyCopy"]) {
    const body = source.slice(source.indexOf("export async function " + fn));
    const end = body.indexOf("\n}\n");
    const text = body.slice(0, end);
    assert.ok(text.indexOf("requireOwnerApproval") > 0 && text.indexOf("requireOwnerApproval") < text.indexOf("publishLesson("), fn + " shows the dialog before it publishes");
  }
  for (const name of await readdir(join(import.meta.dirname, "..", "src", "lessons"))) {
    if (name === "publish.mjs") continue;
    assert.doesNotMatch(await readFile(join(import.meta.dirname, "..", "src", "lessons", name), "utf8"), /publishToHub|enqueueOutbox/, name);
  }
});

test("lesson edit reject and the local targets work behind the owner dialog", async (t) => {
  const m = await machine(t);
  const roots = await m.roots();
  const repo = await makeRepo(join(m.p.reposDir, "atlas"), { "README.md": "# Atlas\n" });
  const input = { scope: SCOPE, project: "example.atlas", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_lessonloc01" };
  const onboard = await planOnboard(roots, roots.pilot, input);
  await applyOnboard(roots, roots.pilot, input, { fingerprint: onboard.fingerprint, now });
  // The body can come from stdin.
  const fromStdin = (await m.ok(["lesson", "propose", "--session", "ses_local", "--scope", SCOPE, "--project", "example.atlas", "--title", "Seed after migrations", "--body-file", "-", "--path", "db/**", "--apply"], { stdin: "Do run migrations before seeds.\n" })).proposalId;
  const toGeneral = await propose(m, { session: "ses_local", title: "Pin the test clock", summary: "Do pass a fixed clock.", paths: ["test/**"] });
  const toReject = await propose(m, { session: "ses_local", title: "A weak lesson" });
  // Edit: the preview shows the new text and writes nothing; apply writes a new revision.
  const edit = await m.ok(["lesson", "edit", "--id", toGeneral, "--summary", "Do pass a fixed clock to time-based tests.", "--topic", "testing"]);
  assert.equal(edit.lesson.summary, "Do pass a fixed clock to time-based tests.");
  assert.deepEqual(edit.lesson.match, { paths: [], packages: [], topics: ["testing"] });
  assert.equal((await m.ok(["lesson", "proposals"])).proposals.find((x) => x.id === toGeneral).revision, 0);
  await m.ok(["lesson", "edit", "--id", toGeneral, "--summary", "Do pass a fixed clock to time-based tests.", "--topic", "testing", "--apply", "--plan-fingerprint", edit.fingerprint]);
  assert.equal((await m.ok(["lesson", "proposals"])).proposals.find((x) => x.id === toGeneral).revision, 1);
  await m.fail(["lesson", "edit", "--id", toGeneral, "--summary", "Do pass a fixed clock to time-based tests.", "--topic", "testing"], "DEVTWIN_INVALID_INPUT");
  await m.applied(["lesson", "reject", "--id", toReject]);
  const project = await m.applied(accept(fromStdin, "project"));
  const general = await m.applied(accept(toGeneral, "general"));
  // Local targets show the owner dialog too: it names the target and says nothing leaves the machine.
  assert.equal(m.dialogs.length, 2, "each local accept shows the owner dialog");
  assert.match(m.dialogs[0].title, /Save a lesson on this machine/);
  assert.match(m.dialogs[0].body, /lesson of project example\.atlas[\s\S]*Nothing leaves this machine[\s\S]*Seed after migrations/);
  assert.match(m.dialogs[1].body, /personal store/);
  const records = (await readSnapshot(roots, SCOPE, "example.atlas")).records.filter((r) => r.kind === "lesson");
  assert.deepEqual(records.map((r) => [r.id, r.reach, r.title]), [[project.project.recordId, "project", "Seed after migrations"]]);
  const personal = (await readPersonalSnapshot(roots)).records;
  assert.deepEqual(personal.map((r) => [r.id, r.title, r.body.split("\n")[0]]), [[general.personal.recordId, "Pin the test clock", "Do pass a fixed clock to time-based tests."]]);
  assert.deepEqual((await m.ok(["lesson", "proposals", "--all"])).proposals.map((x) => x.state).sort(), ["accepted", "accepted", "rejected"]);
  assert.deepEqual(await matchIds(m, "db/001.sql"), [project.project.recordId]);
  await m.fail(["lesson", "reject", "--id", toReject], "DEVTWIN_CONFLICT");
  await m.fail(accept(toReject, "general"), "DEVTWIN_CONFLICT");
  await m.fail(accept("prop_" + "0".repeat(24), "hub"), "DEVTWIN_NOT_FOUND");
  // Without a hub, a hub target is refused at preview.
  const solo = await propose(m, { session: "ses_solo", title: "Solo lesson" });
  await m.fail(accept(solo, "hub"), "DEVTWIN_HUB_NOT_JOINED");
  await m.fail(accept(solo, "everywhere"), "DEVTWIN_INVALID_INPUT");
});
