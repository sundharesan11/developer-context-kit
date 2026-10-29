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
// hub-join keeps its own dialog. Each step run gets one audit entry (kind "setup-batch", target the step) with the
// batch ID. The batch is always ask: the hook denies setup apply --steps and --all-pending from agent shells.
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DevtwinError, toJson } from "../errors.mjs";
import { loadPilot, rootsFromPilot } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { digest } from "../storage/canonical.mjs";
import { requireOwnerApproval, fitsDialog, issueBatchGrant, revokeBatchGrant, BATCH_GRANT } from "../owner/dialog.mjs";
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
  if (step.id === "job-hub-sync") return { lines: ["Install job hub-sync for scope " + preview.scope + " (" + every(preview.interval) + ") at " + t(preview.plist)] };
  if (step.job) return { lines: preview.actions.map((a) => "Install job " + a.job + " (" + every(a.interval) + ") at " + t(a.plist)) };
  if (step.id === "hook-verify") return { lines: ["Write the kit receipt that the hook trusts at " + t(preview.receipt)] };
  if (step.id === "paths-confirm") return { lines: ["Confirm kit " + t(preview.kitRoot) + " at " + (preview.kitRef ?? preview.kitHead) + " and config " + t(preview.pilotPath)] };
  if (LONG_TEXT.has(step.id)) {
    const { grantDialog } = await import("../consent/commands.mjs");
    const text = grantDialog(preview);
    return { lines: ["Grant consent " + preview.consent.kind + " for " + t(preview.consent.target) + ": " + text.title + "."], text: text.body.split("\n") };
  }
  return { excluded: "this step has no batch line yet; run setup apply --step " + step.id };
}
const bodyFor = (items) => {
  const out = ["Approve runs each change below in this order. Deny changes nothing.", ""];
  let n = 0;
  for (const item of items) for (const [i, line] of item.lines.entries()) {
    out.push(++n + ". " + line);
    if (i === item.lines.length - 1) for (const text of item.text ?? []) out.push("    " + text);
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
  const configSteps = [];
  for (const step of chosen.filter((s) => s.config)) {
    const state = await stateOf(step, ctx);
    if (state.skipped) skipped.push({ id: step.id, reason: state.skipped });
    else if (state.excluded) excluded.push({ id: step.id, reason: state.excluded });
    else configSteps.push(step);
  }
  // Two passes: the steps that still apply under a config with every need approved, then the config they need.
  const others = chosen.filter((s) => !s.config);
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
  let c = ctx;
  for (const [i, item] of items.entries()) {
    try {
      c = await reload(c);
      if ((await item.replan(c))?.fingerprint !== item.fingerprint) throw new DevtwinError("STALE_VERSION", "This step changed after the batch was planned", { step: item.id });
      const entry = await appendEntry(c.roots, { kind: "setup-batch", tier: "always-ask", route: "setup apply", target: item.id, itemIds: [batch], actor: "human",
        requestId: "req_sbt" + digest({ batch, step: item.id }).slice(7, 31) }, { now: c.now });
      const grant = issueBatchGrant({ batchFingerprint: plan.fingerprint, step: item.id, stepFingerprint: item.fingerprint });
      let result;
      try { result = await item.apply({ ...c, [BATCH_GRANT]: grant }, item.fingerprint); } finally { revokeBatchGrant(grant); }
      done.push({ id: item.id, audit: entry.id, result });
    } catch (error) {
      if (!(error instanceof DevtwinError)) throw error;
      throw new DevtwinError(error.code, "The setup batch stopped at step " + item.id, { batch, failed: item.id, error: toJson(error), done: done.map((d) => d.id), notRun: items.slice(i + 1).map((x) => x.id) });
    }
  }
  // Upgrade fix: the derived state follows every batch, so the hook finds bound projects at once.
  const derived = await (await import("../lessons/index.mjs")).rebuildDerived((await reload(c)).roots);
  return { applied: true, batch, done, notRun: [], excluded: plan.excluded, skipped: plan.skipped, derived };
}
