// U28 (R6, R7; KTD25, KTD26, KTD27, KTD42): `import run`, the daily promotion importer. Automatic: the import-daily job
// runs it, and an agent or the owner may run it on demand. Who writes (KTD38, KTD43): the import-daily job passes its
// job context (src/schedule/jobs.mjs), so its writes are recorded as the job (actor other, a run_job_ run ID) and the
// agent session caps do not count them. No argument or variable gives a CLI run that context: `import run` writes as
// its caller (cliRecorder, as record add does), under the caller's session and day caps. The first write over a cap
// waits in the activity review (U25), as a capped record add does, and the run stops there; the items after it are
// deferred to a later run. For each onboarded project it reads the Claude Code memory of
// the bound root (src/import/memory.mjs) and the docs/solutions files of the learnings base commit
// (src/import/solutions.mjs), maps each new or changed item (src/import/map.mjs) and writes it as an observed project
// record through the audited write that record add uses: plain-rule, sensitive and scope-name checks, then an audit
// entry, then the record. A user memory becomes a pending preference proposal for the owner's weekly review instead.
//
// A seen file at stateRoot/import/seen.json (0600, atomic replace) maps each source to the hash last handled and the
// record or proposal it became. An unchanged source adds nothing. A changed one supersedes the head of its record's chain,
// but only when that head is still observed: a record the owner confirmed changes only through the owner, so the change
// is skipped and reported. A refused item is reported by source and code, never by content, and is not tried again until
// its text changes. One run writes at most RUN_CAP new items, and runs write at most RUN_CAP a UTC day; the rest wait.
// Preference proposals count toward both: the day count reads the proposal store for the day's imported proposals.
//
// Writes go only inside the store: records and pref proposals in dataRoot; the audit log, the seen file, the import lock,
// summaries and lesson indexes in stateRoot. Memory, transcripts and repositories are only read.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { readRegistry } from "../config/registry.mjs";
import { readBindingVersion } from "../config/store.mjs";
import { samePath } from "../config/pilot.mjs";
import { readPrivateJson, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { deterministicRequestId } from "../storage/plan.mjs";
import { recordIdFor } from "../identity/ids.mjs";
import { MATCH_LIMITS } from "../records/schema.mjs";
import { jobRecorder, cliRecorder } from "../policy/actor.mjs";
import { auditedWrite } from "../records/commands.mjs";
import { addRecord, supersedeRecord, readSnapshot, requireCommittedProject } from "../records/store.mjs";
import { claudeDirFor, projectsDirOf, listFolders, claudeFolderName, worktreesOf, proveFolder, readMemoryFiles } from "./memory.mjs";
import { learningsBase, readSolutions } from "./solutions.mjs";
import { readLearningsSettings } from "../projects/commands.mjs";
import { mapMemory, mapSolution } from "./map.mjs";

export const RUN_CAP = 100;
const ROUTE = "import run", SEEN_BYTES = 4 << 20;
export const seenPath = (roots) => join(roots.stateRoot, "import", "seen.json");
const lockPath = (roots) => join(roots.stateRoot, "locks", "import.lock");
export const newJobRunId = () => "run_job_" + randomBytes(8).toString("hex");

async function readSeen(roots) {
  try {
    const value = await readPrivateJson(seenPath(roots), SEEN_BYTES);
    if (value?.schemaVersion !== 1 || !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) throw new DevtwinError("INTEGRITY", "Import seen file invalid");
    return value;
  } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, sources: {} }; throw error; }
}
async function writeSeen(roots, seen) {
  ensurePrivatePath(roots.stateRoot, ["import"]);
  await atomicReplace(seenPath(roots), canonicalJson(seen) + "\n");
}
// The newest binding entry of each project.
function latestBindings(registry) {
  const latest = new Map();
  for (const entry of registry.bindings) {
    const key = entry.scope + "\0" + entry.project, seen = latest.get(key);
    if (!seen || entry.bindingVersion > seen.bindingVersion) latest.set(key, entry);
  }
  return [...latest.values()].sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
}
const realOrSame = (path) => { try { return realpathSync(path); } catch { return path; } };
// The effective records a chain ends in, following supersededBy from the given record.
function headsOf(records, id) {
  const byId = new Map(records.map((r) => [r.id, r])), heads = [], seen = new Set(), queue = [id];
  while (queue.length) {
    const record = byId.get(queue.shift());
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    if (record.effective !== "superseded") heads.push(record); else queue.push(...record.supersededBy);
  }
  return heads;
}
// Imports written today (UTC) by any run: record writes from the audit log, and preference proposals from their store.
async function importedToday(roots, now) {
  const { readAudit } = await import("../audit/log.mjs");
  const { importedPreferencesOn } = await import("../prefs/store.mjs");
  const day = now().toISOString().slice(0, 10);
  return new Set((await readAudit(roots)).entries.filter((e) => e.route === ROUTE && e.at.slice(0, 10) === day).map((e) => e.requestId)).size + await importedPreferencesOn(roots, day);
}

// Every item to consider, with the per-project reading report.
async function gather(roots, ctx) {
  const { value: registry } = await readRegistry(roots);
  const entries = latestBindings(registry);
  const repos = (roots.pilot?.repos ?? []).map(realOrSame);
  const notOnboarded = repos.filter((repo) => !entries.some((e) => samePath(e.path, repo))).length;
  const projectsDir = projectsDirOf(claudeDirFor(roots.pilot, ctx.env ?? process.env));
  const folders = listFolders(projectsDir);
  const names = new Map();
  for (const e of entries) { const name = claudeFolderName(e.path); names.set(name, [...(names.get(name) ?? []), e.project]); }
  const items = [], projects = [], skipped = [];
  for (const entry of entries) {
    const { scope, project } = entry, report = { scope, project };
    projects.push(report);
    let binding;
    try { await requireCommittedProject(roots, scope, project); binding = await readBindingVersion(roots, entry); }
    catch (error) { report.memory = report.solutions = "unavailable"; report.code = error.code ?? "DEVTWIN_INTERNAL"; continue; }
    const root = entry.path, name = claudeFolderName(root);
    // Memory: only a folder that is this root's alone and whose transcripts stay inside the root and its worktrees.
    if (!projectsDir || !folders.includes(name)) report.memory = "absent";
    else if (names.get(name).length > 1) { report.memory = "ambiguous"; report.reason = "collision"; }
    else {
      const folder = join(projectsDir, name), proof = proveFolder(folder, worktreesOf(root));
      if (!proof.ok) { report.memory = "ambiguous"; report.reason = proof.reason; }
      else {
        const read = await readMemoryFiles(folder);
        report.memory = "read";
        report.memoryFiles = read.items.length;
        for (const s of read.skipped) skipped.push({ source: "memory:" + project + "/" + s.file, reason: s.reason });
        for (const item of read.items) items.push({ scope, project, source: "memory:" + project + "/" + item.file, hash: item.hash, sourceHash: item.hash, map: () => mapMemory(item) });
      }
    }
    // docs/solutions from the learnings base commit, never the working copy. U30: project set records the base ref
    // (src/projects/commands.mjs); the binding's own field is read when no setting exists.
    const settings = await readLearningsSettings(roots, scope, project);
    const base = learningsBase(root, { learningsBase: settings.learningsBase ?? binding.learningsBase });
    if (!base) report.solutions = "no-learnings-base";
    else {
      const read = readSolutions(root, base.commit);
      report.solutions = "read";
      report.solutionsCommit = base.commit;
      report.solutionFiles = read.items.length;
      for (const s of read.skipped) skipped.push({ source: "solutions:" + project + "/" + s.file, reason: s.reason });
      for (const item of read.items) items.push({ scope, project, source: "solutions:" + project + "/" + item.file, hash: item.hash, sourceHash: digest({ commit: base.commit, file: item.file, hash: item.hash }), map: () => mapSolution(item, base.commit) });
    }
  }
  const mapped = new Set(names.keys());
  return { items, projects, skipped, notOnboarded, unmapped: folders.filter((f) => !mapped.has(f)).length };
}

function mergeMatch(mine = {}, theirs = {}) {
  const out = {};
  for (const [key, limit] of Object.entries(MATCH_LIMITS)) {
    const merged = [...new Set([...(mine[key] ?? []), ...(theirs[key] ?? [])])].slice(0, limit);
    if (key !== "commands" || merged.length) out[key] = merged;
  }
  return out;
}
// One record item: add, or supersede the head of its chain. Returns the seen entry, and the written row when it wrote.
async function writeRecord(ctx, item, draft, prior, recordedBy) {
  const { roots } = ctx, { scope, project } = item;
  const requestId = deterministicRequestId("import", { source: item.source, hash: item.hash });
  const recordId = recordIdFor({ scope, project, requestId });
  const records = (await readSnapshot(roots, scope, project)).records;
  // A run that stopped after the record landed: the record is there; only the seen file is behind.
  if (records.some((r) => r.id === recordId)) return { seen: { hash: item.hash, scope, project, recordId, state: "written" } };
  let targets = [], expectHashes = [];
  if (prior?.recordId) {
    const heads = headsOf(records, prior.recordId);
    if (heads.length > 1) return { seen: { ...prior, hash: item.hash, state: "skipped", reason: "branched" }, skip: "branched" };
    const head = heads[0];
    if (head?.kind === "retraction") return { seen: { ...prior, hash: item.hash, state: "skipped", reason: "undone" }, skip: "undone" };
    if (head && head.status !== "observed") return { seen: { ...prior, hash: item.hash, state: "skipped", reason: "owner-reviewed" }, skip: "owner-reviewed" };
    if (head) {
      targets = [head.id]; expectHashes = [head.recordHash];
      // An agent may have sharpened the lesson (a better match block); the new text keeps those match terms.
      if (draft.kind === "lesson" && head.kind === "lesson") draft = { ...draft, match: mergeMatch(draft.match, head.match) };
    }
  }
  const input = { scope, project, requestId, recordedBy, draft };
  const entry = await auditedWrite(ctx, ROUTE, input, undefined, { targets, expectHashes, sourceHash: item.sourceHash });
  const done = targets.length ? await supersedeRecord(roots, { ...input, targets, expectHashes }, { now: ctx.now }) : await addRecord(roots, input, { now: ctx.now });
  return { seen: { hash: item.hash, scope, project, recordId: done.recordId, state: "written" }, written: { source: item.source, recordId: done.recordId, kind: draft.kind, audit: entry.id, ...(targets.length ? { supersedes: targets } : {}) } };
}

// The run. Holds the import lock, so an on-demand run and the daily job never overlap. job is the import-daily job's
// context ({ runId }), which only src/schedule/jobs.mjs passes; without it the run writes as the CLI caller in env.
export async function runImport(roots, { now = () => new Date(), env = process.env, job = null } = {}) {
  const recordedBy = job ? jobRecorder(job.runId) : cliRecorder(env), runId = recordedBy.runId, ctx = { roots, now, env };
  return withPilotLock(roots, lockPath(roots), { kind: "import-run" }, async () => {
    const { items, projects, skipped, notOnboarded, unmapped } = await gather(roots, ctx);
    const seen = await readSeen(roots);
    const budget = Math.max(0, Math.min(RUN_CAP, RUN_CAP - await importedToday(roots, now)));
    const written = [], preferences = [], refused = [], parked = [], scopes = new Set();
    let unchanged = 0, deferred = 0, count = 0, capped = null;
    for (const item of items) {
      const prior = seen.sources[item.source];
      if (prior?.hash === item.hash) { unchanged++; continue; }
      if (count >= budget || capped) { deferred++; continue; }
      const mapped = item.map();
      let next;
      try {
        if (mapped.skip) { skipped.push({ source: item.source, reason: mapped.skip }); next = { ...prior, hash: item.hash, scope: item.scope, project: item.project, state: "skipped", reason: mapped.skip }; }
        else if (mapped.preference) {
          const { proposeImportedPreference } = await import("../prefs/store.mjs");
          const done = await proposeImportedPreference(roots, { ...mapped.preference, source: "memory" }, { now });
          preferences.push({ source: item.source, proposalId: done.proposalId, created: done.created, state: done.state });
          if (done.created) count++;
          next = { hash: item.hash, scope: item.scope, project: item.project, proposalId: done.proposalId, state: "written" };
        } else {
          const done = await writeRecord(ctx, item, mapped.record, prior, recordedBy);
          if (done.skip) skipped.push({ source: item.source, reason: done.skip });
          if (done.written) { written.push(done.written); count++; scopes.add(item.scope); }
          next = done.seen;
        }
      } catch (error) {
        if (!(error instanceof DevtwinError)) throw error;
        // A CLI run over its caller's cap: the write waits in the activity review, and the run stops.
        if (error.code === "DEVTWIN_GATE_REQUIRED" && error.details?.waiting) {
          capped = { bucket: error.details.bucket ?? null, max: error.details.max ?? null };
          parked.push({ source: item.source, waiting: error.details.waiting });
          seen.sources[item.source] = { ...prior, hash: item.hash, scope: item.scope, project: item.project, state: "parked", waiting: error.details.waiting };
          await writeSeen(roots, seen);
          continue;
        }
        // Reported by source and code only. The details hold reason and type names, never text.
        const reason = error.details?.reason ?? error.details?.types?.join(",") ?? null;
        refused.push({ source: item.source, code: error.code, ...(reason ? { reason } : {}) });
        next = { ...prior, hash: item.hash, scope: item.scope, project: item.project, state: "refused", code: error.code };
      }
      seen.sources[item.source] = next;
      await writeSeen(roots, seen);
    }
    // KTD22: lesson indexes see the new lessons (and rebuild the session summaries).
    const { rebuildIndexes } = await import("../lessons/publish.mjs");
    const index = scopes.size ? await rebuildIndexes(roots, [...scopes].sort()) : [];
    return { runId, projects, written, preferences, unchanged, skipped, refused, deferred, notOnboarded, unmapped, index, parked, ...(capped ? { capped } : {}),
      ambiguous: projects.filter((p) => p.memory === "ambiguous").map(({ scope, project, reason }) => ({ scope, project, reason })) };
  }, { destinations: [seenPath(roots)] });
}

// The CLI run: never the job context, so its writes are its caller's.
export const importRunCommand = { options: {}, async run(values, ctx) {
  return runImport(ctx.roots, { now: ctx.now, env: ctx.env ?? process.env });
} };
