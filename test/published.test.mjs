import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd, readHubBinding } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { rebuildIndex, indexPath } from "../src/lessons/index.mjs";
import { listOutbox } from "../src/hubs/git-write.mjs";
import { sendDue } from "../src/held/send.mjs";
import { renderHubLesson, readHub } from "../src/hubs/read.mjs";
import { NOTE_CLEANUP_BATCH, DELETE_CAVEAT } from "../src/hubs/published.mjs";
import { sha256 } from "../src/storage/canonical.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";

const SCOPE = "example";
const HOUR = 3600 * 1000;
const at = (hours) => () => new Date(now().getTime() + hours * HOUR);
const hex = (seed) => createHash("sha256").update(seed).digest("hex").slice(0, 24);
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
  const commitsSince = async (base) => Number((await fixtureGit(bare, ["rev-list", "--count", base + "..main"])).trim());
  // A colleague (or anyone with push access) writes files straight into the hub. null removes a file.
  const push = async (entries) => {
    await fixtureGit(work, ["pull", "-q", "--rebase", "origin", "main"]);
    for (const [rel, content] of Object.entries(entries)) {
      if (content === null) { await fixtureGit(work, ["rm", "-q", "--", rel]); continue; }
      await mkdir(join(work, rel, ".."), { recursive: true });
      await writeFile(join(work, rel), content);
    }
    await fixtureGit(work, ["add", "-A"]);
    await fixtureGit(work, ["commit", "-q", "-m", "colleague change"]);
    await fixtureGit(work, ["push", "-q", "origin", "main"]);
  };
  const refusePushes = async () => { await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n"); await chmod(join(bare, "hooks", "pre-receive"), 0o755); };
  const allowPushes = () => writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
  return { sb, bare, ssh, remote: "ssh://hub.example.invalid" + bare, files, head, show, commitsSince, push, refusePushes, allowPushes };
}

// One developer machine with a pilot, the scope, a hub root and an injected owner dialog. onboard: an onboarded
// project with a kit receipt, so the hook runs.
async function machine(t, { handle, onboard = false }) {
  const p = await initPilot(t);
  const hubRoot = join(p.pilot.pilotRoot, "hubs");
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot] } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  await applyScopeAdd(await roots(), { scope: SCOPE, hubs: [], policies: [], now });
  let repo = null;
  if (onboard) {
    const r = await roots();
    repo = await makeRepo(join(p.reposDir, "atlas"), { "README.md": "# Fixture\n", "src/billing/client.js": "export {};\n" });
    const input = { scope: SCOPE, project: "example.atlas", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_published01" };
    await applyOnboard(r, r.pilot, input, { fingerprint: (await planOnboard(r, r.pilot, input)).fingerprint, now });
  }
  const dialogs = [];
  let decision = "approved";
  const cli = async (args, { clock = now } = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { now: clock, home: p.fakeHome, env: {}, ownerDialog: async (content) => { dialogs.push(content); return decision; }, notifier: () => ({ status: 0 }), stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  const join_ = async (hub) => {
    const result = await applied(["hub", "join", "--scope", SCOPE, "--remote", hub.remote, "--handle", handle, "--email", handle + "@example.com", "--ssh-command", hub.ssh]);
    // U36: lesson accept --target hub needs the hub-publish consent.
    await applied(["consent", "grant", "--kind", "hub-publish", "--scope", SCOPE]);
    if (onboard) await writeKitReceipt(await roots(), { pilotPath: path, now: now() });
    return result;
  };
  const binding = async () => readHubBinding(await roots(), SCOPE);
  // One in-process hook call; the output is the agent JSON or empty.
  const hookRaw = async (event, body, clock = now) => {
    const chunks = [];
    await main(["hook", "--event", event, "--agent", "claude", "--pilot", path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(body), now: clock });
    return chunks.join("");
  };
  const read = (rel, session) => ({ session_id: session, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(repo, rel) } });
  return { p, path, roots, cli, ok, fail, applied, join: join_, binding, dialogs, setDialog: (value) => { decision = value; }, handle, hookRaw, read, repo };
}

const fields = ({ title, summary, body = "The reason, in one line.\n", paths = ["src/billing/**"] }) => ["--title", title, "--summary", summary, "--body", body, ...paths.flatMap((x) => ["--path", x])];
const ORIGINAL = { title: "Retry the billing client", summary: "Do wrap billing calls in the retry helper." };
const propose = async (m, { session = "ses_one", lesson = ORIGINAL } = {}) => (await m.ok(["lesson", "propose", "--session", session, "--scope", SCOPE, ...fields(lesson), "--apply"])).proposalId;
const accept = (id) => ["lesson", "accept", "--id", id, "--target", "hub"];
const sync = (m, clock = at(0.1)) => m.ok(["hub", "sync", "--scope", SCOPE], { clock });
const matchIds = async (m, clock = at(0.1)) => (await m.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"], { clock })).matches.map((x) => x.id).sort();
const del = (id) => ["published", "delete", "--scope", SCOPE, "--id", id];
const list = (m, clock = at(0.1)) => m.ok(["published", "list", "--scope", SCOPE], { clock });
// The author publishes one lesson to the hub. U41: the accept holds it, and the sender (as the hourly learning-send
// job runs it) publishes it once the 24-hour hold has passed.
async function published(m, options) {
  const result = await m.applied(accept(await propose(m, options)));
  assert.equal(result.hub.held, true);
  const sent = await sendDue(await m.roots(), { now: at(24) });
  assert.deepEqual(sent.sent.map((x) => [x.lessonId, x.state]), [[result.hub.lessonId, "sent"]]);
  return result.hub.lessonId;
}
async function cloneState(m, hub) {
  const clone = (await m.binding()).clone;
  return { head: (await fixtureGit(clone, ["rev-parse", "HEAD"])).trim(), remote: await hub.head(), dirty: (await fixtureGit(clone, ["status", "--porcelain"])).trim() };
}
const lessonFile = (id, author, title, supersedes) => renderHubLesson({ schemaVersion: 1, id, author, title, match: { paths: ["src/billing/**"], packages: [], topics: [] }, createdAt: "2026-10-06T00:00:00.000Z", ...(supersedes ? { supersedes } : {}) }, "Do use the " + title.toLowerCase() + ".\n");
const noteFile = (id, handle, { createdAt, expiresAt }) => JSON.stringify({ schemaVersion: 1, id, handle, area: { paths: ["src/billing"] }, line: handle + " on main touching src/billing", createdAt, expiresAt }) + "\n";
// Relative to now(): an expired note and one still active.
const EXPIRED = { createdAt: "2026-10-03T00:00:00.000Z", expiresAt: "2026-10-06T00:00:00.000Z" };
const ACTIVE = { createdAt: "2026-10-06T12:00:00.000Z", expiresAt: "2026-10-09T12:00:00.000Z" };

test("published delete removes a lesson with a tombstone and a colleague stops matching it after sync", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const lesson = await published(a);
  await sync(b);
  assert.deepEqual(await matchIds(b), [lesson]);
  const plan = await a.ok(del(lesson));
  assert.equal(plan.item.kind, "lesson");
  assert.equal(plan.item.title, ORIGINAL.title);
  assert.deepEqual(plan.removes, ["lessons/" + lesson + ".md"]);
  assert.deepEqual(plan.adds, [{ rel: "tombstones/" + lesson + ".json", handle: "alice" }]);
  const base = await hub.head();
  const result = await a.ok([...del(lesson), "--apply", "--plan-fingerprint", plan.fingerprint], { clock: at(0.2) });
  assert.equal(result.deleted, true);
  assert.equal(result.hub.pushed, true);
  assert.equal(await hub.commitsSince(base), 1, "one commit removes the file and adds the tombstone");
  const files = await hub.files();
  assert.ok(!files.includes("lessons/" + lesson + ".md"));
  assert.deepEqual(JSON.parse(await hub.show("tombstones/" + lesson + ".json")), { schemaVersion: 1, id: lesson, handle: "alice", createdAt: at(0.2)().toISOString() });
  assert.deepEqual(await matchIds(a, at(0.2)), [], "the author's machine stops matching at once");
  assert.deepEqual(await matchIds(b, at(0.2)), [lesson], "the colleague's machine has not synced yet");
  const synced = await sync(b, at(0.3));
  assert.deepEqual(synced.tombstones.seen, [lesson]);
  assert.deepEqual(await matchIds(b, at(0.3)), []);
  await b.fail(["lesson", "show", "--scope", SCOPE, "--id", lesson], "DEVTWIN_NOT_FOUND");
  const listed = await list(a, at(0.3));
  assert.deepEqual(listed.lessons.map((x) => [x.id, x.status]), [[lesson, "tombstoned"]]);
  assert.deepEqual(listed.tombstones.map((x) => x.id), [lesson]);
  // A second delete of the same lesson is refused.
  assert.equal((await a.fail(del(lesson), "DEVTWIN_CONFLICT")).details.reason, "already-deleted");
});

test("published delete tombstone signed by another handle is ignored and the lesson keeps matching", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const lesson = await published(a);
  await sync(b);
  // Anyone with push access can write a tombstone, but it is honored only under the lesson author's handle.
  await hub.push({ ["tombstones/" + lesson + ".json"]: JSON.stringify({ schemaVersion: 1, id: lesson, handle: "mallory", createdAt: "2026-10-06T00:00:00.000Z" }) });
  const synced = await sync(b, at(0.2));
  assert.deepEqual(synced.tombstones.ignored, [{ rel: "tombstones/" + lesson + ".json", reason: "handle-mismatch" }]);
  assert.deepEqual(synced.tombstones.seen, []);
  assert.deepEqual(await matchIds(b, at(0.2)), [lesson]);
  await sync(a, at(0.2));
  const listed = await list(a, at(0.2));
  assert.deepEqual(listed.lessons.map((x) => [x.id, x.status]), [[lesson, "active"]]);
  assert.deepEqual(listed.tombstones, [], "a tombstone under another handle is not the author's");
  // The author's own delete replaces the forged tombstone, and then the lesson stops matching.
  const result = await a.applied(del(lesson), { clock: at(0.3) });
  assert.equal(result.hub.pushed, true);
  assert.equal(JSON.parse(await hub.show("tombstones/" + lesson + ".json")).handle, "alice");
  assert.deepEqual((await sync(b, at(0.4))).tombstones.seen, [lesson]);
  assert.deepEqual(await matchIds(b, at(0.4)), []);
});

test("published list works from a fresh clone with an empty local store", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const kept = await published(a);
  const replaced = await published(a, { session: "ses_two", lesson: { title: "Log billing retries", summary: "Do log each billing retry." } });
  const removed = await published(a, { session: "ses_three", lesson: { title: "Removed lesson", summary: "Do remove this later." } });
  assert.equal((await a.applied(del(removed))).hub.pushed, true);
  const fromBob = "lsn_" + "b".repeat(24), active = "note_" + hex("active"), expired = "note_" + hex("expired"), bobs = "note_" + hex("bob");
  await hub.push({
    ["lessons/" + fromBob + ".md"]: lessonFile(fromBob, "handle:bob", "Billing queue", [{ id: replaced, hash: sha256(await hub.show("lessons/" + replaced + ".md")) }]),
    ["notes/alice/" + active + ".json"]: noteFile(active, "alice", ACTIVE),
    ["notes/alice/" + expired + ".json"]: noteFile(expired, "alice", EXPIRED),
    ["notes/bob/" + bobs + ".json"]: noteFile(bobs, "bob", ACTIVE)
  });
  // A new machine for the same developer: no proposals, no local records, only the hub clone.
  const fresh = await machine(t, { handle: "alice" });
  await fresh.join(hub);
  assert.deepEqual((await fresh.ok(["lesson", "proposals", "--all"])).proposals, []);
  const listed = await list(fresh);
  assert.equal(listed.author, "handle:alice");
  const byId = Object.fromEntries(listed.lessons.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), [kept, replaced, removed].sort(), "only the developer's own lessons");
  assert.deepEqual([byId[kept].status, byId[kept].title, byId[kept].createdAt], ["active", ORIGINAL.title, now().toISOString()]);
  assert.equal(byId[replaced].status, "superseded");
  assert.deepEqual(byId[replaced].replacedBy, [fromBob]);
  assert.equal(byId[removed].status, "tombstoned");
  assert.deepEqual(listed.notes.map((x) => [x.id, x.expired]).sort(), [[active, false], [expired, true]].sort());
  assert.deepEqual(listed.notes.find((x) => x.id === active).area, { paths: ["src/billing"] });
  assert.equal(listed.notes.find((x) => x.id === active).expiresAt, ACTIVE.expiresAt);
  assert.deepEqual(listed.tombstones.map((x) => x.id), [removed]);
  assert.deepEqual(listed.queued, []);
  // A delete that cannot be pushed waits in the outbox, and the list shows it.
  await hub.refusePushes();
  const queued = await fresh.applied(del(active));
  assert.equal(queued.hub.pushed, false);
  assert.match(queued.hub.queued, /^obx_/);
  const again = await list(fresh);
  assert.deepEqual(again.queued, [{ outboxId: queued.hub.queued, kind: "tombstone", createdAt: now().toISOString(), removes: ["notes/alice/" + active + ".json"], adds: [] }]);
});

test("published delete preview shows the Git-history caveat and a denied dialog deletes nothing", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" });
  await a.join(hub);
  const lesson = await published(a);
  const plan = await a.ok(del(lesson));
  assert.equal(DELETE_CAVEAT, "Git history and colleagues' existing clones keep this text; a history rewrite is a manual step for the hub admin.");
  assert.equal(plan.caveat, DELETE_CAVEAT);
  assert.equal(plan.preview, true);
  const head = await hub.head();
  a.setDialog("denied");
  await a.fail([...del(lesson), "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
  const shown = a.dialogs.at(-1).body;
  for (const text of [DELETE_CAVEAT, ORIGINAL.title, "lessons/" + lesson + ".md", "tombstones/" + lesson + ".json"]) assert.ok(shown.includes(text), "dialog shows " + text);
  assert.equal(await hub.head(), head, "no commit reaches the hub");
  const state = await cloneState(a, hub);
  assert.equal(state.head, head);
  assert.equal(state.dirty, "");
  assert.deepEqual(await listOutbox(await a.roots(), await a.binding()), []);
  assert.deepEqual(await matchIds(a), [lesson], "the lesson still matches");
  a.setDialog("approved");
  await a.fail([...del(lesson), "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], "DEVTWIN_PLAN_MISMATCH");
  await a.fail([...del(lesson), "--apply"], "DEVTWIN_PLAN_REQUIRED");
  assert.equal(await hub.head(), head);
});

test("published delete refuses another author's lesson or note", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const lesson = await published(a);
  const note = "note_" + hex("alice-note");
  await hub.push({ ["notes/alice/" + note + ".json"]: noteFile(note, "alice", ACTIVE) });
  await sync(b);
  const head = await hub.head(), seen = b.dialogs.length;
  const other = await b.fail(del(lesson), "DEVTWIN_HUB_PATH_REFUSED");
  assert.equal(other.details.reason, "other-author");
  assert.equal((await b.fail(del(note), "DEVTWIN_HUB_PATH_REFUSED")).details.reason, "other-handle");
  await b.fail(del("lsn_" + "e".repeat(24)), "DEVTWIN_NOT_FOUND");
  await b.fail(del("note_" + "e".repeat(24)), "DEVTWIN_NOT_FOUND");
  await b.fail(del("rec_notapublished"), "DEVTWIN_INVALID_ID");
  assert.equal(b.dialogs.length, seen, "a refused delete shows no dialog");
  assert.equal(await hub.head(), head);
  assert.deepEqual(await matchIds(b), [lesson]);
});

test("published delete of an own contested replacement ends the contest", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const original = await published(a);
  const hash = sha256(await hub.show("lessons/" + original + ".md"));
  const fromBob = "lsn_" + "b".repeat(24), fromCarol = "lsn_" + "c".repeat(24);
  // Both replacements landed before either client saw the other.
  await hub.push({
    ["lessons/" + fromBob + ".md"]: lessonFile(fromBob, "handle:bob", "Billing queue", [{ id: original, hash }]),
    ["lessons/" + fromCarol + ".md"]: lessonFile(fromCarol, "handle:carol", "Billing batch", [{ id: original, hash }])
  });
  await sync(b);
  assert.deepEqual((await list(b)).lessons.map((x) => [x.id, x.status]), [[fromBob, "contested"]]);
  const plan = await b.ok(del(fromBob));
  assert.ok(plan.effects.some((x) => x.includes("Ends the contest") && x.includes(fromCarol)), JSON.stringify(plan.effects));
  assert.equal((await b.ok([...del(fromBob), "--apply", "--plan-fingerprint", plan.fingerprint], { clock: at(0.2) })).hub.pushed, true);
  const synced = await sync(a, at(0.3));
  assert.deepEqual(synced.supersession.contested, []);
  assert.deepEqual(synced.supersession.superseded, [original]);
  const read = await readHub((await a.binding()).clone);
  assert.deepEqual(read.superseded.map((x) => [x.id, x.by.map((y) => y.id)]), [[original, [fromCarol]]]);
  const matches = (await a.ok(["lesson", "match", "--scope", SCOPE, "--path", "src/billing/client.js"], { clock: at(0.3) })).matches;
  assert.deepEqual(matches.map((x) => [x.id, x.contested === true]), [[fromCarol, false]], "the remaining replacement is the single successor");
});

test("published cleanup on hub sync deletes own expired notes and leaves a colleague's", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob" });
  await a.join(hub);
  await b.join(hub);
  const mine = "note_" + hex("mine-expired"), live = "note_" + hex("mine-active"), bobs = "note_" + hex("bob-expired");
  await hub.push({
    ["notes/alice/" + mine + ".json"]: noteFile(mine, "alice", EXPIRED),
    ["notes/alice/" + live + ".json"]: noteFile(live, "alice", ACTIVE),
    ["notes/bob/" + bobs + ".json"]: noteFile(bobs, "bob", EXPIRED)
  });
  const base = await hub.head();
  const synced = await sync(a);
  assert.deepEqual([synced.noteCleanup.deleted, synced.noteCleanup.remaining, synced.noteCleanup.pushed], [1, 0, true]);
  assert.equal(await hub.commitsSince(base), 1, "one commit");
  let files = await hub.files();
  assert.ok(!files.includes("notes/alice/" + mine + ".json"), "own expired note deleted");
  assert.ok(files.includes("notes/alice/" + live + ".json"), "own active note kept");
  assert.ok(files.includes("notes/bob/" + bobs + ".json"), "a colleague's expired note is left in place");
  const head = await hub.head();
  assert.equal((await sync(a, at(0.2))).noteCleanup.deleted, 0);
  assert.equal(await hub.head(), head, "nothing to clean makes no commit");
  // The cleanup is batched: at most NOTE_CLEANUP_BATCH files per sync.
  const many = {};
  for (let i = 0; i <= NOTE_CLEANUP_BATCH; i++) { const id = "note_" + hex("old" + i); many["notes/alice/" + id + ".json"] = noteFile(id, "alice", EXPIRED); }
  await hub.push(many);
  const first = await sync(a, at(0.3));
  assert.deepEqual([first.noteCleanup.deleted, first.noteCleanup.remaining], [NOTE_CLEANUP_BATCH, 1]);
  assert.deepEqual([(await sync(a, at(0.4))).noteCleanup.deleted], [1]);
  files = await hub.files();
  assert.deepEqual(files.filter((f) => f.startsWith("notes/alice/")), ["notes/alice/" + live + ".json"]);
  // A cleanup that cannot push does not fail the sync.
  const late = "note_" + hex("late");
  await hub.push({ ["notes/alice/" + late + ".json"]: noteFile(late, "alice", EXPIRED) });
  await hub.refusePushes();
  const refused = await sync(a, at(0.5));
  assert.equal(refused.fetched, true);
  assert.equal(refused.noteCleanup.pushed, false);
  assert.ok((await hub.files()).includes("notes/alice/" + late + ".json"));
  assert.deepEqual(await listOutbox(await a.roots(), await a.binding()), [], "a failed cleanup is not queued; the next sync tries again");
  const state = await cloneState(a, hub);
  assert.equal(state.head, state.remote);
  // bob's own sync cleans bob's note only.
  await hub.allowPushes();
  assert.equal((await sync(b, at(0.6))).noteCleanup.deleted, 1);
  files = await hub.files();
  assert.ok(!files.includes("notes/bob/" + bobs + ".json"));
  assert.ok(files.includes("notes/alice/" + late + ".json"));
});

test("published delete is denied from an agent shell by the owner-action block", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice", onboard: true });
  await a.join(hub);
  const shell = (command) => ownerAction("claude", { tool_name: "Bash", tool_input: { command } });
  for (const command of ["devtwin published delete --scope example --id lsn_x --apply", "devtwin published delete --scope example --id lsn_x --apply --plan-fingerprint x",
    "sh -c 'node \"$KIT/bin/devtwin.mjs\" published delete --scope example --id note_x --apply'", "script -q /dev/null devtwin published delete --id lsn_x --apply"]) assert.equal(shell(command), "published delete --apply", command);
  assert.equal(ownerAction("codex", { tool_name: "shell", tool_input: { command: ["devtwin", "published", "delete", "--id", "lsn_x", "--apply"] } }), "published delete --apply");
  assert.equal(shell("devtwin published delete --scope example --id lsn_x"), null, "the delete preview stays open to agents");
  assert.equal(shell("devtwin published list --scope example"), null, "listing stays open to agents");
  const out = JSON.parse(await a.hookRaw("pre-tool", { session_id: "s-block", cwd: a.repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "devtwin published delete --scope example --id lsn_x --apply --plan-fingerprint x" } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("published no delivery after a valid tombstone was seen locally, on the hook path", async (t) => {
  const hub = await hubFixture(t), a = await machine(t, { handle: "alice" }), b = await machine(t, { handle: "bob", onboard: true });
  await a.join(hub);
  await b.join(hub);
  const lesson = await published(a);
  const file = await hub.show("lessons/" + lesson + ".md");
  await sync(b);
  assert.ok((await b.hookRaw("pre-tool", b.read("src/billing/client.js", "s-one"), at(0.1))).includes(ORIGINAL.title), "delivered before the delete");
  const path = indexPath(await b.roots(), SCOPE), before = await readFile(path);
  await a.applied(del(lesson));
  assert.deepEqual((await sync(b, at(0.2))).tombstones.seen, [lesson]);
  // A stored index from before the tombstone (for example after a failed rebuild) still lists the lesson; the hook
  // drops it.
  await writeFile(path, before);
  assert.equal(await b.hookRaw("pre-tool", b.read("src/billing/client.js", "s-two"), at(0.2)), "");
  // The lesson file comes back without its tombstone; this machine has seen the tombstone and keeps it out.
  await hub.push({ ["lessons/" + lesson + ".md"]: file, ["tombstones/" + lesson + ".json"]: null });
  const resynced = await sync(b, at(0.3));
  assert.deepEqual(resynced.tombstones.heldBack, [lesson], "the hub has the file again; this machine holds it back");
  assert.deepEqual(await matchIds(b, at(0.3)), []);
  await b.fail(["lesson", "show", "--scope", SCOPE, "--id", lesson], "DEVTWIN_NOT_FOUND");
  await rebuildIndex(await b.roots(), SCOPE);
  assert.equal(await b.hookRaw("pre-tool", b.read("src/billing/client.js", "s-three"), at(0.3)), "");
});
