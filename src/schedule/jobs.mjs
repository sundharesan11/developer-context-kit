// U20 (R10, R30, R31, R34; KTD15, KTD24): the radar, advisory and review jobs. Each job is a user LaunchAgent with its
// own consent (schedule apply, after the owner dialog) and its own off switch (schedule off). A run checks, in order,
// the live gate (the pilot load), the job's own flag and its last-run receipt, and only then makes a request. A
// disabled job makes no request and writes nothing. Turning off the radar also turns off the advisory job.
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { atomicReplace, checkNode, ensurePrivatePath, info, readPrivateJson } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { configuredScopes } from "../records/isolation.mjs";
import { launchAgentPath, renderPlist, installJob, removeJob, launchctlOf, domain } from "./launchd.mjs";
import { notify } from "./notify.mjs";

const DAY = 86400;
export const JOBS = Object.freeze({
  "radar-weekly": { interval: 7 * DAY, skipSeconds: 6 * DAY, runs: "the weekly radar: fetch your approved sources, write one digest for each scope and show a short notification" },
  "advisory-hourly": { interval: 3600, skipSeconds: 3000, requires: "radar-weekly", runs: "a security advisory check for your stack every hour, with a notification at once for an urgent fix (at most three a day)" },
  "review-monthly": { interval: 30 * DAY, skipSeconds: 27 * DAY, runs: "a monthly reminder that a setup review is available, with a count of suggestions" }
});
export const JOB_IDS = Object.freeze(Object.keys(JOBS));
export const OFF_SWITCH = {
  "radar-weekly": "Turning off the radar job stops the weekly fetch, digest and notification. It also turns off the security advisory job. Run stack digest by hand to get a digest.",
  "advisory-hourly": "Turning off the advisory job stops the hourly advisory check and its notifications. The weekly digest still lists advisories when you approved that group.",
  "review-monthly": "Turning off the review job stops the monthly reminder. You can still run the review by hand."
};
export const jobLabel = (job) => "devtwin." + job;
const jobsPath = (roots) => join(roots.stateRoot, "schedule", "jobs.json");
export const receiptPath = (roots, job) => join(roots.stateRoot, "schedule", "receipts", job + ".json");
const alertsPath = (roots) => join(roots.stateRoot, "radar", "alerts.json");
const lockPath = (roots) => join(roots.stateRoot, "locks", "schedule.lock");
const KIT = resolve(import.meta.dirname, "../..");

export function jobFor(id) {
  if (!Object.hasOwn(JOBS, id ?? "")) throw new DevtwinError("INVALID_INPUT", "Unknown job", { field: "job", allowed: JOB_IDS });
  return JOBS[id];
}
async function readJson(path) {
  try { return await readPrivateJson(path, 65536); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function readJobs(roots) {
  const value = await readJson(jobsPath(roots));
  if (value === null) return { schemaVersion: 1, jobs: {} };
  if (value.schemaVersion !== 1 || !value.jobs || typeof value.jobs !== "object" || Array.isArray(value.jobs)) throw new DevtwinError("INTEGRITY", "Job state invalid");
  return value;
}
async function writeJobs(roots, value) {
  ensurePrivatePath(roots.stateRoot, ["schedule", "receipts"]);
  await atomicReplace(jobsPath(roots), canonicalJson(value) + "\n");
}
const readReceipt = (roots, job) => readJson(receiptPath(roots, job));
async function writeReceipt(roots, job, value) {
  ensurePrivatePath(roots.stateRoot, ["schedule", "receipts"]);
  await atomicReplace(receiptPath(roots, job), canonicalJson({ schemaVersion: 1, job, ...value }) + "\n");
}
export function jobArguments(ctx, pilotPath, job) {
  const kit = ctx.pilot?.live?.kitRoot ?? ctx.kitRoot ?? KIT;
  return [process.execPath, join(kit, "bin/devtwin.mjs"), "schedule", "run", "--pilot", resolve(pilotPath), "--job", job];
}

// Install needs what the job reads: a stack approval for the radar and advisory jobs (with the advisories group for
// the advisory job), the stackWatch exception in live mode, and the radar job on before the advisory job.
async function requirements(roots, job, state) {
  if (job === "review-monthly") return;
  const { readStackApproval } = await import("../stack/plan.mjs");
  const approval = await readStackApproval(roots);
  if (!approval) throw new DevtwinError("APPROVAL_REQUIRED", "Approve the stack sources first", { remedy: "stack plan, then stack approve" });
  if (roots.pilot.live && !roots.pilot.exceptions?.stackWatch) throw new DevtwinError("GATE_REQUIRED", "Stack watch needs the stackWatch live-mode exception", { field: "live", reason: "no-live-exception", remedy: "live stack-watch --host <host>" });
  if (job === "advisory-hourly") {
    if (!approval.groups.includes("advisories")) throw new DevtwinError("CONFLICT", "The stack approval has no advisories group", { remedy: "stack plan --with advisories, then stack approve" });
    if (state.jobs["radar-weekly"]?.enabled !== true) throw new DevtwinError("CONFLICT", "Turn on the radar job first", { requires: "radar-weekly" });
  }
}
// The plan for turning one job on (off: false) or off. Turning off the radar lists the advisory job too.
export async function planSchedule(roots, { job, off = false }, ctx) {
  const spec = jobFor(job), state = await readJobs(roots);
  const ids = off && job === "radar-weekly" ? ["radar-weekly", "advisory-hourly"] : [job];
  const actions = ids.map((id) => {
    const label = jobLabel(id), plist = launchAgentPath(roots, label);
    const programArguments = jobArguments(ctx, roots.pilot.path, id);
    return { job: id, action: off ? "remove" : "install", label, plist, interval: JOBS[id].interval, programArguments,
      contentHash: off ? null : sha256(renderPlist({ label, programArguments, interval: JOBS[id].interval })), enabled: state.jobs[id]?.enabled === true };
  });
  if (!off) await requirements(roots, job, state);
  return finalizePlan({ kind: "schedule", job, mode: off ? "off" : "on", actions, runs: off ? null : spec.runs, offSwitch: OFF_SWITCH[job] });
}
const dialogFor = (plan) => ({ title: plan.mode === "on" ? "Turn on the " + plan.job + " job" : "Turn off the " + plan.job + " job", body: [
  ...plan.actions.map((a) => "Launch agent: " + a.plist), "",
  plan.mode === "on" ? "Runs " + plan.runs + "." : "Removes the launch agent" + (plan.actions.length > 1 ? "s. The security advisory job stops too." : "."), "", plan.offSwitch
].join("\n") });
export async function applySchedule(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planSchedule(roots, input, ctx);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, dialogFor(plan));
  return withPilotLock(roots, lockPath(roots), { kind: "schedule-apply" }, async () => {
    const state = await readJobs(roots), results = [];
    for (const action of plan.actions) {
      if (action.action === "remove") {
        results.push({ job: action.job, enabled: false, ...removeJob(roots, ctx, { label: action.label }) });
        state.jobs[action.job] = { enabled: false, label: action.label, plist: null, installedAt: null };
      } else {
        const job = await installJob(roots, ctx, { label: action.label, programArguments: action.programArguments, interval: action.interval, now });
        results.push({ job: action.job, enabled: true, ...job });
        state.jobs[action.job] = { enabled: true, label: action.label, plist: job.plist, installedAt: now().toISOString() };
      }
    }
    await writeJobs(roots, state);
    return { applied: true, job: plan.job, mode: plan.mode, results, offSwitch: plan.offSwitch };
  }, { destinations: [jobsPath(roots)] });
}
// Read-only: for each job, whether it is on, whether its plist is installed, whether launchd has it loaded, and its
// last run. No network call.
export async function scheduleStatus(roots, ctx) {
  const state = await readJobs(roots), run = launchctlOf(ctx), jobs = [];
  for (const id of JOB_IDS) {
    const label = jobLabel(id);
    let plist = null;
    try { plist = launchAgentPath(roots, label); } catch { plist = null; }
    const receipt = await readReceipt(roots, id);
    jobs.push({ job: id, enabled: state.jobs[id]?.enabled === true, label, plist, installed: Boolean(plist && info(plist)),
      loaded: run(["print", domain() + "/" + label])?.status === 0, lastRunAt: receipt?.lastRunAt ?? null, lastAttemptAt: receipt?.lastAttemptAt ?? null,
      result: receipt?.result ?? null, ...(receipt?.code ? { code: receipt.code } : {}) });
  }
  return { jobs };
}

// The work of each job. deps: the stack seams (catalog, request, lookup, resolvePublicRead), shared by every scope.
async function radarWeekly(roots, ctx, deps) {
  const { planDigest, applyDigest } = await import("../stack/digest.mjs");
  const scopes = await configuredScopes(roots);
  if (!scopes.length && roots.pilot.live) throw new DevtwinError("GATE_REQUIRED", "Live radar runs need a scope", { field: "scope", reason: "scope-required" });
  const targets = scopes.length ? scopes.sort() : [null];
  const digests = [], failed = [];
  for (const scope of targets) {
    try {
      const plan = await planDigest(roots, { scope }, deps);
      const done = await applyDigest(roots, { scope, fingerprint: plan.fingerprint });
      const n = plan.counts.new;
      digests.push({ scope, destination: done.destination, items: n.project + n.stack + n.releaseNotes + n.findings + (n.radar ?? 0) });
    } catch (error) {
      if (!(error instanceof DevtwinError)) throw error;
      failed.push({ scope, code: error.code });
    }
  }
  if (!digests.length && failed.length) throw new DevtwinError(failed[0].code.replace(/^DEVTWIN_/, ""), "No digest was written", { failed });
  const items = digests.reduce((sum, d) => sum + d.items, 0);
  const shown = digests.length ? notify(ctx, { title: "devtwin radar", message: "Your weekly digest is ready: " + items + " new items in " + digests.length + (digests.length === 1 ? " digest." : " digests.") }) : null;
  return { digests, failed, notification: shown };
}
async function advisoryHourly(roots, ctx, deps, now) {
  const { runStackCheck } = await import("../stack/check.mjs");
  const { selectAlerts } = await import("../stack/rank.mjs");
  const scopes = (await configuredScopes(roots)).sort();
  // Advisories are about the stack, not a project; one scope's run is enough, and its seen state is not changed.
  const check = await runStackCheck(roots, { scope: scopes[0] ?? null }, { ...deps, only: ["advisories"] });
  const state = await readJson(alertsPath(roots));
  // An alert counts toward the daily cap and is remembered only when the notification was shown, so a failed one is
  // tried again on the next run.
  const { alerts } = selectAlerts(check.findings, state, now());
  const shown = alerts.map((a) => ({ finding: a, ...notify(ctx, { title: "devtwin security advisory", message: a.item + ": " + a.title + " (" + a.severity + "). See " + a.url }) }));
  const { state: next } = selectAlerts(shown.filter((s) => s.shown).map((s) => s.finding), state, now());
  ensurePrivatePath(roots.stateRoot, ["radar"]);
  await atomicReplace(alertsPath(roots), canonicalJson({ schemaVersion: 1, ...next }) + "\n");
  return { advisories: check.findings.filter((f) => f.group === "advisories").length, alerts: shown.map((s) => ({ id: s.finding.id, item: s.finding.item, severity: s.finding.severity, shown: s.shown })) };
}
async function reviewMonthly(roots, ctx) {
  const { listPreferenceProposals } = await import("../prefs/store.mjs");
  const { listProposals } = await import("../lessons/propose.mjs");
  const preferences = (await listPreferenceProposals(roots)).proposals.length, lessons = (await listProposals(roots)).proposals.length;
  const count = preferences + lessons;
  const shown = notify(ctx, { title: "devtwin review", message: "Your monthly setup review is available with " + count + (count === 1 ? " suggestion." : " suggestions.") + " Run devtwin pref proposals and devtwin lesson proposals to see them." });
  return { suggestions: { preferences, lessons }, notification: shown };
}
const WORK = { "radar-weekly": radarWeekly, "advisory-hourly": advisoryHourly, "review-monthly": reviewMonthly };

// The scheduled run. A run within the job's skip window of the last good run is skipped, so missed runs collapse into
// one run, and two runs inside one period write one digest. lastRunAt moves only on success: a failed or interrupted
// run records lastAttemptAt, and the next scheduled run tries again.
export async function runJob(roots, job, { now = () => new Date(), ctx = {}, deps = {} } = {}) {
  const spec = jobFor(job);
  const recent = async () => {
    const state = await readJobs(roots);
    if (state.jobs[job]?.enabled !== true) return { job, skipped: "job-disabled" };
    if (spec.requires && state.jobs[spec.requires]?.enabled !== true) return { job, skipped: spec.requires + "-off" };
    const receipt = await readReceipt(roots, job);
    const since = now().getTime() - Date.parse(receipt?.lastRunAt ?? "");
    return since >= 0 && since < spec.skipSeconds * 1000 ? { job, skipped: "ran-recently", lastRunAt: receipt.lastRunAt } : null;
  };
  const early = await recent();
  if (early) return early;
  return withPilotLock(roots, lockPath(roots), { kind: "schedule-run" }, async () => {
    const skip = await recent();
    if (skip) return skip;
    const at = now().toISOString(), previous = (await readReceipt(roots, job))?.lastRunAt ?? null;
    await writeReceipt(roots, job, { lastRunAt: previous, lastAttemptAt: at, result: "running" });
    try {
      const result = await WORK[job](roots, ctx, { ...deps, cache: new Map(), now }, now);
      await writeReceipt(roots, job, { lastRunAt: at, lastAttemptAt: at, result: "ok" });
      return { job, ranAt: at, ...result };
    } catch (error) {
      await writeReceipt(roots, job, { lastRunAt: previous, lastAttemptAt: at, result: "failed", code: error.code ?? "DEVTWIN_INTERNAL" });
      throw error;
    }
  }, { destinations: [receiptPath(roots, job), alertsPath(roots)] });
}
// A run whose pilot load fails (for example the live gate refuses a moved kit) makes no request. It records a failed
// receipt only when the config names an absolute state root whose schedule receipts folder already exists, private.
export async function recordGateFailure(configPath, job, error, { now = () => new Date() } = {}) {
  try {
    if (!Object.hasOwn(JOBS, job ?? "") || typeof configPath !== "string" || !isAbsolute(configPath)) return false;
    const raw = await readPrivateJson(configPath, 65536);
    if (typeof raw?.stateRoot !== "string" || !isAbsolute(raw.stateRoot) || resolve(raw.stateRoot) !== raw.stateRoot || realpathSync(raw.stateRoot) !== raw.stateRoot) return false;
    const dir = join(raw.stateRoot, "schedule", "receipts");
    checkNode(info(dir), dir, { directory: true });
    const path = join(dir, job + ".json"), node = info(path);
    let previous = null;
    if (node) { checkNode(node, path); previous = await readPrivateJson(path, 65536); }
    const at = now().toISOString();
    await atomicReplace(path, canonicalJson({ schemaVersion: 1, job, lastRunAt: previous?.lastRunAt ?? null, lastAttemptAt: at, result: "failed", code: error?.code ?? "DEVTWIN_INTERNAL" }) + "\n");
    return true;
  } catch { return false; }
}
