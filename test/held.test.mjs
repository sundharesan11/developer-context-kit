import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, chmod, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd, readHubBinding } from "../src/config/store.mjs";
import { listOutbox } from "../src/hubs/git-write.mjs";
import { readAudit } from "../src/audit/log.mjs";
import { listHeld, enqueueHeld, heldRoot } from "../src/held/queue.mjs";
import { sendDue } from "../src/held/send.mjs";

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
  const refusePushes = async () => { await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n"); await chmod(join(bare, "hooks", "pre-receive"), 0o755); };
  const allowPushes = () => writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
  return { bare, ssh, remote: "ssh://hub.example.invalid" + bare, files, head, refusePushes, allowPushes };
}

// One developer machine: a pilot, the scope, a joined hub with the hub-publish consent, an approving owner dialog and
// the notification seam.
async function machine(t, hub, { holdHours } = {}) {
  const p = await initPilot(t);
  const hubRoot = join(p.pilot.pilotRoot, "hubs");
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot] } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  await applyScopeAdd(await roots(), { scope: SCOPE, hubs: [], policies: [], now });
  const dialogs = [], notes = [];
  const cli = async (args, { clock = now } = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { now: clock, home: p.fakeHome, env: {}, ownerDialog: async (content) => { dialogs.push(content); return "approved"; },
      notifier: (args) => { notes.push(args); return { status: 0 }; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  await applied(["hub", "join", "--scope", SCOPE, "--remote", hub.remote, "--handle", "alice", "--email", "alice@example.com", "--ssh-command", hub.ssh]);
  await applied(["consent", "grant", "--kind", "hub-publish", "--scope", SCOPE, ...(holdHours ? ["--hold-hours", String(holdHours)] : [])]);
  let n = 0;
  // An agent proposes a lesson and accepts it to the hub under the consent; it enters the held queue.
  const accept = async ({ title = "Retry the billing client", body = "A billing call can fail once under load.\n", clock = now } = {}) => {
    const id = (await ok(["lesson", "propose", "--session", "ses_held" + ++n, "--scope", SCOPE, "--title", title, "--summary", "Do wrap billing calls in the retry helper.", "--body", body, "--path", "src/billing/**", "--apply"], { clock })).proposalId;
    return applied(["lesson", "accept", "--id", id, "--target", "hub"], { clock });
  };
  const state = async (audit, clock = at(48)) => (await ok(["activity"], { clock })).learned.find((x) => x.id === audit).state;
  return { p, path, roots, cli, ok, fail, applied, accept, state, dialogs, notes };
}

test("held queue: enqueueing sends the notification before sendAfter", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const head = await hub.head();
  const accepted = await m.accept();
  assert.equal(accepted.hub.held, true);
  assert.equal(accepted.hub.sendAfter, at(24)().toISOString());
  assert.deepEqual(accepted.hub.notification, { shown: true });
  // One notification, at once, names the target and the title.
  assert.equal(m.notes.length, 1);
  const [message, title] = m.notes[0].slice(-2);
  assert.equal(title, "devtwin held an item");
  assert.match(message, /hub:example/);
  assert.match(message, /Retry the billing client/);
  assert.equal(await hub.head(), head, "nothing left the machine");
  // The item file is private, under a private folder.
  const roots = await m.roots();
  const [item] = await listHeld(roots);
  assert.deepEqual([item.target, item.kind, item.title, item.audit, item.sendAfter], ["hub:example", "hub-lesson", "Retry the billing client", accepted.audit, accepted.hub.sendAfter]);
  assert.equal((await stat(join(heldRoot(roots), "hub-example", item.id + ".json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(heldRoot(roots), "hub-example"))).mode & 0o777, 0o700);
  // activity --held shows the full text that would leave; plain activity lists it without the text.
  const held = await m.ok(["activity", "--held"]);
  assert.equal(held.counts.held, 1);
  assert.equal(held.held[0].id, item.id);
  assert.match(held.held[0].text, /A billing call can fail once under load\./);
  assert.equal((await m.ok(["activity"])).held[0].text, undefined);
  assert.equal(await m.state(accepted.audit, now), "held");
  // A retried enqueue of the same item writes nothing and notifies no one.
  const again = await enqueueHeld(roots, { target: item.target, kind: item.kind, title: item.title, audit: item.audit, requestId: item.requestId, consent: item.consent, payload: item.payload }, { now: at(1), ctx: { notifier: () => { throw new Error("no second notification"); } } });
  assert.equal(again.queued, false);
  assert.equal((await listHeld(roots)).length, 1);
});

test("held queue: an item due now is sent and its audit entry moves from held to sent", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const accepted = await m.accept();
  assert.equal(await m.state(accepted.audit), "held");
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(24) });
  assert.deepEqual(synced.held.sent.map((x) => [x.lessonId, x.state, x.audit]), [[accepted.hub.lessonId, "sent", accepted.audit]]);
  assert.ok((await hub.files()).includes("lessons/" + accepted.hub.lessonId + ".md"));
  assert.deepEqual(await listHeld(await m.roots()), []);
  assert.equal(await m.state(accepted.audit), "sent");
  // The move is an appended held-state entry linked to the item's entry; the log is never rewritten.
  const { entries } = await readAudit(await m.roots());
  const marker = entries.find((e) => e.kind === "held-state");
  assert.deepEqual([marker.marks, marker.target, marker.route, marker.itemIds[0]], [accepted.audit, "sent", "hub sync", accepted.hub.lessonId]);
  assert.equal((await m.ok(["activity"], { clock: at(24) })).learned.some((x) => x.kind === "held-state"), false, "the marker is not a write of its own");
  // A sent item is removed with published delete, not undo.
  assert.equal((await m.fail(["undo", "--id", accepted.audit], "DEVTWIN_GATE_REQUIRED")).details.via, "published delete");
});

test("held queue: undo of a held item removes it from the queue before it is sent", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const accepted = await m.accept(), head = await hub.head();
  const plan = await m.ok(["undo", "--id", accepted.audit]);
  assert.deepEqual(plan.entries.map((e) => [e.id, e.cancel.held, e.cancel.target]), [[accepted.audit, accepted.hub.heldId, "hub:example"]]);
  const before = m.dialogs.length;
  const result = await m.ok(["undo", "--id", accepted.audit, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(m.dialogs.length, before + 1, "undo is always ask");
  assert.match(m.dialogs.at(-1).body, /cancels the held item "Retry the billing client"/);
  assert.deepEqual(result.undone.map((x) => x.cancelled), [{ held: accepted.hub.heldId }]);
  assert.deepEqual(await listHeld(await m.roots()), []);
  await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(30) });
  assert.equal(await hub.head(), head, "the cancelled item never leaves");
  assert.ok((await m.ok(["activity"], { clock: at(30) })).learned.find((x) => x.id === accepted.audit).undoneBy);
});

test("held queue: an item that failed its push sits in the outbox and undo still cancels it", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const accepted = await m.accept();
  await hub.refusePushes();
  const head = await hub.head();
  // The hourly sender (no fetch) tries the push; the refused push goes to the outbox.
  const sent = await sendDue(await m.roots(), { now: at(24) });
  assert.deepEqual(sent.sent.map((x) => [x.state, x.reason]), [["outbox", "rejected"]]);
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  assert.deepEqual((await listOutbox(roots, binding)).map((x) => x.id), [sent.sent[0].queued]);
  assert.equal(await m.state(accepted.audit), "outbox");
  const plan = await m.ok(["undo", "--id", accepted.audit], { clock: at(25) });
  assert.deepEqual(plan.entries.map((e) => e.cancel), [{ outbox: sent.sent[0].queued, hubId: "example-hub" }]);
  const result = await m.ok(["undo", "--id", accepted.audit, "--apply", "--plan-fingerprint", plan.fingerprint], { clock: at(25) });
  assert.deepEqual(result.undone.map((x) => x.cancelled), [{ outbox: sent.sent[0].queued }]);
  assert.deepEqual(await listOutbox(roots, binding), []);
  // The hub takes pushes again; nothing of the cancelled item goes.
  await hub.allowPushes();
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(26) });
  assert.deepEqual([synced.outbox.pushed, synced.held.sent], [[], []]);
  assert.equal(await hub.head(), head);
});

test("held queue: an item not yet due is left alone", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const accepted = await m.accept(), head = await hub.head();
  const roots = await m.roots();
  const early = await sendDue(roots, { now: at(23) });
  assert.deepEqual(early.kept.map((x) => [x.id, x.reason, x.sendAfter]), [[accepted.hub.heldId, "not-due", accepted.hub.sendAfter]]);
  assert.deepEqual([early.sent, early.dropped], [[], []]);
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(23) });
  assert.deepEqual(synced.held.sent, []);
  assert.equal(await hub.head(), head);
  assert.equal((await listHeld(roots)).length, 1);
  // A repository item goes to the repo sender (U30), which keeps an item that names no repository root.
  const repoTarget = "repo:" + createHash("sha256").update("/example/repo").digest("hex");
  await enqueueHeld(roots, { target: repoTarget, kind: "repo-push", title: "Learning branch", audit: "aud_" + "a".repeat(24), requestId: "req_heldrepo01", consent: { kind: "repo-push", holdHours: 1, ruleDigest: "sha256:" + "0".repeat(64) }, payload: { branch: "devtwin/learning-x" } }, { now, ctx: { notifier: () => ({ status: 0 }) } });
  const later = await sendDue(roots, { now: at(2), target: repoTarget });
  assert.deepEqual(later.kept.map((x) => x.reason), ["invalid"]);
});

test("held queue: an item that fails the isolation check at send time is dropped and reported", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  // The lesson names northwind, which is not a scope yet when it is accepted.
  const accepted = await m.accept({ title: "Billing retries for northwind", body: "The northwind client retries billing calls.\n" });
  const head = await hub.head();
  await applyScopeAdd(await m.roots(), { scope: "northwind", hubs: [], policies: [], now });
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(24) });
  assert.deepEqual(synced.held.dropped.map((x) => [x.lessonId, x.reason, x.state]), [[accepted.hub.lessonId, "isolation", "dropped"]]);
  assert.deepEqual(synced.held.sent, []);
  assert.equal(await hub.head(), head, "the item never left");
  assert.deepEqual(await listHeld(await m.roots()), []);
  assert.deepEqual(await listOutbox(await m.roots(), await readHubBinding(await m.roots(), SCOPE)), []);
  assert.equal(await m.state(accepted.audit), "dropped");
  // undo has nothing left to cancel.
  assert.deepEqual((await m.ok(["undo", "--id", accepted.audit], { clock: at(25) })).skipped, [{ id: accepted.audit, reason: "dropped" }]);
});

test("held queue: a revoked consent cancels its queued items", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub);
  const first = await m.accept({ title: "First held lesson" });
  await hub.refusePushes();
  const outbox = (await sendDue(await m.roots(), { now: at(24) })).sent[0].queued;
  const second = await m.accept({ title: "Second held lesson", clock: at(25) });
  const roots = await m.roots(), binding = await readHubBinding(roots, SCOPE);
  const plan = await m.ok(["consent", "revoke", "--kind", "hub-publish", "--scope", SCOPE], { clock: at(25) });
  assert.deepEqual(plan.held.map((x) => [x.id, x.title]), [[second.hub.heldId, "Second held lesson"]]);
  const revoked = await m.ok(["consent", "revoke", "--kind", "hub-publish", "--scope", SCOPE, "--apply", "--plan-fingerprint", plan.fingerprint], { clock: at(25) });
  assert.match(m.dialogs.at(-1).body, /cancels 1 held item/);
  assert.match(m.dialogs.at(-1).body, /Second held lesson/);
  assert.deepEqual(revoked.cancelled, { held: [second.hub.heldId], outbox: [outbox] });
  assert.deepEqual(await listHeld(roots), []);
  assert.deepEqual(await listOutbox(roots, binding), []);
  for (const audit of [first.audit, second.audit]) assert.equal(await m.state(audit), "cancelled");
  // Nothing goes out after the revoke, even once the hub takes pushes again.
  await hub.allowPushes();
  const head = await hub.head();
  const synced = await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(60) });
  assert.deepEqual([synced.outbox.pushed, synced.held.sent], [[], []]);
  assert.equal(await hub.head(), head);
});

test("held queue: no item leaves before sendAfter", async (t) => {
  const hub = await hubFixture(t), m = await machine(t, hub, { holdHours: 2 });
  const accepted = await m.accept();
  assert.equal(accepted.hub.sendAfter, at(2)().toISOString(), "the consent's hold time sets sendAfter");
  const head = await hub.head();
  // Every sender path, at every time before sendAfter, leaves the item where it is.
  for (const hours of [0, 0.5, 1, 1.99]) {
    assert.deepEqual((await sendDue(await m.roots(), { now: at(hours) })).sent, [], "learning-send at " + hours + " h");
    assert.deepEqual((await m.ok(["hub", "sync", "--scope", SCOPE], { clock: at(hours) })).held.sent, [], "hub sync at " + hours + " h");
    assert.equal(await hub.head(), head);
  }
  assert.deepEqual((await sendDue(await m.roots(), { now: at(2) })).sent.map((x) => x.state), ["sent"]);
  assert.notEqual(await hub.head(), head);
});
