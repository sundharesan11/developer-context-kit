import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd, readHubBinding } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { listOutbox } from "../src/hubs/git-write.mjs";
import { sendDue } from "../src/held/send.mjs";
import { parseHubLesson, renderHubLesson, readHub } from "../src/hubs/read.mjs";
import { sha256 } from "../src/storage/canonical.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";

const SCOPE = "example";
const HOUR = 3600 * 1000;
const at = (hours) => () => new Date(now().getTime() + hours * HOUR);
// The fixture transport from test/lessons.test.mjs: it runs the remote service locally and clears the client's
// per-command config, so a server-side hook in the bare fixture can run.
const FAKE_SSH = "#!/bin/sh\n[ \"$1\" = \"-G\" ] && exit 1\nfor last; do :; done\nunset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT\ncase \"$last\" in\n  \"git-upload-pack \"*|\"git-receive-pack \"*) exec sh -c \"git ${last#git-}\" ;;\nesac\nexit 1\n";

async function hubFixture(t) {
  const sb = await sandbox(t), bare = join(sb, "hub.git"), work = join(sb, "colleague");
  await mkdir(bare);
  await fixtureGit(bare, ["init", "-q", "--bare", "-b", "main"]);
  await makeRepo(work, { "hub.json": JSON.stringify({ hubId: "example-hub", schemaVersion: 1 }) + "\n", "README.md": "hub\n" });
  await fixtureGit(work, ["remote", "add", "origin", bare]);
  await fixtureGit(work, ["push", "-q", "origin", "main"]);
  const ssh = join(sb, "fake-ssh");
  await writeFile(ssh, FAKE_SSH);
  await chmod(ssh, 0o755);
  const files = async () => (await fixtureGit(bare, ["ls-tree", "-r", "--name-only", "main"])).trim().split("\n");
  const head = async () => (await fixtureGit(bare, ["rev-parse", "main"])).trim();
  const show = (rel) => fixtureGit(bare, ["show", "main:" + rel]);
  // A colleague writes files straight into the hub, as a client that never saw the other change would.
  const push = async (entries) => {
    await fixtureGit(work, ["pull", "-q", "--rebase", "origin", "main"]);
    for (const [rel, content] of Object.entries(entries)) { await mkdir(join(work, rel, ".."), { recursive: true }); await writeFile(join(work, rel), content); }
    await fixtureGit(work, ["add", "-A"]);
    await fixtureGit(work, ["commit", "-q", "-m", "colleague change"]);
    await fixtureGit(work, ["push", "-q", "origin", "main"]);
  };
  const refusePushes = async () => { await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n"); await chmod(join(bare, "hooks", "pre-receive"), 0o755); };
  const allowPushes = () => writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
  return { sb, bare, ssh, remote: "ssh://hub.example.invalid" + bare, files, head, show, push, refusePushes, allowPushes };
}

// One developer machine with a pilot, the scope, a hub root and an injected owner dialog.
async function machine(t, { handle }) {
  const p = await initPilot(t);
  const hubRoot = join(p.pilot.pilotRoot, "hubs");
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot] } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  await applyScopeAdd(await roots(), { scope: SCOPE, hubs: [], policies: [], now });
  const dialogs = [];
  let decision = "approved";
  const cli = async (args, { clock = now, stdin } = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { now: clock, home: p.fakeHome, env: {}, stdin, ownerDialog: async (content) => { dialogs.push(content); return decision; }, notifier: () => ({ status: 0 }), stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  // U36: the owner joins and grants the hub-publish consent, so lesson accept --target hub runs with no dialog.
  const join_ = async (hub, { consent = true } = {}) => {
    const joined = await applied(["hub", "join", "--scope", SCOPE, "--remote", hub.remote, "--handle", handle, "--email", handle + "@example.com", "--ssh-command", hub.ssh]);
    if (consent) await applied(["consent", "grant", "--kind", "hub-publish", "--scope", SCOPE]);
    return joined;
  };
  const binding = async () => readHubBinding(await roots(), SCOPE);
  return { p, path, roots, cli, ok, fail, applied, join: join_, binding, dialogs, setDialog: (value) => { decision = value; }, handle };
}

const fields = ({ title, summary, body = "The reason, in one line.\n", paths = ["src/billing/**"] }) => ["--title", title, "--summary", summary, "--body", body, ...paths.flatMap((x) => ["--path", x])];
const ORIGINAL = { title: "Retry the billing client", summary: "Do wrap billing calls in the retry helper." };
const REPLACEMENT = { title: "Use the billing queue", summary: "Do send billing calls through the billing queue." };
const propose = async (m, { session = "ses_one", lesson = ORIGINAL } = {}) => (await m.ok(["lesson", "propose", "--session", session, "--scope", SCOPE, ...fields(lesson), "--apply"])).proposalId;
const supersedeArgs = (predecessor, { session = "ses_two", lesson = REPLACEMENT } = {}) => ["lesson", "supersede-propose", "--session", session, "--scope", SCOPE, "--predecessor", predecessor, ...fields(lesson)];
const accept = (id, target = "hub") => ["lesson", "accept", "--id", id, "--target", target];
const sync = (m, clock = at(0.1)) => m.ok(["hub", "sync", "--scope", SCOPE], { clock });
const matchIds = async (m, clock = at(0.1)) => (await m.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"], { clock })).matches.map((x) => x.id).sort();
// U41: a hub accept is held for 24 hours; the sender (as the hourly learning-send job runs it) sends what is due.
const sendHeld = async (m, clock = at(30)) => sendDue(await m.roots(), { now: clock });
// The author publishes a lesson (by default the original) to the hub: accept, then send after the hold.
async function published(m, proposalId) {
  const result = await m.applied(accept(proposalId ?? await propose(m)));
  assert.equal(result.hub.held, true);
  assert.deepEqual((await sendHeld(m)).sent.map((x) => [x.lessonId, x.state]), [[result.hub.lessonId, "sent"]]);
  return result.hub.lessonId;
}
async function cloneState(m, hub) {
  const clone = (await m.binding()).clone;
  return { head: (await fixtureGit(clone, ["rev-parse", "HEAD"])).trim(), remote: await hub.head(), dirty: (await fixtureGit(clone, ["status", "--porcelain"])).trim() };
}

test("lesson supersede accepted and published appears in the author's next brief", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  const rootsA = await a.roots();
  const repo = await makeRepo(join(a.p.reposDir, "atlas"), { "README.md": "# Atlas\n" });
  const input = { scope: SCOPE, project: "example.atlas", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_supersede01" };
  await applyOnboard(rootsA, rootsA.pilot, input, { fingerprint: (await planOnboard(rootsA, rootsA.pilot, input)).fingerprint, now });
  await a.join(hub);
  await b.join(hub);
  const original = await published(a);
  await sync(b);
  assert.deepEqual(await matchIds(b), [original]);
  // The preview reads the local clone and writes nothing.
  const preview = await b.ok(supersedeArgs(original));
  assert.equal(preview.preview, true);
  assert.equal(preview.supersedes.id, original);
  assert.equal(preview.supersedes.hash, sha256(await hub.show("lessons/" + original + ".md")));
  assert.equal(preview.supersedes.title, ORIGINAL.title);
  assert.equal(preview.supersedes.author, "handle:alice");
  assert.deepEqual((await b.ok(["lesson", "proposals"])).proposals, []);
  const created = await b.ok([...supersedeArgs(original), "--apply"], { clock: at(0.2) });
  assert.equal(created.created, true);
  const listed = (await b.ok(["lesson", "proposals"])).proposals;
  assert.deepEqual(listed.map((x) => [x.id, x.supersedes.id]), [[created.proposalId, original]]);
  // A replacement goes to the hub only.
  for (const target of ["general", "project", "hub+general"]) await b.fail(accept(created.proposalId, target), "DEVTWIN_INVALID_INPUT");
  const plan = await b.ok(accept(created.proposalId));
  assert.deepEqual(plan.supersedes, [{ id: original, hash: preview.supersedes.hash }]);
  // The preview names the lesson it replaces; under the hub-publish consent the apply shows no dialog.
  assert.deepEqual(plan.replaces, { id: original, title: ORIGINAL.title, author: "handle:alice" });
  const dialogs = b.dialogs.length;
  const result = await b.ok([...accept(created.proposalId), "--apply", "--plan-fingerprint", plan.fingerprint], { clock: at(0.2) });
  assert.equal(result.hub.held, true);
  assert.deepEqual((await sendHeld(b)).sent.map((x) => [x.lessonId, x.state]), [[result.hub.lessonId, "sent"]]);
  assert.equal(b.dialogs.length, dialogs);
  const meta = parseHubLesson(await hub.show("lessons/" + result.hub.lessonId + ".md")).meta;
  assert.deepEqual(meta.supersedes, [{ id: original, hash: preview.supersedes.hash }]);
  assert.equal(meta.author, "handle:bob");
  assert.deepEqual(await matchIds(b, at(0.2)), [result.hub.lessonId], "the replacement's own machine stops matching the original");
  // The author: no notice before a sync, the notice after it, and the original stops matching.
  const before = await a.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo], { clock: at(0.3) });
  assert.equal(before.lessonNotices, undefined);
  const synced = await sync(a, at(0.3));
  assert.equal(synced.notices.added, 1);
  assert.deepEqual(await matchIds(a, at(0.3)), [result.hub.lessonId]);
  const brief = await a.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo], { clock: at(0.3) });
  assert.deepEqual(brief.lessonNotices.items.map((x) => x.line), ["Your lesson " + ORIGINAL.title + " was replaced by bob: " + REPLACEMENT.title + " [" + result.hub.lessonId + "]"]);
  assert.match(brief.lessonNotices.notice, /not instructions/);
  // The hook's session-start line names the notice briefly.
  await writeKitReceipt(rootsA, { pilotPath: a.path, now: now() });
  const payload = { session_id: "s-author", cwd: repo, hook_event_name: "SessionStart", source: "startup" };
  const chunks = [];
  await main(["hook", "--event", "session-start", "--agent", "claude", "--pilot", a.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now: at(0.3) });
  assert.match(JSON.parse(chunks.join("")).hookSpecificOutput.additionalContext, /1 of your lessons was replaced; run `devtwin lesson notices --scope example`/);
  // A second sync adds nothing. Listing is open to agents; the ack previews, then applies with the fingerprint.
  assert.equal((await sync(a, at(0.4))).notices.added, 0);
  const notices = await a.ok(["lesson", "notices", "--scope", SCOPE]);
  assert.deepEqual(notices.notices.map((x) => [x.predecessorId, x.successorId, x.acked]), [[original, result.hub.lessonId, false]]);
  const ack = await a.ok(["lesson", "notices", "--scope", SCOPE, "--ack"]);
  assert.equal(ack.count, 1);
  assert.equal((await a.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo], { clock: at(0.4) })).lessonNotices.items.length, 1, "the ack preview changes nothing");
  await a.ok(["lesson", "notices", "--scope", SCOPE, "--ack", "--apply", "--plan-fingerprint", ack.fingerprint]);
  assert.equal((await a.ok(["context", "brief", "--scope", SCOPE, "--cwd", repo], { clock: at(0.4) })).lessonNotices, undefined);
  assert.equal((await sync(a, at(0.5))).notices.added, 0, "an acknowledged notice does not come back");
  assert.deepEqual((await a.ok(["lesson", "notices", "--scope", SCOPE])).notices.map((x) => x.acked), [true]);
  // The ack apply is an owner action; listing and supersede-propose stay open to agents.
  assert.equal(ownerAction("claude", { tool_name: "Bash", tool_input: { command: "devtwin lesson notices --scope example --ack --apply --plan-fingerprint x" } }), "lesson notices --apply");
  for (const command of ["devtwin lesson notices --scope example", "devtwin lesson notices --scope example --ack", "devtwin lesson supersede-propose --session s --scope example --predecessor lsn_x --apply"]) assert.equal(ownerAction("claude", { tool_name: "Bash", tool_input: { command } }), null, command);
});

test("lesson supersede concurrent replacements leave one winner and the second fails with STALE_VERSION after its rebase", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" }), c = await machine(t, { handle: "carol" });
  for (const m of [a, b, c]) await m.join(hub);
  const original = await published(a);
  await sync(b);
  await sync(c);
  const fromB = (await b.ok([...supersedeArgs(original), "--apply"])).proposalId;
  const fromC = (await c.ok([...supersedeArgs(original, { lesson: { title: "Batch billing calls", summary: "Do batch billing calls once a minute." } }), "--apply"])).proposalId;
  const planC = await c.ok(accept(fromC));
  const won = { hub: { lessonId: await published(b, fromB) } };
  // carol's clone has not seen bob's replacement, so her push is rejected; the check after the rebase stops it, and
  // the sender drops her held replacement with the reason.
  const headAfterB = await hub.head();
  assert.notEqual((await cloneState(c, hub)).head, headAfterB, "carol's clone has not fetched bob's replacement");
  const accepted = await c.ok([...accept(fromC), "--apply", "--plan-fingerprint", planC.fingerprint]);
  assert.equal(accepted.hub.held, true);
  const sent = await sendHeld(c);
  assert.deepEqual(sent.sent, []);
  assert.deepEqual(sent.dropped.map((x) => [x.lessonId, x.reason, x.stale, x.successorId]), [[accepted.hub.lessonId, "stale", "already-superseded", won.hub.lessonId]]);
  assert.equal((await c.ok(["activity"], { clock: at(30) })).learned.find((x) => x.id === accepted.audit).state, "dropped");
  assert.equal(await hub.head(), headAfterB, "nothing of carol's reached the hub");
  const state = await cloneState(c, hub);
  assert.equal(state.head, state.remote, "carol's local commit is dropped: the clone sits at the remote head");
  assert.equal(state.dirty, "");
  const rootsC = await c.roots();
  assert.deepEqual(await listOutbox(rootsC, await c.binding()), [], "a stale replacement is never queued");
  // After a sync, a new replacement from carol fails at its preview, and every fixture delivers only the winner.
  await sync(c, at(0.2));
  await c.fail(accept(fromC), "DEVTWIN_CONFLICT");
  await sync(a, at(0.2));
  for (const m of [a, b, c]) assert.deepEqual(await matchIds(m, at(0.2)), [won.hub.lessonId], m.handle);
  await c.fail([...supersedeArgs(original, { session: "ses_three" })], "DEVTWIN_CONFLICT");
});

test("lesson supersede raced double push shows both replacements as contested", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" });
  await a.join(hub);
  const original = await published(a);
  const second = await published(a, await propose(a, { session: "ses_more", lesson: { title: "Log billing retries", summary: "Do log each billing retry." } }));
  const hashOf = async (id) => sha256(await hub.show("lessons/" + id + ".md"));
  const successor = (id, author, title, supersedes) => renderHubLesson({ schemaVersion: 1, id, author, title, match: { paths: ["src/billing/**"], packages: [], topics: [] }, createdAt: "2026-10-06T00:00:00.000Z", supersedes }, "Do use the " + title.toLowerCase() + ".\n");
  const fromBob = "lsn_" + "b".repeat(24), fromCarol = "lsn_" + "c".repeat(24), wrongHash = "lsn_" + "d".repeat(24);
  // Both replacements land before either client saw the other; a third names a wrong hash for the second lesson.
  await hub.push({
    ["lessons/" + fromBob + ".md"]: successor(fromBob, "handle:bob", "Billing queue", [{ id: original, hash: await hashOf(original) }]),
    ["lessons/" + fromCarol + ".md"]: successor(fromCarol, "handle:carol", "Billing batch", [{ id: original, hash: await hashOf(original) }]),
    ["lessons/" + wrongHash + ".md"]: successor(wrongHash, "handle:dave", "Billing log", [{ id: second, hash: "sha256:" + "0".repeat(64) }])
  });
  const synced = await sync(a);
  assert.deepEqual(synced.supersession.contested, [{ predecessorId: original, successorIds: [fromBob, fromCarol] }]);
  assert.deepEqual(synced.supersession.ignored, [{ id: wrongHash, predecessorId: second, reason: "hash-mismatch" }]);
  const matches = (await a.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"], { clock: at(0.1) })).matches;
  assert.deepEqual(matches.map((x) => x.id).sort(), [second, fromBob, fromCarol, wrongHash].sort(), "the original stops matching; a wrong-hash replacement is a plain lesson");
  for (const x of matches) {
    const contested = x.id === fromBob || x.id === fromCarol;
    assert.equal(x.contested === true, contested, x.id);
    assert.equal(x.line.startsWith("contested: "), contested, x.line);
  }
  // The author is told about both replacements.
  assert.equal(synced.notices.added, 2);
  const notices = (await a.ok(["lesson", "notices", "--scope", SCOPE])).notices;
  assert.deepEqual(notices.map((x) => [x.successorId, x.contested]).sort(), [[fromBob, true], [fromCarol, true]]);
  // A predecessor that is already replaced cannot be replaced again from this clone.
  const refused = await a.fail(supersedeArgs(original), "DEVTWIN_CONFLICT");
  assert.equal(refused.details.reason, "superseded");
  const read = await readHub((await a.binding()).clone);
  assert.deepEqual(read.superseded.map((x) => [x.id, x.by.map((y) => y.id)]), [[original, [fromBob, fromCarol]]]);
});

test("lesson supersede-propose refuses an unknown or tombstoned predecessor and counts toward the session cap", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await b.fail(supersedeArgs("lsn_" + "e".repeat(24)), "DEVTWIN_HUB_NOT_JOINED");
  await a.join(hub);
  await b.join(hub);
  const original = await published(a);
  const removed = await published(a, await propose(a, { session: "ses_more", lesson: { title: "Removed lesson", summary: "Do remove this later." } }));
  const kept = await published(a, await propose(a, { session: "ses_kept", lesson: { title: "Kept lesson", summary: "Do keep this one." } }));
  // The author's tombstone removes one lesson; a tombstone signed by someone else is not honored.
  await hub.push({
    ["tombstones/" + removed + ".json"]: JSON.stringify({ schemaVersion: 1, id: removed, handle: "alice", createdAt: "2026-10-06T00:00:00.000Z" }),
    ["tombstones/" + kept + ".json"]: JSON.stringify({ schemaVersion: 1, id: kept, handle: "mallory", createdAt: "2026-10-06T00:00:00.000Z" })
  });
  await sync(b);
  const unknown = await b.fail([...supersedeArgs("lsn_" + "e".repeat(24)), "--apply"], "DEVTWIN_NOT_FOUND");
  assert.equal(unknown.details.id, "lsn_" + "e".repeat(24));
  const gone = await b.fail([...supersedeArgs(removed), "--apply"], "DEVTWIN_CONFLICT");
  assert.equal(gone.details.reason, "removed");
  await b.fail(supersedeArgs("rec_notalesson"), "DEVTWIN_INVALID_ID");
  assert.deepEqual((await b.ok(["lesson", "proposals", "--all"])).proposals, [], "a refusal writes nothing");
  // A replacement counts toward the same three-per-session cap as lesson propose.
  await propose(b, { session: "ses_cap", lesson: { title: "First", summary: "Do one." } });
  await propose(b, { session: "ses_cap", lesson: { title: "Second", summary: "Do two." } });
  assert.match((await b.ok([...supersedeArgs(kept, { session: "ses_cap" }), "--apply"])).proposalId, /^prop_/);
  const limit = await b.fail([...supersedeArgs(original, { session: "ses_cap" }), "--apply"], "DEVTWIN_LIMIT");
  assert.equal(limit.details.max, 3);
  await b.fail(["lesson", "propose", "--session", "ses_cap", "--scope", SCOPE, ...fields({ title: "Fourth", summary: "Do four." })], "DEVTWIN_LIMIT");
});

test("lesson supersede accept without the hub-publish consent publishes nothing", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub, { consent: false });
  const original = await published(a);
  await sync(b);
  const id = (await b.ok([...supersedeArgs(original), "--apply"])).proposalId;
  const head = await hub.head();
  const plan = await b.ok(accept(id));
  assert.equal(plan.replaces.title, "Retry the billing client");
  assert.equal((await b.fail([...accept(id), "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_APPROVAL_REQUIRED")).details.consent, "hub-publish");
  assert.equal(await hub.head(), head, "no commit reaches the hub");
  const state = await cloneState(b, hub);
  assert.equal(state.head, head);
  assert.equal(state.dirty, "");
  assert.deepEqual(await listOutbox(await b.roots(), await b.binding()), []);
  assert.deepEqual((await b.ok(["lesson", "proposals"])).proposals.map((x) => [x.id, x.state]), [[id, "pending"]]);
  assert.deepEqual(await matchIds(b), [original], "the original still matches");
});

test("hub outbox drain drops a queued replacement whose predecessor was superseded meanwhile", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" }), c = await machine(t, { handle: "carol" });
  for (const m of [a, b, c]) await m.join(hub);
  const original = await published(a);
  await sync(b);
  await sync(c);
  const fromB = (await b.ok([...supersedeArgs(original), "--apply"])).proposalId;
  const fromC = (await c.ok([...supersedeArgs(original, { lesson: { title: "Batch billing calls", summary: "Do batch billing calls once a minute." } }), "--apply"])).proposalId;
  // carol's push is refused three times, so her replacement waits in the outbox.
  await hub.refusePushes();
  const accepted = await c.applied(accept(fromC));
  const queued = { hub: { lessonId: accepted.hub.lessonId, ...(await sendHeld(c)).sent[0] } };
  assert.equal(queued.hub.state, "outbox");
  assert.match(queued.hub.queued, /^obx_/);
  // bob's replacement lands first.
  await hub.allowPushes();
  await published(b, fromB);
  const head = await hub.head();
  const synced = await sync(c, at(0.2));
  assert.deepEqual(synced.outbox.dropped, [{ id: queued.hub.queued, reason: "stale" }]);
  assert.deepEqual(synced.outbox.pushed, []);
  assert.equal(await hub.head(), head, "the drain pushed nothing");
  assert.ok(!(await hub.files()).includes("lessons/" + queued.hub.lessonId + ".md"));
  assert.deepEqual(await listOutbox(await c.roots(), await c.binding()), []);
  assert.equal((await c.ok(["activity"], { clock: at(0.2) })).learned.find((x) => x.id === accepted.audit).state, "dropped", "the drop moves the audit state");
  const state = await cloneState(c, hub);
  assert.equal(state.head, state.remote);
  assert.deepEqual(await matchIds(c, at(0.2)), [(await b.ok(["lesson", "proposals", "--all"])).proposals[0].outcome.hub.lessonId]);
});
