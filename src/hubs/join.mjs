// U10 (KTD4, KTD9, KTD10, KTD18): hub join, hub leave and hub schedule. Each previews, then applies with the plan
// fingerprint after the owner dialog. Join binds one scope to one hub by its hubId, never by the remote URL.
import { join, relative } from "node:path";
import { mkdirSync, renameSync, rmSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { deepestExisting } from "../config/roots.mjs";
import { loadScope, readHubBinding, writeHubBinding, listHubBindings, hubBindingPath } from "../config/store.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { digest, sha256 } from "../storage/canonical.mjs";
import { info } from "../storage/fsx.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { rebuildIndex } from "../lessons/index.mjs";
import { hubSyncLabel, hubSyncArguments, launchAgentPath, renderPlist, installJob, removeJob, HUB_SYNC_INTERVAL, HUB_SYNC_OFF_SWITCH } from "../schedule/launchd.mjs";
import { HUB_HANDLE, HUB_SCHEMA_VERSION, readHubManifest } from "./read.mjs";
import { hubGit, withHubLock, hubStateDir, listOutbox } from "./git-write.mjs";
import { writeSyncState, requireJoined } from "./sync.mjs";

// KTD10: the note rules that hub join's consent covers. A change to these rules changes the digest, which voids the consent.
export const NOTE_RULES = Object.freeze({
  schemaVersion: 1, maxPaths: 10, paths: "repo-relative paths or package names only",
  line: "built mechanically from the branch name and the changed areas, never from prompt text or agent text",
  lineFormat: "<handle> on <branch> touching <area>, <area>",
  fields: Object.freeze(["area", "line", "handle", "time"]), expiryHours: 72, maxPerSession: 6, poster: "the hook event path only"
});
export const NOTE_RULES_DIGEST = digest(NOTE_RULES);
// U13 posts a note only while this is true.
export const noteConsentValid = (binding) => binding?.status === "joined" && binding.delivery === "on" && binding.noteConsent?.rulesDigest === NOTE_RULES_DIGEST;

const refuseRemote = (reason) => { throw new DevtwinError("HUB_REMOTE_REFUSED", "Hub remote refused: only SSH remotes without a password are allowed", { reason }); };
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const LOGIN = /^[a-z_][a-z0-9._-]{0,31}$/i;
const REMOTE_PATH = /^[A-Za-z0-9._~\/-]{1,400}$/;
// The same user-info shape the secret tripwire refuses (url-userinfo in src/records/redact.mjs).
const USERINFO_WITH_PASS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]*@/i;
// KTD18: an ssh:// URL or an scp-like user@host:path. An SSH login name such as git@ is allowed; a password is not.
export function parseRemote(text) {
  if (typeof text !== "string" || !text || Buffer.byteLength(text) > 512 || /[\s\p{Cc}\p{Cf}]/u.test(text)) refuseRemote("shape");
  if (USERINFO_WITH_PASS.test(text)) refuseRemote("password");
  if (text.includes("://")) {
    let url;
    try { url = new URL(text); } catch { refuseRemote("shape"); }
    if (url.protocol !== "ssh:") refuseRemote("not-ssh");
    if (url.password || (url.username && !LOGIN.test(decodeURIComponent(url.username)))) refuseRemote("userinfo");
    if (url.search || url.hash || text.includes("?") || text.includes("#")) refuseRemote("query");
    if (!HOST.test(url.hostname) || !REMOTE_PATH.test(url.pathname) || url.pathname === "/" || url.pathname.split("/").includes("..")) refuseRemote("shape");
    return { remote: text, host: url.hostname.toLowerCase() };
  }
  const scp = /^(?:([^@:\/]+)@)?([^@:\/]+):(.+)$/.exec(text);
  if (!scp) refuseRemote("not-ssh");
  const [, login, host, path] = scp;
  if (login !== undefined && !LOGIN.test(login)) refuseRemote("userinfo");
  if (!HOST.test(host) || !REMOTE_PATH.test(path) || path.startsWith("-") || path.split("/").includes("..")) refuseRemote("shape");
  return { remote: text, host: host.toLowerCase() };
}
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const SSH_COMMAND = /^[\x20-\x7e]{1,512}$/;
function checkInput({ handle, email, sshCommand }) {
  if (typeof handle !== "string" || !HUB_HANDLE.test(handle)) throw new DevtwinError("INVALID_INPUT", "Invalid hub handle", { field: "handle" });
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email)) throw new DevtwinError("INVALID_INPUT", "Invalid commit email", { field: "email" });
  if (sshCommand !== undefined && (typeof sshCommand !== "string" || !SSH_COMMAND.test(sshCommand) || sshCommand.trim() !== sshCommand)) throw new DevtwinError("INVALID_INPUT", "Invalid SSH command", { field: "ssh-command" });
}
// The approved hub root folder: --hub-root must name one; without it, the first approved one.
function hubRootFor(roots, requested) {
  const approved = roots.pilot?.writeClasses?.hubRoot ?? [];
  if (!approved.length) throw new DevtwinError("GATE_REQUIRED", "No hub root folder approved", { field: "writeClasses.hubRoot", remedy: "live write-classes --hub-root <folder>" });
  if (requested !== undefined && !approved.includes(requested)) throw new DevtwinError("GATE_REQUIRED", "Hub root folder not approved", { field: "hub-root" });
  return requested ?? approved[0];
}
const canonical = (path) => { const at = deepestExisting(path); return join(realpathSync(at), relative(at, path)); };
export const NOTE_CONSENT_TEXT = "Notes: while you work, devtwin may post a short note to this hub with at most " + NOTE_RULES.maxPaths + " repo-relative paths, one line in the form \"" + NOTE_RULES.lineFormat + "\", your handle and the time. A note expires after " + NOTE_RULES.expiryHours + " hours. The line is built from the branch name and changed areas, never from your prompts.";

// Preview: the binding and consent to record. It checks that the remote answers (git ls-remote) and writes nothing.
export async function planJoin(roots, input) {
  const scope = assertScopeId(input.scope);
  await loadScope(roots, scope);
  const { remote, host } = parseRemote(input.remote);
  checkInput(input);
  const existing = await readHubBinding(roots, scope);
  if (existing?.status === "joined") throw new DevtwinError("CONFLICT", "Scope already joined to a hub", { scope, hubId: existing.hubId });
  const hubRoot = hubRootFor(roots, input.hubRoot), clone = join(canonical(hubRoot), scope);
  assertWritable(roots, [hubRoot, clone], { writeClass: "hubRoot" });
  if (info(clone)) throw new DevtwinError("CONFLICT", "Hub clone folder already exists", { clone });
  const probe = hubGit({ sshCommand: input.sshCommand }, ["ls-remote", "--", remote, "HEAD"], { cwd: roots.stateRoot, timeoutMs: 20_000 });
  if (!probe.ok || !/\tHEAD$/m.test(probe.stdout)) throw new DevtwinError("HUB_UNREACHABLE", "Hub remote did not answer", { host });
  return finalizePlan({
    kind: "hub-join", scope, remote, host, handle: input.handle, actorRef: "handle:" + input.handle, email: input.email, sshCommand: input.sshCommand ?? null,
    hubRoot, clone, binding: hubBindingPath(roots, scope),
    noteConsent: { rules: NOTE_RULES, rulesDigest: NOTE_RULES_DIGEST, text: NOTE_CONSENT_TEXT },
    offer: { step: "job-hub-sync", command: "hub schedule --scope " + scope, offSwitch: HUB_SYNC_OFF_SWITCH }
  });
}
const joinDialog = (plan) => ({ title: "Join an organization hub", body: [
  "Scope: " + plan.scope, "Remote: " + plan.remote, "Handle: " + plan.handle + " (commits as " + plan.email + ")",
  "SSH command: " + (plan.sshCommand ?? "default ssh"), "Local copy: " + plan.clone, "", NOTE_CONSENT_TEXT,
  "", "Accepted lessons you publish later go to this hub. Anyone with push access to it can add files."
].join("\n") });
function cloneArgs(remote, target) {
  return ["clone", "-q", "--no-recurse-submodules", "--template=", "--config", "core.symlinks=false", "--config", "core.hooksPath=/dev/null", "--config", "submodule.recurse=false", "--config", "protocol.allow=never", "--config", "protocol.ssh.allow=always", "--", remote, target];
}
export async function applyJoin(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planJoin(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, joinDialog(plan));
  return withHubLock(roots, async () => {
    if ((await readHubBinding(roots, plan.scope))?.status === "joined") throw new DevtwinError("CONFLICT", "Scope already joined to a hub", { scope: plan.scope });
    assertWritable(roots, [plan.hubRoot, plan.clone], { writeClass: "hubRoot" });
    if (!info(plan.hubRoot)) mkdirSync(plan.hubRoot, { mode: 0o700 });
    const root = realpathSync(plan.hubRoot), staging = join(root, ".joining-" + plan.scope + "-" + randomBytes(6).toString("hex"));
    if (join(root, plan.scope) !== plan.clone) throw new DevtwinError("SOURCE_CHANGED", "Hub root folder changed");
    assertWritable(roots, [staging], { writeClass: "hubRoot" });
    const ssh = { sshCommand: plan.sshCommand ?? undefined };
    const cloned = hubGit(ssh, cloneArgs(plan.remote, staging), { cwd: root, timeoutMs: 120_000 });
    try {
      if (!cloned.ok) throw new DevtwinError("HUB_UNREACHABLE", "Hub clone failed", { host: plan.host });
      const manifest = await readHubManifest(staging);
      const head = hubGit({ ...ssh, clone: staging }, ["symbolic-ref", "--short", "HEAD"]);
      const branch = head.ok ? head.stdout.trim() : "";
      if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch) || !hubGit({ ...ssh, clone: staging }, ["rev-parse", "--verify", "-q", "refs/remotes/origin/" + branch]).ok) throw new DevtwinError("HUB_INVALID", "Hub has no default branch");
      const other = (await listHubBindings(roots)).find((b) => b.status === "joined" && b.hubId === manifest.hubId && b.scope !== plan.scope);
      if (other) throw new DevtwinError("CONFLICT", "Hub already joined by another scope", { hubId: manifest.hubId });
      if (info(plan.clone)) throw new DevtwinError("CONFLICT", "Hub clone folder already exists", { clone: plan.clone });
      renameSync(staging, plan.clone);
      const readOnly = manifest.schemaVersion > HUB_SCHEMA_VERSION, at = now().toISOString();
      const binding = { schemaVersion: 1, scope: plan.scope, hubId: manifest.hubId, status: "joined", remote: plan.remote, branch, handle: plan.handle, actorRef: plan.actorRef, email: plan.email, sshCommand: plan.sshCommand,
        clone: plan.clone, readOnly, hubSchemaVersion: manifest.schemaVersion, delivery: "on",
        noteConsent: { rulesDigest: NOTE_RULES_DIGEST, rules: NOTE_RULES, grantedAt: at }, jobs: { hubSync: { enabled: false, label: hubSyncLabel(plan.scope), plist: null, installedAt: null } }, joinedAt: at, leftAt: null };
      await writeHubBinding(roots, binding);
      await writeSyncState(roots, binding.hubId, { lastAttemptAt: at, lastSyncedAt: at, lastResult: "ok" });
      const warnings = readOnly ? [{ code: "HUB_SCHEMA_NEWER", schemaVersion: manifest.schemaVersion, supported: HUB_SCHEMA_VERSION, message: "This hub uses a newer format. devtwin reads nothing from it and writes nothing to it until the kit is upgraded." }] : [];
      const index = await rebuildIndex(roots, plan.scope);
      return { joined: true, scope: plan.scope, hubId: manifest.hubId, clone: plan.clone, branch, readOnly, warnings, index: { written: index.written, counts: index.counts }, offer: plan.offer };
    } catch (error) {
      if (info(staging)) rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  });
}

// Leave: revoke the note consent, remove the job, turn delivery off and delete the clone. Records in the personal
// store, the org home and the projects stay; queued outbox items for this hub are discarded.
export async function planLeave(roots, { scope }) {
  const binding = await requireJoined(roots, assertScopeId(scope));
  const job = binding.jobs?.hubSync ?? {};
  let outbox = 0;
  try { outbox = (await listOutbox(roots, binding)).length; } catch { outbox = -1; }
  return finalizePlan({ kind: "hub-leave", scope: binding.scope, hubId: binding.hubId, removeClone: binding.clone, revokeNoteConsent: true, delivery: "off",
    job: { installed: job.enabled === true, label: job.label ?? hubSyncLabel(binding.scope), plist: job.plist ?? null }, discardOutbox: outbox, offSwitch: HUB_SYNC_OFF_SWITCH,
    keeps: ["personal store records", "org and project records", "the hub itself and everything already pushed"] });
}
const leaveDialog = (plan) => ({ title: "Leave an organization hub", body: [
  "Scope: " + plan.scope, "Hub: " + plan.hubId, "Deletes the local copy: " + plan.removeClone, "Stops notes and lesson delivery, and revokes the note consent.",
  plan.job.installed ? "Removes the hub sync job " + plan.job.label + "." : "No hub sync job is installed.",
  "Your personal records stay. What you already pushed stays in the hub."
].join("\n") });
export async function applyLeave(roots, { scope }, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planLeave(roots, { scope });
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, leaveDialog(plan));
  return withHubLock(roots, async () => {
    const binding = await requireJoined(roots, plan.scope);
    let job = null;
    if (binding.jobs?.hubSync?.enabled || binding.jobs?.hubSync?.plist) job = removeJob(roots, ctx, { label: binding.jobs.hubSync.label ?? hubSyncLabel(binding.scope) });
    assertWritable(roots, [binding.clone], { writeClass: "hubRoot" });
    const node = info(binding.clone);
    if (node && (node.isSymbolicLink() || !node.isDirectory())) throw new DevtwinError("PATH_UNSAFE", "Hub clone folder unsafe");
    if (node) rmSync(binding.clone, { recursive: true });
    const outbox = join(hubStateDir(roots, binding.hubId), "outbox");
    assertWritable(roots, [outbox]);
    rmSync(outbox, { recursive: true, force: true });
    const notesCache = join(hubStateDir(roots, binding.hubId), "notes.json");
    assertWritable(roots, [notesCache]);
    rmSync(notesCache, { force: true });
    await writeHubBinding(roots, { ...binding, status: "left", delivery: "off", noteConsent: null, jobs: { hubSync: { enabled: false, label: hubSyncLabel(binding.scope), plist: null, installedAt: null } }, leftAt: now().toISOString() });
    const index = await rebuildIndex(roots, binding.scope);
    return { left: true, scope: binding.scope, hubId: binding.hubId, cloneRemoved: Boolean(node), job, index: { written: index.written, counts: index.counts } };
  });
}

// hub schedule: install (or with off, remove) the hub-sync LaunchAgent for one scope (KTD15). Its own consent and off switch (R10).
export async function planSchedule(roots, { scope, off = false }, ctx) {
  const binding = await requireJoined(roots, assertScopeId(scope));
  const label = hubSyncLabel(binding.scope), plist = launchAgentPath(roots, label);
  const programArguments = hubSyncArguments(ctx, binding.scope);
  return finalizePlan({ kind: "hub-schedule", scope: binding.scope, hubId: binding.hubId, action: off ? "remove" : "install", label, plist, interval: HUB_SYNC_INTERVAL,
    programArguments, contentHash: off ? null : sha256(renderPlist({ label, programArguments, interval: HUB_SYNC_INTERVAL })), installed: binding.jobs?.hubSync?.enabled === true,
    runs: "hub sync every " + HUB_SYNC_INTERVAL / 60 + " minutes: fetch the hub, push the outbox, rebuild the lesson index", offSwitch: HUB_SYNC_OFF_SWITCH });
}
const scheduleDialog = (plan) => ({ title: plan.action === "install" ? "Turn on the hub sync job" : "Turn off the hub sync job", body: [
  "Scope: " + plan.scope, "Hub: " + plan.hubId, "Launch agent: " + plan.plist,
  plan.action === "install" ? "Runs " + plan.runs + "." : "Removes the launch agent.", "", plan.offSwitch
].join("\n") });
export async function applySchedule(roots, { scope, off = false }, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planSchedule(roots, { scope, off }, ctx);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, scheduleDialog(plan));
  return withHubLock(roots, async () => {
    const binding = await requireJoined(roots, plan.scope);
    if (plan.action === "remove") {
      const job = removeJob(roots, ctx, { label: plan.label });
      await writeHubBinding(roots, { ...binding, jobs: { hubSync: { enabled: false, label: plan.label, plist: null, installedAt: null } } });
      return { enabled: false, ...job, offSwitch: plan.offSwitch };
    }
    const job = await installJob(roots, ctx, { label: plan.label, programArguments: plan.programArguments, interval: plan.interval, now });
    await writeHubBinding(roots, { ...binding, jobs: { hubSync: { enabled: true, label: plan.label, plist: job.plist, installedAt: now().toISOString() } } });
    return { enabled: true, ...job, offSwitch: plan.offSwitch };
  });
}
