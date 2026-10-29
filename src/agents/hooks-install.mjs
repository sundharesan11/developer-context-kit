import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot, assertWritable, agentDirsFor } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sha256, canonicalJson } from "../storage/canonical.mjs";
import { readPrivateJson, writeNewFile, atomicReplace, ensurePrivatePath, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { RUN_ID } from "../storage/runs.mjs";
import { editOwnedFile, readOwnedText, replaceOwnedEntries } from "../storage/owned-file.mjs";
import { writeKitReceipt, receiptPath, receiptProblem, readPilotBytes } from "../hooks/receipt.mjs";
import { readIndex, rebuildDerived } from "../lessons/index.mjs";
import { SCOPE_ID } from "../identity/ids.mjs";
// U8: devtwin's hook entries in the agent settings files (KTD6, KTD7, KTD9). The only files are the approved
// hookTargets: <claudeDir>/settings.json and ~/.codex/hooks.json. Both use the same shape:
// { "hooks": { "<Event>": [ { "matcher"?: "<regex>", "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] } ] } }.
// An entry is devtwin's only when a completed hook journal of this config wrote it and each of its commands names
// this pilot. Every other entry, including one that looks like devtwin's, is the developer's and is never changed.
export const HOOK_KIND = "hook-bundled";
export const HOOK_INVENTORY = "hook-inventory";
const KIT = fileURLToPath(new URL("../..", import.meta.url));
const AGENTS = ["claude", "codex"], WRITES = ["create", "update", "remove"], TIMEOUT_SECONDS = 10;
const FILES = { claude: "settings.json", codex: "hooks.json" };
// [agent event, devtwin hook event, matcher]. Claude matches tool names exactly; Codex matchers are regexes.
// U33 (KTD32): Stop writes the stop stub and prints nothing. It is added last, so every earlier entry keeps its bytes;
// an install made before it reports Stop as missing (status partial) until the owner installs the hooks again.
export const HOOK_EVENTS = Object.freeze({
  claude: [["SessionStart", "session-start", null], ["UserPromptSubmit", "user-prompt", null], ["PreToolUse", "pre-tool", "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash"], ["PreCompact", "pre-compact", null], ["Stop", "stop", null]],
  codex: [["SessionStart", "session-start", null], ["UserPromptSubmit", "user-prompt", null], ["PreToolUse", "pre-tool", "^(apply_patch|Bash)$"], ["PostToolUse", "post-tool", "^Bash$"], ["PreCompact", "pre-compact", null], ["Stop", "stop", null]]
});
export const CODEX_TRUST_NOTE = { code: "CODEX_HOOK_TRUST", message: "Codex runs a new or changed hook only after you review it. Open Codex, run /hooks, and trust each devtwin entry." };
const UNSAFE_IN_COMMAND = /["$`\\\n\r]/;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const lockPath = (roots) => join(roots.stateRoot, "locks", "install.lock");
const configIdOf = (pilot) => pilot.live?.configId ?? null;
const hashText = (text) => text === null ? null : sha256(Buffer.from(text));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The hook line. It names the kit clone and the pilot only, so a new kit commit in the same clone keeps it byte-identical.
export const hookCommand = ({ kitRoot, pilotPath, event, agent }) => 'node "' + kitRoot + '/bin/devtwin.mjs" hook --event ' + event + " --agent " + agent + ' --pilot "' + pilotPath + '"';
const shapeFor = (pilotPath, agent = "[a-z]+") => new RegExp('^node "/[^"$`\\\\\\n\\r]+/bin/devtwin\\.mjs" hook --event [a-z-]+ --agent ' + agent + ' --pilot "' + escapeRe(pilotPath) + '"$');
const commandsOf = (entry) => isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks.filter(isObject).map((h) => h.command).filter((c) => typeof c === "string") : [];
const devtwinLike = (entry) => commandsOf(entry).some((c) => /devtwin/i.test(c) && /\bhook\b/.test(c));
// The kit and pilot paths the hook line names. In live mode the kit is the live config's pinned clone.
export function hookContext(pilot, kitRoot) {
  const context = { pilotPath: realpathSync(pilot.path), kitRoot: pilot.live ? pilot.live.kitRoot : realpathSync(kitRoot ?? KIT) };
  for (const path of Object.values(context)) if (UNSAFE_IN_COMMAND.test(path)) throw new DevtwinError("INVALID_INPUT", "Path cannot be quoted in a hook command", { field: "hookCommand" });
  return context;
}
export function expectedEntries(agent, context) {
  return Object.fromEntries(HOOK_EVENTS[agent].map(([name, event, matcher]) => [name, [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: hookCommand({ ...context, event, agent }), timeout: TIMEOUT_SECONDS }] }]]));
}
function targets(pilot, { targetHome, agents }) {
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => typeof a !== "string" || !AGENTS.includes(a))) throw new DevtwinError("INVALID_INPUT", "Invalid installer selection");
  let dirs;
  if (pilot.live) {
    if (targetHome !== undefined && targetHome !== pilot.live.home) throw new DevtwinError("GATE_REQUIRED", "Live target must be the live config home", { field: "targetHome" });
    dirs = agentDirsFor({ home: pilot.live.home, env: pilot._context?.env ?? process.env });
  } else {
    assertInPilot(pilot, targetHome, "agentHomes");
    if (targetHome === homedir()) throw new DevtwinError("GATE_REQUIRED", "Real home refused");
    dirs = agentDirsFor({ home: targetHome, env: {} });
  }
  return [...new Set(agents)].sort().map((agent) => ({ agent, path: join(dirs[agent], FILES[agent]) }));
}
// Journals: stateRoot/runs/<runId>/journal.json, shared with the skill installer. An unreadable journal is null.
async function readJournals(stateRoot) {
  let ids = [];
  try { ids = await readdir(join(stateRoot, "runs")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const found = [];
  for (const id of ids.sort()) {
    if (!RUN_ID.test(id) || !info(join(stateRoot, "runs", id, "journal.json"))) continue;
    try { found.push({ id, journal: await readPrivateJson(join(stateRoot, "runs", id, "journal.json")) }); } catch { found.push({ id, journal: null }); }
  }
  return found;
}
export const isHookKind = (journal) => journal?.kind === HOOK_KIND;
export const isHookJournal = (pilot, id, j) => isHookKind(j) && j.configId === configIdOf(pilot) && j.schemaVersion === 1 && j.runId === id && ["install", "uninstall"].includes(j.mode)
  && Array.isArray(j.intended) && Array.isArray(j.started) && Array.isArray(j.completed)
  && j.intended.every((e) => isObject(e) && AGENTS.includes(e.agent) && typeof e.path === "string" && WRITES.includes(e.status) && isObject(e.entries));
export const hookJournalFinished = (j) => j.closed === true || j.intended.every((_, i) => j.completed.includes(i));
const key = (path, event, entry) => path + "\n" + event + "\n" + canonicalJson(entry);
// Every entry a completed hook journal of this config wrote, and the commands in them.
function ledger(pilot, journals) {
  const entries = new Set(), commands = new Set();
  for (const { id, journal } of journals) {
    if (!isHookJournal(pilot, id, journal)) continue;
    for (const i of journal.completed) {
      const e = journal.intended[i];
      if (!e) continue;
      for (const [event, list] of Object.entries(e.entries)) for (const entry of Array.isArray(list) ? list : []) { entries.add(key(e.path, event, entry)); for (const c of commandsOf(entry)) commands.add(c); }
    }
  }
  return { entries, commands };
}
// Per agent event: installed (devtwin's entries equal the expected ones), outdated (devtwin's entries differ, such as an
// earlier kit clone), missing, modified (an entry with devtwin's command was edited) or foreign-entry (an exact copy
// devtwin did not write). Entries that only look like devtwin's are listed in foreign and left alone.
function analyze(text, { agent, path, owned, expected, context }) {
  let root;
  try { root = text === null ? {} : JSON.parse(text); } catch { return { conflict: "invalid-json" }; }
  if (!isObject(root) || (root.hooks !== undefined && !isObject(root.hooks))) return { conflict: "unexpected-shape" };
  const shape = shapeFor(context.pilotPath, agent), ours = new Set(Object.values(expected).flat().flatMap(commandsOf));
  const events = [], foreign = [];
  for (const [name] of HOOK_EVENTS[agent]) {
    const list = Object.hasOwn(root.hooks ?? {}, name) ? root.hooks[name] : [];
    if (!Array.isArray(list)) return { conflict: "unexpected-shape" };
    const mine = [], marks = new Set();
    list.forEach((entry, index) => {
      const commands = commandsOf(entry);
      if (owned.entries.has(key(path, name, entry)) && commands.length && commands.every((c) => shape.test(c))) mine.push(entry);
      else if (canonicalJson(entry) === canonicalJson(expected[name][0])) marks.add("foreign-entry");
      else if (commands.some((c) => ours.has(c) || owned.commands.has(c))) marks.add("modified");
      else if (devtwinLike(entry)) foreign.push({ event: name, index, reason: "devtwin-like-entry" });
    });
    const status = marks.has("modified") ? "modified" : marks.has("foreign-entry") ? "foreign-entry" : !mine.length ? "missing" : canonicalJson(mine) === canonicalJson(expected[name]) ? "installed" : "outdated";
    events.push({ event: name, status, mine });
  }
  return { root, events, foreign };
}
function serialize(root, text) {
  const indent = /\n([ \t]+)"/.exec(text ?? "")?.[1] ?? "  ";
  return JSON.stringify(root, null, indent) + (text && !text.endsWith("\n") ? "" : "\n");
}
// The new file text: devtwin's entries replaced by the expected ones (install) or removed (uninstall). Every other
// entry stays in place. Uninstall also drops an event list, and then the hooks object, that it left empty.
function rewrite(text, { agent, path, owned, expected, mode }) {
  let out = text, emptied = [];
  for (const [name] of HOOK_EVENTS[agent]) {
    const fresh = mode === "install" ? structuredClone(expected[name]) : [];
    const mine = (entry) => owned.entries.has(key(path, name, entry));
    if (mode === "uninstall") {
      const list = out === null ? [] : JSON.parse(out).hooks?.[name];
      if (!Array.isArray(list) || !list.some(mine)) continue;
      emptied.push(name);
    }
    out = replaceOwnedEntries(out, { path: ["hooks", name], owns: (entry) => fresh.includes(entry) || mine(entry), entries: fresh });
  }
  if (mode === "uninstall" && emptied.length) {
    const root = JSON.parse(out);
    for (const name of emptied) if (Array.isArray(root.hooks[name]) && !root.hooks[name].length) delete root.hooks[name];
    if (!Object.keys(root.hooks).length) delete root.hooks;
    out = serialize(root, text);
  }
  return out;
}
const readTarget = (path) => { try { return { text: readOwnedText(path) }; } catch (error) { if (error instanceof DevtwinError) return { error: error.code }; throw error; } };
async function analyzeAll(pilot, input) {
  const list = targets(pilot, input), context = hookContext(pilot, input.kitRoot);
  const owned = ledger(pilot, await readJournals(pilot.stateRoot)), approved = pilot.writeClasses?.hookTargets ?? [];
  return { context, owned, rows: list.map(({ agent, path }) => {
    const expected = expectedEntries(agent, context), base = { agent, path, expected };
    if (!approved.includes(path)) return { ...base, blocked: "not-approved" };
    const parent = info(dirname(path));
    if (!parent?.isDirectory() || parent.isSymbolicLink()) return { ...base, blocked: "agent-folder-missing" };
    const read = readTarget(path);
    if (read.error) return { ...base, conflict: read.error === "DEVTWIN_LIMIT" ? "file-too-large" : "unsafe-file" };
    const seen = analyze(read.text, { agent, path, owned, expected, context });
    return { ...base, text: read.text, ...seen };
  }) };
}
const eventRows = (events) => events.map(({ event, status }) => ({ event, status }));
export async function planHooks(pilot, { targetHome, agents, mode = "install", kitRoot }) {
  if (!["install", "uninstall"].includes(mode)) throw new DevtwinError("INVALID_INPUT", "Invalid installer selection");
  const { context, owned, rows } = await analyzeAll(pilot, { targetHome, agents, kitRoot });
  const actions = rows.map((row) => {
    const { agent, path, expected } = row, base = { agent, path };
    if (row.blocked) return { ...base, status: "blocked", reason: row.blocked };
    if (row.conflict) return { ...base, status: "conflict", reason: row.conflict };
    const before = hashText(row.text), events = eventRows(row.events), foreign = row.foreign;
    const blocking = row.events.find((e) => ["modified", "foreign-entry"].includes(e.status));
    if (mode === "install" && blocking) return { ...base, status: "conflict", reason: blocking.status, before, events, foreign };
    if (mode === "uninstall" && !row.events.some((e) => e.mine.length)) return { ...base, status: "absent", before, events, foreign };
    const after = rewrite(row.text, { agent, path, owned, expected, mode });
    if (row.text !== null && after === row.text) return { ...base, status: "installed", before, events, foreign };
    const changes = row.events.flatMap((e) => {
      const keep = mode === "install" && e.status === "installed";
      return keep ? [] : [...e.mine.map((entry) => ({ event: e.event, op: "remove", entry })), ...(mode === "install" ? expected[e.event].map((entry) => ({ event: e.event, op: "add", entry })) : [])];
    });
    return { ...base, status: row.text === null ? "create" : mode === "install" ? "update" : "remove", before, after: hashText(after), events, changes, foreign };
  });
  const notes = actions.some((a) => a.agent === "codex" && mode === "install") ? [CODEX_TRUST_NOTE] : [];
  return finalizePlan({ kind: "hook-install", mode, configId: configIdOf(pilot), pilotPath: context.pilotPath, kitRoot: context.kitRoot, agents: actions.map((a) => a.agent), receipt: mode === "install" ? receiptPath(pilot.stateRoot) : null, actions, notes });
}
// The pre-apply inventory of one hook target. Devtwin rows are entries whose commands all name this pilot; foreign
// rows keep only a hash of the entry, so the store holds no copy of the developer's own commands.
export function inventoryHookFile(agent, path, pilotPath) {
  const read = readTarget(path), shape = shapeFor(pilotPath);
  if (read.error) return { agent, path, existed: true, unreadable: true, sha256: null, devtwin: [], foreign: [] };
  if (read.text === null) return { agent, path, existed: false, sha256: null, devtwin: [], foreign: [] };
  const row = { agent, path, existed: true, sha256: hashText(read.text), devtwin: [], foreign: [] };
  let root;
  try { root = JSON.parse(read.text); } catch { return { ...row, invalid: true }; }
  for (const [event, list] of Object.entries(isObject(root?.hooks) ? root.hooks : {})) for (const entry of Array.isArray(list) ? list : []) {
    const commands = commandsOf(entry);
    if (commands.length && commands.every((c) => shape.test(c))) row.devtwin.push({ event, entry });
    else row.foreign.push({ event, sha256: sha256(Buffer.from(canonicalJson(entry ?? null))) });
  }
  return row;
}
// faults.afterInventory and faults.afterEdit are test seams: a crash after the inventory, and after one file's edit.
export async function applyHooks(roots, pilot, input, { fingerprint, runId, now = new Date() }, { faults = {} } = {}) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new DevtwinError("INVALID_ID", "Invalid run ID");
  assertFingerprint(await planHooks(pilot, input), fingerprint);
  const runDir = join(roots.stateRoot, "runs", runId), journalPath = join(runDir, "journal.json"), inventoryPath = join(runDir, "inventory.json");
  const result = await withPilotLock(roots, lockPath(roots), { kind: "hook-install", runId }, async () => {
    const { incompleteInstallRuns } = await import("./install.mjs");
    if ((await incompleteInstallRuns(pilot)).length) throw new DevtwinError("RECOVERY_REQUIRED", "Incomplete installer journal");
    const plan = await planHooks(pilot, input);
    assertFingerprint(plan, fingerprint);
    const { owned } = await analyzeAll(pilot, input), context = { pilotPath: plan.pilotPath, kitRoot: plan.kitRoot };
    const intended = plan.actions.filter((a) => WRITES.includes(a.status));
    if (intended.length) {
      assertWritable(roots, [journalPath, inventoryPath]);
      ensurePrivatePath(roots.stateRoot, ["runs"]);
      try { await mkdir(runDir, { mode: 0o700 }); }
      catch (error) { if (error.code === "EEXIST") throw new DevtwinError("CONFLICT", "Run ID already exists"); throw error; }
      const files = plan.actions.filter((a) => a.status !== "blocked").map((a) => inventoryHookFile(a.agent, a.path, plan.pilotPath));
      await writeNewFile(inventoryPath, canonicalJson({ schemaVersion: 1, kind: HOOK_INVENTORY, runId, configId: configIdOf(pilot), mode: plan.mode, pilotPath: plan.pilotPath, recordedAt: now.toISOString(), files }) + "\n");
      await faults.afterInventory?.();
      const entries = intended.map((a) => ({ agent: a.agent, path: a.path, status: a.status, before: a.before, after: a.after, entries: plan.mode === "install" ? expectedEntries(a.agent, context) : {} }));
      const journal = { schemaVersion: 1, kind: HOOK_KIND, configId: configIdOf(pilot), runId, mode: plan.mode, planFingerprint: fingerprint, intended: entries, started: [], completed: [] };
      const save = () => atomicReplace(journalPath, canonicalJson(journal) + "\n");
      await save();
      for (const [i, entry] of entries.entries()) {
        journal.started.push(i);
        await save();
        const expected = expectedEntries(entry.agent, context);
        await editOwnedFile(roots, { path: entry.path, writeClass: "hookTargets", runId, edit: (text) => {
          if (hashText(text) !== entry.before) throw new DevtwinError("STALE_VERSION", "Hook file changed during apply");
          const next = rewrite(text, { agent: entry.agent, path: entry.path, owned, expected, mode: plan.mode });
          if (hashText(next) !== entry.after) throw new DevtwinError("STALE_VERSION", "Hook file changed during apply");
          return next;
        } });
        await faults.afterEdit?.(entry);
        journal.completed.push(i);
        await save();
      }
    }
    // Install refreshes the kit receipt, which the hook trusts in place of the full pilot load.
    const receipt = plan.mode === "install" ? await writeKitReceipt(roots, { pilotPath: pilot.path, kitRoot: input.kitRoot, now }) : null;
    return { applied: intended.length > 0, runId: intended.length ? runId : null, actions: plan.actions, receipt: receipt ? receipt.path : null, notes: plan.notes };
  }, { destinations: [runDir] });
  // Upgrade fix: the hook finds a bound project through the lesson index, so an install rebuilds every scope's index
  // and session summaries after the lock is released. An upgraded install then works at once (src/lessons/index.mjs).
  return result.receipt ? { ...result, derived: await rebuildDerived(roots) } : result;
}
// Recovery of one started, unfinished entry, from the file's hash against the journal's before and after hashes.
export function hookRecoveryFor(entry) {
  const read = readTarget(entry.path);
  if (read.error) return { op: "hold", reason: "unsafe-file", observed: null };
  const observed = hashText(read.text);
  if (observed === entry.after) return { op: "hook-complete", observed };
  if (observed === entry.before) return { op: "hook-unapplied", observed };
  return { op: "hold", reason: "unmatched-file", observed };
}
// A repository root bound in two or more scopes. The hook gives such a root no lessons.
async function ambiguousRoots(stateRoot) {
  let names;
  try { names = await readdir(join(stateRoot, "lessons")); } catch { return []; }
  const byRoot = new Map();
  for (const scope of names.filter((n) => n.endsWith(".json") && SCOPE_ID.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort()) {
    let index;
    try { index = await readIndex({ stateRoot }, scope); } catch { continue; }
    for (const r of Array.isArray(index?.roots) ? index.roots : []) {
      if (typeof r?.root !== "string") continue;
      if (!byRoot.has(r.root)) byRoot.set(r.root, new Set());
      byRoot.get(r.root).add(r.scope ?? scope);
    }
  }
  return [...byRoot].filter(([, scopes]) => scopes.size > 1).map(([root, scopes]) => ({ code: "AMBIGUOUS_ROOT", root, scopes: [...scopes].sort(), message: "This repository root is bound in more than one scope, so the hook gives it no lessons." }));
}
const overall = (events) => {
  const set = new Set(events.map((e) => e.status));
  for (const status of ["modified", "foreign-entry"]) if (set.has(status)) return status;
  return set.size === 1 ? [...set][0] : set.has("outdated") ? "outdated" : "partial";
};
// Read-only: each agent's hook entries, the kit receipt and the notes an owner needs.
export async function hookStatus(pilot, { targetHome, kitRoot, now = new Date() }) {
  const { context, rows } = await analyzeAll(pilot, { targetHome, agents: AGENTS, kitRoot });
  const agents = rows.map((row) => ({ agent: row.agent, path: row.path,
    status: row.blocked ?? row.conflict ?? overall(row.events), ...(row.events ? { events: eventRows(row.events), foreign: row.foreign } : {}) }));
  let receipt;
  try { receipt = (await receiptProblem(pilot.stateRoot, { pilotPath: context.pilotPath, pilotBytes: readPilotBytes(context.pilotPath), kitRoot, now })) ?? "ok"; } catch { receipt = "invalid"; }
  const notes = [...(agents.some((a) => a.agent === "codex" && a.events) ? [CODEX_TRUST_NOTE] : []), ...await ambiguousRoots(pilot.stateRoot)];
  return { agents, receipt, notes };
}
// Rollback check for a hook install run: devtwin's entries now must equal those before the run; foreign entries are listed.
function diff(before, now) {
  const tag = (rows) => { const seen = new Map(); return rows.map((row) => { const id = canonicalJson(row); const n = (seen.get(id) ?? 0) + 1; seen.set(id, n); return [id + "#" + n, row]; }); };
  const a = new Map(tag(before)), b = new Map(tag(now)), out = [];
  for (const [id, row] of a) if (!b.has(id)) out.push({ change: "removed", row });
  for (const [id, row] of b) if (!a.has(id)) out.push({ change: "added", row });
  return out;
}
export function hookRollbackCheck(pilot, inventory, runId) {
  const valid = inventory?.schemaVersion === 1 && inventory.runId === runId && typeof inventory.pilotPath === "string" && ["install", "uninstall"].includes(inventory.mode) && Array.isArray(inventory.files)
    && inventory.files.every((f) => AGENTS.includes(f?.agent) && typeof f.path === "string" && Array.isArray(f.devtwin) && Array.isArray(f.foreign));
  if (!valid) throw new DevtwinError("INTEGRITY", "Invalid install inventory", { runId });
  if (inventory.configId !== configIdOf(pilot)) throw new DevtwinError("GATE_REQUIRED", "Inventory belongs to another live config", { runId });
  if (inventory.mode !== "install") throw new DevtwinError("INVALID_INPUT", "Rollback check needs an install run", { runId });
  const approved = pilot.writeClasses?.hookTargets ?? [];
  const files = inventory.files.map((before) => {
    if (!approved.includes(before.path)) throw new DevtwinError("GATE_REQUIRED", "Inventory names a file outside this live config", { agent: before.agent });
    const now = inventoryHookFile(before.agent, before.path, inventory.pilotPath);
    return { agent: before.agent, path: before.path, existedBefore: before.existed, existsNow: now.existed, devtwin: diff(before.devtwin, now.devtwin), foreign: diff(before.foreign, now.foreign) };
  });
  const report = { runId, kind: HOOK_INVENTORY, recordedAt: inventory.recordedAt, files };
  if (files.some((f) => f.devtwin.length)) throw new DevtwinError("ROLLBACK_MISMATCH", "Hook file differs from its install inventory", report);
  return { status: "ok", ...report };
}
