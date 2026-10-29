// U9 (one approval): several owner setup steps behind one owner dialog. `setup plan --steps <id,id,...>` (or
// --all-pending, every owner step that is available, not done and not skipped) plans each step with its own preview and
// fingerprint and builds ONE dialog: a title, then one numbered line per change, in apply order. `setup apply` with the
// same flags, --apply and the batch fingerprint shows that dialog once; on Approve it runs each step through the step's
// own apply with the step's own fingerprint. The step's own dialog is not shown: the batch passes an in-process grant
// (src/owner/dialog.mjs) bound to the batch fingerprint, the step and its fingerprint. No argument or environment
// variable can stand for a grant. Before each step the batch plans the step again; a step whose fingerprint changed
// stops the batch with STALE_VERSION, and the error names the steps done and not run.
//
// Order: one live write-classes change first (every hook target, launch agent and backup folder the steps need,
// merged with the classes already approved), then skills, consents, jobs, paths confirm (it hashes the final config)
// and the hooks last. Later steps are planned against the config the first change will write, so their fingerprints
// hold after it runs. A consent shows its full rules in the batch dialog; when the dialog cannot hold them whole, the
// consent leaves the batch (excluded) instead of being cut. Steps that need no owner approval are not batched, and
// hub-join keeps its own dialog. A step whose write-class paths cannot be approved (a symlinked settings file, a
// path with a control character) leaves the batch with a reason; the other steps batch as usual. Each step that ran
// gets one audit entry (kind "setup-batch", target the step) with the batch ID, written after the step succeeded, so
// the log never shows a step the result does not list as done. The batch is always ask: the hook allows setup apply
// from agent shells only for one --step that is not an owner step.
//
// Upgrade fix: after live set-kit, a job that is on still runs the old kit until its plist is written again. A job
// whose plist differs from what its schedule apply would write now (or is missing) is outdated: its job step is not
// done, and its batch line says "Rewrite job ...". Jobs with no setup step (import-daily, activity-weekly,
// learning-send, and the hub sync job of a scope other than --scope) join an --all-pending batch generically as
// job-rewrite-<job> items, through the same schedule plan and apply, after the job steps.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DevtwinError, toJson } from "../errors.mjs";
import { loadPilot, rootsFromPilot } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { displayKitId } from "../kit/identity.mjs";
import { digest } from "../storage/canonical.mjs";
import { requireOwnerApproval, fitsDialog, issueBatchGrant, revokeBatchGrant, BATCH_GRANT } from "../owner/dialog.mjs";
import { UNSAFE_PATH_CHARS } from "../config/roots.mjs";
import { stepById } from "./steps.mjs";

// The apply order. A step's phase never changes with the selection. hook-verify is not an owner step: it is in a batch
// because a config change ends the kit receipt the hook trusts, and a hook install in the same batch makes it needless.
export const BATCH_ORDER = Object.freeze(["write-classes-hooks", "backup-folder", "skills-claude", "skills-codex", "consent-hub", "consent-repo",
  "job-hub-sync", "job-radar", "job-advisories", "job-review-reminder", "job-backup", "paths-confirm", "hooks-claude", "hooks-codex", "hook-verify"]);
const LONG_TEXT = new Set(["consent-hub", "consent-repo"]);
const NOT_BATCHED = { "hub-join": "it joins the hub over the network, and its own dialog shows the hub details and the note consent; run setup apply --step hub-join" };
const NO_APPROVAL = "it needs no owner approval; run setup apply --step with this step, which an agent may run";
// Owner actions that are never in a batch, listed in every batch plan so the owner knows they still ask on their own.
export const SEPARATE = Object.freeze([
  Object.freeze({ command: "live set-kit", reason: "an upgrade runs it from the new kit before anything else, so it comes first and on its own" }),
  Object.freeze({ command: "instructions apply", reason: "its dialog shows the exact instruction block" }),
  Object.freeze({ command: "backup key export", reason: "it prints the backup key once; run it alone in your own terminal" })
]);
const CLASSES = [["hookTargets", "hook-target", "Approve hook settings file "], ["backupTargets", "backup-target", "Approve backup folder "], ["launchAgents", "launch-agent", "Approve launch agent "]];
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const invalid = (message, field = "steps") => { throw new DevtwinError("INVALID_INPUT", message, { field }); };

// The selected step IDs, in the order given. --steps takes a comma list and may repeat.
function selection(values) {
  const all = values["all-pending"] === true, given = list(values.steps);
  if (all === (given.length > 0)) invalid("Give --steps <id,id,...> or --all-pending");
  if (all) return { ids: [...BATCH_ORDER, ...Object.keys(NOT_BATCHED)] };
  const ids = [...new Set(given.flatMap((value) => value.split(",")).map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) invalid("Give --steps <id,id,...> or --all-pending");
  for (const id of ids) stepById(id);
  return { ids };
}
const home = (ctx) => ctx.pilot.live?.home ?? ctx.home;
const tilde = (ctx, path) => typeof path === "string" && home(ctx) && path.startsWith(home(ctx) + "/") ? "~" + path.slice(home(ctx).length) : path;
// Review fix: every dialog line is one line. A control, format or line-separator character in a path or a name is
// shown as \u{...}, so no value can start a line of its own in the dialog.
const UNSAFE_GLOBAL = new RegExp(UNSAFE_PATH_CHARS.source, "gu");
export const oneLine = (text) => String(text).replace(UNSAFE_GLOBAL, (ch) => "\\u{" + ch.codePointAt(0).toString(16) + "}");
const every = (seconds) => ({ 600: "every 10 minutes", 3600: "hourly", 86400: "daily", 604800: "weekly", 2592000: "monthly" })[seconds] ?? "every " + seconds + " seconds";

// The write-class paths the steps need that the config does not approve yet, in step order, and the new classes.
function configChange(steps, ctx) {
  const current = ctx.pilot.writeClasses ?? {}, added = [];
  for (const step of steps) for (const [cls, paths] of Object.entries(step.needs?.(ctx) ?? {})) {
    for (const path of paths) if (!(current[cls] ?? []).includes(path) && !added.some((a) => a.cls === cls && a.path === path)) added.push({ cls, path });
  }
  const set = {};
  for (const [cls] of CLASSES) {
    const extra = added.filter((a) => a.cls === cls).map((a) => a.path);
    if (extra.length) set[cls] = [...new Set([...(current[cls] ?? []), ...extra])];
  }
  return { set, added };
}
const writeClassValues = (ctx, set) => ({ pilot: ctx.values.pilot, ...Object.fromEntries(CLASSES.filter(([cls]) => set[cls]).map(([cls, flag]) => [flag, set[cls]])) });
const writeClasses = async () => (await import("../config/commands.mjs")).liveWriteClassesCommand;
// Review fix: why a step's write-class paths cannot be approved, or null. Each step is checked alone, against the
// config as it is, with the same validation the config change runs, so one bad path excludes only its own step.
async function needsProblem(step, ctx) {
  const { set, added } = configChange([step], ctx);
  if (added.some((a) => UNSAFE_PATH_CHARS.test(a.path))) return "DEVTWIN_PATH_UNSAFE";
  if (!Object.keys(set).length) return null;
  try { await project(ctx, set); return null; }
  catch (error) { return error instanceof DevtwinError ? error.code : "DEVTWIN_INTERNAL"; }
}
const needsExcluded = (code) => ({ code, reason: "a path it needs cannot be approved in the live config: " + code });
// The context the later steps are planned in: the config the change will write and its exact bytes.
async function project(ctx, set) {
  if (!Object.keys(set).length) return { pctx: ctx, preview: null };
  const { projectLiveEditWriteClasses } = await import("../config/live.mjs");
  const p = await projectLiveEditWriteClasses({ configPath: ctx.values.pilot, set, clear: [] }, ctx);
  return { pctx: { ...ctx, pilot: p.pilot, roots: rootsFromPilot(p.pilot), projection: { pilotBytes: p.bytes } }, preview: p.plan };
}
// A step's state: the config steps against the config now, the others against the projected config.
async function stateOf(step, ctx) {
  const { describe } = await import("./commands.mjs");
  const header = await describe(step, ctx);
  if (header.skipped) return { skipped: header.skipped };
  if (header.problem) return { excluded: "its state cannot be read: " + header.problem.code };
  return header.done ? { skipped: "done" } : {};
}

// The dialog lines of one step, from its preview, or { excluded } when the preview holds nothing to approve.
async function linesFor(step, preview, ctx) {
  const t = (path) => tilde(ctx, path);
  if (step.id.startsWith("skills-")) {
    const blocked = preview.actions.filter((a) => ["blocked", "conflict", "modified"].includes(a.status));
    if (blocked.length) return { excluded: "the skill folder has entries devtwin may not change: " + blocked.map((a) => a.skill + " " + a.status).join(", ") };
    const folder = t(dirname(preview.actions[0].path)), names = (status) => preview.actions.filter((a) => a.status === status).map((a) => a.skill);
    return { lines: [["create", "Install skills in "], ["update", "Update skills in "], ["remove", "Remove old devctx skills from "]]
      .filter(([status]) => names(status).length).map(([status, text]) => text + folder + ": " + names(status).join(", ")) };
  }
  if (step.id.startsWith("hooks-")) {
    const action = preview.actions.find((a) => ["create", "update"].includes(a.status));
    if (!action) return { excluded: "the hook file cannot be changed: " + preview.actions.map((a) => a.status + (a.reason ? " " + a.reason : "")).join(", ") };
    const events = [...new Set(action.changes.filter((c) => c.op === "add").map((c) => c.event))];
    const replaces = action.changes.some((c) => c.op === "remove");
    return { lines: [(replaces ? "Replace devtwin hook entries in " : "Add devtwin hook entries to ") + t(action.path) + ": " + events.join(", ") + (action.agent === "codex" ? ". Then trust them in Codex with /hooks" : "")] };
  }
  if (step.id === "job-hub-sync") return { lines: [preview.installed ? rewriteLine(ctx, "hub-sync for scope " + preview.scope, preview.plist, preview.programArguments) : "Install job hub-sync for scope " + preview.scope + " (" + every(preview.interval) + ") at " + t(preview.plist)] };
  if (step.job) return { lines: preview.actions.map((a) => a.enabled ? rewriteLine(ctx, a.job, a.plist, a.programArguments) : "Install job " + a.job + " (" + every(a.interval) + ") at " + t(a.plist)) };
  if (step.id === "hook-verify") return { lines: ["Write the kit receipt that the hook trusts at " + t(preview.receipt)] };
  if (step.id === "paths-confirm") return { lines: ["Confirm kit " + t(preview.kitRoot) + " at " + (preview.kitRef ?? preview.kitHead ?? displayKitId(preview.kitId)) + " and config " + t(preview.pilotPath)] };
  if (LONG_TEXT.has(step.id)) {
    const { grantDialog } = await import("../consent/commands.mjs");
    const text = grantDialog(preview);
    return { lines: ["Grant consent " + preview.consent.kind + " for " + t(preview.consent.target) + ": " + text.title + "."], text: text.body.split("\n") };
  }
  return { excluded: "this step has no batch line yet; run setup apply --step " + step.id };
}
// The kit a job command runs: programArguments[1] is <kit>/bin/devtwin.mjs.
const rewriteLine = (ctx, name, plist, args) => "Rewrite job " + name + " at " + tilde(ctx, plist) + " for kit " + tilde(ctx, dirname(dirname(args[1])));
const STEP_JOBS = ["job-radar", "job-advisories", "job-review-reminder", "job-backup"];
// The outdated jobs no step in this batch covers, as batch items: every schedule job with no setup step, and the hub
// sync job of each joined scope other than the one --scope names (job-hub-sync covers that one).
async function rewriteItems(ctx) {
  const { outdatedJobs } = await import("../schedule/jobs.mjs");
  const stepped = new Set(STEP_JOBS.map((id) => stepById(id).job)), items = [], excluded = [];
  for (const o of await outdatedJobs(ctx.roots, ctx)) {
    if (o.job === "hub-sync" ? o.scope === ctx.values.scope : stepped.has(o.job)) continue;
    const id = "job-rewrite-" + o.job + (o.scope ? "-" + o.scope : "");
    if (o.state === "unsafe") { excluded.push({ id, reason: "its plist cannot be read safely; check " + tilde(ctx, o.plist ?? o.label + ".plist") }); continue; }
    const hub = o.job === "hub-sync";
    const plan = hub ? async (c) => (await import("../hubs/commands.mjs")).hubScheduleCommand.run({ scope: o.scope }, c)
      : async (c) => (await import("../schedule/commands.mjs")).schedulePlanCommand.run({ job: o.job }, c);
    const run = hub ? async (c, fingerprint) => (await import("../hubs/commands.mjs")).hubScheduleCommand.run({ scope: o.scope, apply: true, "plan-fingerprint": fingerprint }, c)
      : async (c, fingerprint) => (await import("../schedule/commands.mjs")).scheduleApplyCommand.run({ job: o.job, "plan-fingerprint": fingerprint }, c);
    let preview;
    try { preview = await plan(ctx); }
    catch (error) { excluded.push({ id, reason: "it cannot be planned: " + toJson(error).code + " " + toJson(error).message }); continue; }
    const lines = hub ? [rewriteLine(ctx, "hub-sync for scope " + o.scope, preview.plist, preview.programArguments)] : preview.actions.map((a) => rewriteLine(ctx, a.job, a.plist, a.programArguments));
    items.push({ id, preview, fingerprint: preview.fingerprint, lines, replan: plan, apply: run });
  }
  return { items, excluded };
}
const bodyFor = (items) => {
  const out = ["Approve runs each change below in this order. Deny changes nothing.", ""];
  let n = 0;
  for (const item of items) for (const [i, line] of item.lines.entries()) {
    out.push(++n + ". " + oneLine(line));
    if (i === item.lines.length - 1) for (const text of item.text ?? []) out.push("    " + oneLine(text));
  }
  return { body: out.join("\n"), count: n };
};
const dialogFor = (items) => {
  const { body, count } = bodyFor(items);
  return { title: "Approve " + count + " setup " + (count === 1 ? "change" : "changes"), body };
};

// Never cut: when the dialog cannot hold every item whole, the items with long text (the consents) leave the batch and
// are reported; when the rest still does not fit, the batch stops with LIMIT. Exported for tests.
export function fitItems(items) {
  let batch = items, dropped = [];
  if (!fitsDialog(dialogFor(batch))) {
    dropped = batch.filter((x) => LONG_TEXT.has(x.id)).map((x) => ({ id: x.id, reason: "its rules do not fit in one dialog with the other steps; run setup apply --step " + x.id }));
    batch = batch.filter((x) => !LONG_TEXT.has(x.id));
  }
  const dialog = dialogFor(batch);
  if (!fitsDialog(dialog)) throw new DevtwinError("LIMIT", "These steps do not fit in one owner dialog; choose fewer with --steps", { field: "steps", steps: batch.map((x) => x.id) });
  return { batch, dialog, dropped };
}
// The batch: its plan (fingerprinted), the dialog, and for each item its replan and apply.
export async function buildBatch(values, ctx) {
  const { ids } = selection(values);
  const excluded = [], skipped = [], keep = [];
  const chosen = BATCH_ORDER.filter((id) => ids.includes(id)).map(stepById);
  for (const id of ids.filter((x) => !BATCH_ORDER.includes(x))) {
    const step = stepById(id), state = step.available === true ? await stateOf(step, ctx) : {};
    if (state.skipped) skipped.push({ id, reason: state.skipped });
    else if (NOT_BATCHED[id]) excluded.push({ id, reason: NOT_BATCHED[id] });
    else excluded.push({ id, reason: step.available === true ? NO_APPROVAL : "it is " + step.available });
  }
  // Config steps are read against the config now; once their change is in the batch they are its first item.
  const configSteps = [], others = [];
  for (const step of chosen.filter((s) => s.config)) {
    const state = await stateOf(step, ctx);
    if (state.skipped) { skipped.push({ id: step.id, reason: state.skipped }); continue; }
    if (state.excluded) { excluded.push({ id: step.id, reason: state.excluded }); continue; }
    const problem = await needsProblem(step, ctx);
    if (problem) excluded.push({ id: step.id, ...needsExcluded(problem) });
    else configSteps.push(step);
  }
  for (const step of chosen.filter((s) => !s.config)) {
    const problem = await needsProblem(step, ctx);
    if (problem) excluded.push({ id: step.id, ...needsExcluded(problem) });
    else others.push(step);
  }
  // Two passes: the steps that still apply under a config with every need approved, then the config they need.
  const first = (await project(ctx, configChange([...configSteps, ...others], ctx).set)).pctx;
  for (const step of others) {
    const state = await stateOf(step, first);
    if (state.skipped) skipped.push({ id: step.id, reason: state.skipped });
    else if (state.excluded) excluded.push({ id: step.id, reason: state.excluded });
    else keep.push(step);
  }
  const change = configChange([...configSteps, ...keep], ctx), { pctx, preview: configPreview } = await project(ctx, change.set);
  const items = [];
  if (configPreview) {
    const set = change.set;
    items.push({ id: "config", covers: configSteps.map((s) => s.id), preview: configPreview, fingerprint: configPreview.fingerprint,
      lines: change.added.map((a) => CLASSES.find(([cls]) => cls === a.cls)[2] + tilde(ctx, a.path)),
      replan: async (c) => (await writeClasses()).run(writeClassValues(c, set), c),
      apply: async (c, fingerprint) => (await writeClasses()).run({ ...writeClassValues(c, set), apply: true, "plan-fingerprint": fingerprint }, c) });
  }
  for (const step of keep) {
    let preview;
    try { preview = await step.plan(pctx); }
    catch (error) { excluded.push({ id: step.id, reason: "it cannot be planned: " + toJson(error).code + " " + toJson(error).message }); continue; }
    if (!preview?.fingerprint) { excluded.push({ id: step.id, reason: "it has nothing to apply" }); continue; }
    const shown = await linesFor(step, preview, pctx);
    if (shown.excluded) { excluded.push({ id: step.id, reason: shown.excluded }); continue; }
    items.push({ id: step.id, preview, fingerprint: preview.fingerprint, lines: shown.lines, ...(shown.text ? { text: shown.text } : {}),
      replan: (c) => step.plan(c), apply: (c, fingerprint) => step.apply(c, fingerprint) });
  }
  if (values["all-pending"] === true) {
    const extra = await rewriteItems(pctx), at = items.findIndex((x) => ["paths-confirm", "hooks-claude", "hooks-codex", "hook-verify"].includes(x.id));
    items.splice(at === -1 ? items.length : at, 0, ...extra.items);
    excluded.push(...extra.excluded);
  }
  if (items.some((x) => x.id.startsWith("hooks-")) && items.some((x) => x.id === "hook-verify")) {
    items.splice(items.findIndex((x) => x.id === "hook-verify"), 1);
    skipped.push({ id: "hook-verify", reason: "the hook install in this batch writes the kit receipt" });
  }
  const { batch, dialog, dropped } = fitItems(items);
  excluded.push(...dropped);
  const plan = finalizePlan({ kind: "setup-batch", items: batch.map(({ id, covers, fingerprint, lines, text, preview }) => ({ id, ...(covers ? { covers } : {}), fingerprint, lines, ...(text ? { text } : {}), preview })),
    dialog: batch.length ? dialog : null, excluded, skipped, separate: SEPARATE });
  return { plan, items: batch };
}

// The live config can change during the batch (the config item), so each step reads it again.
async function reload(ctx) {
  const pilot = await loadPilot(ctx.values.pilot, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot });
  return { ...ctx, pilot, roots: rootsFromPilot(pilot) };
}
export async function applyBatch(values, ctx) {
  if (!values.apply) return { preview: true, ...(await buildBatch(values, ctx)).plan };
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  const { plan, items } = await buildBatch(values, ctx);
  assertFingerprint(plan, values["plan-fingerprint"]);
  if (!items.length) throw new DevtwinError("INVALID_INPUT", "The batch has no step to apply", { field: "steps" });
  await requireOwnerApproval(ctx, plan.dialog);
  const batch = "batch_" + randomBytes(8).toString("hex"), done = [];
  const { appendEntry } = await import("../audit/log.mjs");
  // Every stop is a DevtwinError that names the batch, the step, the steps done and the steps not run. An error that
  // is not a DevtwinError keeps its message under error and becomes INTERNAL.
  const stop = (item, i, error, extra = {}) => new DevtwinError(error instanceof DevtwinError ? error.code : "INTERNAL", "The setup batch stopped at step " + item.id,
    { batch, failed: item.id, error: toJson(error), done: done.map((d) => d.id), notRun: items.slice(i + 1).map((x) => x.id), ...extra });
  let c = ctx;
  for (const [i, item] of items.entries()) {
    let result;
    try {
      c = await reload(c);
      if ((await item.replan(c))?.fingerprint !== item.fingerprint) throw new DevtwinError("STALE_VERSION", "This step changed after the batch was planned", { step: item.id });
      const grant = issueBatchGrant({ batchFingerprint: plan.fingerprint, step: item.id, stepFingerprint: item.fingerprint });
      try { result = await item.apply({ ...c, [BATCH_GRANT]: grant }, item.fingerprint); } finally { revokeBatchGrant(grant); }
    } catch (error) { throw stop(item, i, error); }
    // The audit entry follows the step, so the log names only steps that ran. A step that ran but could not be logged
    // is listed as done, and the batch stops there.
    let entry;
    try {
      entry = await appendEntry(c.roots, { kind: "setup-batch", tier: "always-ask", route: "setup apply", target: item.id, itemIds: [batch], actor: "human",
        requestId: "req_sbt" + digest({ batch, step: item.id }).slice(7, 31) }, { now: c.now });
    } catch (error) {
      done.push({ id: item.id, audit: null, result });
      throw stop(item, i, error, { stage: "audit" });
    }
    done.push({ id: item.id, audit: entry.id, result });
  }
  // Upgrade fix: the derived state follows every batch, so the hook finds bound projects at once. Every step already
  // ran, so a failure here is reported in derived.error and the result still lists them.
  let derived;
  try { derived = await (await import("../lessons/index.mjs")).rebuildDerived((await reload(c)).roots); }
  catch (error) { derived = { error: toJson(error) }; }
  return { applied: true, batch, done, notRun: [], excluded: plan.excluded, skipped: plan.skipped, derived };
}
