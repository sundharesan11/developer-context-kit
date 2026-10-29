// U9 (KTD13): the setup steps as data. Each step has a what, a why and an undo, and a plan/apply pair that wraps the
// existing preview and apply of the command it stands for, so `setup plan|apply`, the `devtwin setup` terminal loop and
// the devtwin-setup skill show the same consent screens. A step for a later phase is listed as "not available yet".
// ctx: { roots, pilot, values, now, home, env, kitRoot }. values are the setup flags; each step reads only its own.
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { agentDirsFor } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { readRegistry } from "../config/registry.mjs";
import { CODEX_TRUST_NOTE } from "../agents/hooks-install.mjs";
import { receiptPath, receiptProblem, readPilotBytes } from "../hooks/receipt.mjs";
import { readPersonalSnapshot, addPersonalRecord } from "../records/personal.mjs";
import { personalRecordIdFor, SCOPE_ID } from "../identity/ids.mjs";
import { planSandbox, applySandbox, sandboxDone } from "./sandbox.mjs";

const AGENTS = ["claude", "codex"];
const SKILL_FOLDERS = { claude: "~/.claude/skills", codex: "~/.agents/skills" };
const HOOK_FILES = { claude: "settings.json", codex: "hooks.json" };
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const pick = (values, keys) => Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
const agentsCmd = async () => (await import("../agents/commands.mjs"));
// An agent step does not apply to an agent the live config leaves out.
const agentSkip = (agent) => (ctx) => ctx.pilot.live && !Object.hasOwn(ctx.pilot.live.skillDirs, agent) ? "agent not in the live config" : null;
const settled = (actions, ok) => Array.isArray(actions) && actions.length > 0 && actions.every((a) => ok.includes(a.status));
const pilotPathOf = (ctx) => realpathSync(ctx.pilot.path);

// Live folder check: read-only guidance. devtwin never creates ~/.devtwin; the owner runs live init and init.
const initialized = (ctx) => existsSync(join(ctx.roots.configRoot, "user.json"));
const liveFolder = {
  id: "live-folder", title: "Live config folder", available: true, guidance: true,
  what: "Checks that the live config exists and that init has run in its store. This step only reads.",
  why: "devtwin keeps all private state in a folder that you create at mode 0700, usually ~/.devtwin. devtwin never creates that folder for you.",
  undo: "Nothing to undo. This step writes nothing.",
  plan: (ctx) => ({ guidance: true, live: Boolean(ctx.pilot.live), pilot: ctx.pilot.path, store: ctx.pilot.pilotRoot, initialized: initialized(ctx),
    steps: ["mkdir -m 700 ~/.devtwin, then clone and pin the kit in ~/.devtwin/kit (docs/LIVE.md)", "live init --pilot <live.json> --agent <agent> --repo <repo>, preview then apply", "init --pilot <live.json> --actor <actor-ref> --apply"] }),
  apply: () => { throw new DevtwinError("INVALID_INPUT", "This setup step has nothing to apply", { field: "step" }); },
  done: (ctx) => initialized(ctx)
};

function skillsStep(agent) {
  const values = (ctx) => ({ agent: [agent], ...pick(ctx.values, ["home"]) });
  return {
    id: "skills-" + agent, title: "Skills for " + agent, available: true, owner: true, skip: agentSkip(agent),
    what: "Installs the bundled devtwin skills (devtwin-onboard, devtwin-resume, devtwin-record, devtwin-capture) as devtwin-* entries in " + SKILL_FOLDERS[agent] + ". Runs agents install --agent " + agent + ".",
    why: "The skills let the " + agent + " agent onboard projects, resume project context and record decisions through devtwin.",
    undo: "agents uninstall --agent " + agent + " removes only the entries that devtwin wrote. agents rollback-check compares the folder with the inventory taken before the install.",
    plan: async (ctx) => (await agentsCmd()).agentsInstallCommand.run(values(ctx), ctx),
    apply: async (ctx, fingerprint) => (await agentsCmd()).agentsInstallCommand.run({ ...values(ctx), ...pick(ctx.values, ["run-id"]), apply: true, "plan-fingerprint": fingerprint }, ctx),
    done: async (ctx) => settled((await (await agentsCmd()).agentsInstallCommand.run(values(ctx), ctx)).actions, ["installed", "preserve"])
  };
}

// The hook settings files of the agents in the live config.
export function hookTargetsFor(ctx) {
  const dirs = agentDirsFor({ home: ctx.pilot.live.home, env: ctx.env ?? process.env });
  return AGENTS.filter((agent) => Object.hasOwn(ctx.pilot.live.skillDirs, agent)).map((agent) => join(dirs[agent], HOOK_FILES[agent]));
}
// U9 (one approval): needs(ctx) names the write-class paths a step needs approved in the live config. A setup batch
// (src/setup/batch.mjs) merges them into one live write-classes change that runs before every other step.
const launchAgentFor = (ctx, label) => join(ctx.pilot.live.home, "Library/LaunchAgents", label + ".plist");
const writeClassesHooks = {
  id: "write-classes-hooks", title: "Approve the hook settings files", available: true, owner: true, config: true,
  needs: (ctx) => ctx.pilot.live ? { hookTargets: hookTargetsFor(ctx) } : {},
  skip: (ctx) => ctx.pilot.live ? null : "a disposable pilot lists its hook targets in the pilot file",
  what: "Adds the agent hook settings files (~/.claude/settings.json and ~/.codex/hooks.json) to the hookTargets write class of the live config. Runs live write-classes --hook-target for each file. Other classes stay as they are.",
  why: "devtwin edits an agent settings file only when you approved that exact path in the live config. The hook steps need this approval.",
  undo: "live write-classes --clear hookTargets, through preview and apply, removes the approval. Run agents uninstall --hooks first to remove the hook entries.",
  plan: async (ctx) => {
    const current = ctx.pilot.writeClasses?.hookTargets ?? [], targets = [...new Set([...current, ...hookTargetsFor(ctx)])];
    return (await import("../config/commands.mjs")).liveWriteClassesCommand.run({ pilot: ctx.values.pilot, "hook-target": targets }, ctx);
  },
  apply: async (ctx, fingerprint) => {
    const current = ctx.pilot.writeClasses?.hookTargets ?? [], targets = [...new Set([...current, ...hookTargetsFor(ctx)])];
    return (await import("../config/commands.mjs")).liveWriteClassesCommand.run({ pilot: ctx.values.pilot, "hook-target": targets, apply: true, "plan-fingerprint": fingerprint }, ctx);
  },
  done: (ctx) => Boolean(ctx.pilot.live) && hookTargetsFor(ctx).every((path) => (ctx.pilot.writeClasses?.hookTargets ?? []).includes(path))
};

function hooksStep(agent) {
  const values = (ctx) => ({ agent: [agent], hooks: true, ...pick(ctx.values, ["home"]) });
  const file = agent === "claude" ? "~/.claude/settings.json" : "~/.codex/hooks.json";
  return {
    id: "hooks-" + agent, title: "Hooks for " + agent, available: true, owner: true, skip: agentSkip(agent),
    needs: (ctx) => ctx.pilot.live ? { hookTargets: hookTargetsFor(ctx).filter((path) => path.endsWith("/" + HOOK_FILES[agent])) } : {},
    what: "Adds devtwin's hook entries to " + file + ". Runs agents install --hooks --agent " + agent + ". Other entries in the file stay." + (agent === "codex" ? " " + CODEX_TRUST_NOTE.message : ""),
    why: "The hook gives the agent matching lessons at the moment it touches an area, and denies owner-only devtwin commands from agent shells.",
    undo: "agents uninstall --hooks --agent " + agent + " removes only devtwin's entries. A backup of the file is kept in the run folder.",
    plan: async (ctx) => (await agentsCmd()).agentsInstallCommand.run(values(ctx), ctx),
    apply: async (ctx, fingerprint) => (await agentsCmd()).agentsInstallCommand.run({ ...values(ctx), ...pick(ctx.values, ["run-id"]), apply: true, "plan-fingerprint": fingerprint }, ctx),
    done: async (ctx) => settled((await (await agentsCmd()).agentsInstallCommand.run(values(ctx), ctx)).actions, ["installed"])
  };
}

// hook verify has no preview of its own; this plan names the one file it writes, so its apply still needs a fingerprint.
const receiptPlan = (ctx) => finalizePlan({ kind: "setup-hook-verify", receipt: receiptPath(ctx.pilot.stateRoot), pilotPath: pilotPathOf(ctx) });
async function receiptState(ctx) {
  try { return (await receiptProblem(ctx.pilot.stateRoot, { pilotPath: pilotPathOf(ctx), pilotBytes: ctx.projection?.pilotBytes ?? readPilotBytes(pilotPathOf(ctx)), kitRoot: ctx.kitRoot, now: ctx.now() })) ?? "ok"; }
  catch { return "invalid"; }
}
const hookVerify = {
  id: "hook-verify", title: "Hook verify", available: true,
  what: "Writes the kit receipt that the hook trusts, in the store at state/hooks/kit-receipt.json. Runs hook verify.",
  why: "The hook runs only for a kit and a live config whose receipt is current. A hook install writes it too. Run this step again after a kit upgrade or when the receipt expires.",
  undo: "Nothing to undo outside the store. The receipt expires by itself after 30 days, unless the paths-confirm step keeps it current.",
  plan: async (ctx) => ({ ...receiptPlan(ctx), current: await receiptState(ctx) }),
  apply: async (ctx, fingerprint) => {
    assertFingerprint(receiptPlan(ctx), fingerprint);
    return (await import("../hooks/commands.mjs")).hookVerifyCommand.run({ pilot: ctx.values.pilot }, ctx);
  },
  done: async (ctx) => await receiptState(ctx) === "ok"
};

// U27 (KTD35): the confirmed kit and config paths. An owner step: the hook denies its apply from agent shells, and the
// apply shows the owner dialog with both paths.
const pathsCmd = () => import("../paths/confirm.mjs");
const pathsConfirm = {
  id: "paths-confirm", title: "Confirm the kit and config paths", available: true, owner: true,
  what: "Records the real paths of the kit and the live config, the kit's Git HEAD and the SHA-256 of the config in the store at state/confirmed-paths.json. Runs paths confirm.",
  why: "While the kit and the config stay the same, the hook says so at session start, skills stop asking you to confirm the paths, and the hook keeps the kit receipt current.",
  undo: "Nothing to undo outside the store. A kit upgrade or a config change ends the confirmation; run this step again to confirm the new paths.",
  plan: async (ctx) => (await pathsCmd()).pathsConfirmCommand.run({}, ctx),
  apply: async (ctx, fingerprint) => (await pathsCmd()).pathsConfirmCommand.run({ apply: true, "plan-fingerprint": fingerprint }, ctx),
  done: async (ctx) => (await (await pathsCmd()).pathsCheckCommand.run({}, ctx)).state === "confirmed"
};

const PROFILE_FLAGS = ["work", "stack-current", "stack-known", "preference", "writing", "seed-from-init", "proposed-by"];
const profileCmd = async () => (await import("../profile/commands.mjs"));
const profile = {
  id: "profile", title: "Personal profile", available: true,
  what: "Writes your private personal profile: kind of work, working preferences and stack, under the store's config root (profile). Runs profile plan and profile apply with the profile flags you give.",
  why: "Agents read the profile to match how you like to work. It stays on this machine.",
  undo: "A new profile apply with a field set to an empty value clears it. devtwin keeps the earlier revisions.",
  plan: async (ctx) => (await profileCmd()).profilePlanCommand.run(pick(ctx.values, PROFILE_FLAGS), ctx),
  apply: async (ctx, fingerprint) => (await profileCmd()).profileApplyCommand.run({ ...pick(ctx.values, PROFILE_FLAGS), "plan-fingerprint": fingerprint }, ctx),
  done: async (ctx) => ((await (await profileCmd()).profileShowCommand.run({}, ctx)).generation ?? 0) > 0
};

// Starter preferences: a fixed, reviewed set. Setup stores the ones the owner selects as personal preference records.
export const STARTER_PREFERENCES = Object.freeze([
  { id: "tests-first", title: "Run the tests before saying done", body: "Run the project's tests and report the result before saying that a task is done.\n" },
  { id: "ask-destructive", title: "Ask before destructive commands", body: "Ask before a command that deletes data, rewrites Git history or force-pushes.\n" },
  { id: "small-changes", title: "Keep changes small", body: "Prefer small changes that are easy to review. Split a large change into steps and say what each step does.\n" },
  { id: "explain-why", title: "Give the reason for a change", body: "Give the reason for each change, not only what changed.\n" }
]);
const STARTER_RUN = "run_setup_starter";
const starterRequest = (id) => "req_setup_starter_" + id;
async function ownerRef(ctx) {
  try { return (await readPrivateJson(join(ctx.roots.configRoot, "user.json"))).actorRefs?.[0] ?? null; } catch { return null; }
}
async function starterPlan(ctx) {
  const chosen = list(ctx.values.starter);
  if (chosen.some((id) => !STARTER_PREFERENCES.some((s) => s.id === id))) throw new DevtwinError("INVALID_INPUT", "Unknown starter preference", { field: "starter" });
  const selected = chosen.length ? STARTER_PREFERENCES.filter((s) => chosen.includes(s.id)) : STARTER_PREFERENCES;
  const reviewer = await ownerRef(ctx), existing = new Set((await readPersonalSnapshot(ctx.roots)).records.map((r) => r.requestId));
  const records = selected.map((s) => ({ starter: s.id, requestId: starterRequest(s.id), recordId: personalRecordIdFor({ requestId: starterRequest(s.id) }), title: s.title, body: s.body, status: reviewer ? "confirmed" : "observed", exists: existing.has(starterRequest(s.id)) }));
  return finalizePlan({ kind: "setup-starter-preferences", destination: { root: "dataRoot", path: "personal/records" }, reviewer, offered: STARTER_PREFERENCES.map((s) => s.id), records });
}
const starterPreferences = {
  id: "starter-preferences", title: "Starter preferences", available: true,
  what: "Stores the starter preferences you select as personal preference records in the store (personal/records). Pass --starter <id> for each one; with no --starter, all are selected.",
  why: "Preferences follow you across projects. Agents read them with your profile.",
  undo: "Run devtwin pref retire --id <record id> to stop delivering one. The record stays in the personal store.",
  plan: starterPlan,
  async apply(ctx, fingerprint) {
    const plan = await starterPlan(ctx);
    assertFingerprint(plan, fingerprint);
    const results = [];
    for (const r of plan.records) {
      const draft = { kind: "preference", status: r.status, title: r.title, body: r.body, reach: "personal", ...(plan.reviewer ? { sources: [{ ref: "user:" + plan.reviewer }], review: { reviewer: plan.reviewer, note: "accepted in setup" } } : {}) };
      results.push({ starter: r.starter, ...(await addPersonalRecord(ctx.roots, { requestId: r.requestId, recordedBy: { actor: "human", runId: STARTER_RUN }, draft }, { now: ctx.now })) });
    }
    return { applied: true, records: results };
  },
  done: async (ctx) => (await readPersonalSnapshot(ctx.roots)).records.some((r) => r.requestId.startsWith("req_setup_starter_"))
};

const later = (id, title, phase, what, why) => ({ id, title, available: "not available yet (" + phase + ")", what, why, undo: "Nothing to undo. This step is not available yet and writes nothing." });

const scopeFile = (ctx, scope) => join(ctx.roots.configRoot, "scopes", scope + ".json");
const anyScope = (ctx) => { try { return readdirSync(join(ctx.roots.configRoot, "scopes")).some((name) => name.endsWith(".json")); } catch { return false; } };
const scopePlan = async (ctx) => {
  await (await import("../config/store.mjs")).planScopeAdd(ctx.roots, { scope: ctx.values.scope });
  return finalizePlan({ kind: "setup-scope-add", scope: ctx.values.scope, displayName: ctx.values["display-name"] ?? null, destination: { root: "configRoot", path: "scopes/" + ctx.values.scope + ".json" }, exists: existsSync(scopeFile(ctx, ctx.values.scope)) });
};
const scope = {
  id: "scope", title: "Scope for the first project", available: true,
  what: "Adds the scope you name with --scope, as configRoot/scopes/<scope>.json in the store. Runs scope add.",
  why: "A scope keeps one organization's projects, records and lessons apart from every other scope.",
  undo: "No command removes a scope. An unused scope holds no records.",
  plan: scopePlan,
  async apply(ctx, fingerprint) {
    assertFingerprint(await scopePlan(ctx), fingerprint);
    return (await import("../config/commands.mjs")).scopeAddCommand.run({ ...pick(ctx.values, ["scope", "display-name"]), apply: true }, ctx);
  },
  done: (ctx) => ctx.values.scope ? existsSync(scopeFile(ctx, ctx.values.scope)) : anyScope(ctx)
};

const ONBOARD_FLAGS = ["scope", "project", "repo", "doc", "expect-remote", "environment", "actor", "accept", "request-id", "keep-previous"];
const onboardCmd = async () => (await import("../onboarding/commands.mjs")).projectOnboardCommand;
const firstProject = {
  id: "first-project", title: "First project", available: true,
  what: "Onboards one repository into the scope: --scope, --project, --repo and --accept. Runs project onboard. The live config must list the repository first (live add-repo). No file is added to the repository.",
  why: "Onboarding records the project's brief, commands and constraints in the store, so agents can resume the project's context.",
  undo: "project onboard with the same project and a new plan writes a new binding version. Records stay in the store.",
  plan: async (ctx) => (await onboardCmd()).run(pick(ctx.values, ONBOARD_FLAGS), ctx),
  apply: async (ctx, fingerprint) => (await onboardCmd()).run({ ...pick(ctx.values, ONBOARD_FLAGS), apply: true, "plan-fingerprint": fingerprint }, ctx),
  async done(ctx) {
    try {
      const { bindings } = (await readRegistry(ctx.roots)).value;
      return ctx.values.repo ? bindings.some((b) => b.path === ctx.values.repo) : bindings.length > 0;
    } catch { return false; }
  }
};

// U10: the hub steps. Without --hub-remote the scope stays in solo mode and the join step is skipped. Both are owner
// steps: their apply shows the owner dialog, and the devtwin hook denies them from agent shells.
const hubCmd = async () => (await import("../hubs/commands.mjs"));
const HUB_FLAGS = [["hub-remote", "remote"], ["hub-handle", "handle"], ["hub-email", "email"], ["ssh-command", "ssh-command"], ["hub-root", "hub-root"]];
const hubValues = (ctx) => ({ scope: ctx.values.scope, ...Object.fromEntries(HUB_FLAGS.filter(([flag]) => ctx.values[flag] !== undefined).map(([flag, key]) => [key, ctx.values[flag]])) });
// The step header is synchronous, so it reads the small private binding file directly. Any problem reads as not joined.
function hubBindingSync(ctx) {
  try {
    if (typeof ctx.values.scope !== "string" || !SCOPE_ID.test(ctx.values.scope)) return null;
    const value = JSON.parse(readFileSync(join(ctx.roots.configRoot, "hubs", ctx.values.scope + ".json"), "utf8"));
    return value?.status === "joined" ? value : null;
  } catch { return null; }
}
const hubJoin = {
  id: "hub-join", title: "Join an organization hub", available: true, owner: true,
  skip: (ctx) => ctx.values["hub-remote"] || hubBindingSync(ctx) ? null : "solo mode: no --hub-remote given",
  what: "Joins the organization hub at --hub-remote (SSH only) for --scope, with your --hub-handle and --hub-email, and an optional --ssh-command. Clones the hub into the approved hub root folder and records the note consent. Runs hub join.",
  why: "A hub shares accepted lessons with colleagues' agents at the moment they touch an area. Without it, devtwin runs in solo mode.",
  undo: "hub leave --scope <scope>, through preview and apply, revokes the note consent, removes the hub sync job, turns delivery off and deletes the clone. Personal records stay.",
  plan: async (ctx) => (await hubCmd()).hubJoinCommand.run(hubValues(ctx), ctx),
  apply: async (ctx, fingerprint) => (await hubCmd()).hubJoinCommand.run({ ...hubValues(ctx), apply: true, "plan-fingerprint": fingerprint }, ctx),
  done: (ctx) => Boolean(hubBindingSync(ctx))
};
const jobHubSync = {
  id: "job-hub-sync", title: "Scheduled job: hub sync", available: true, owner: true,
  skip: (ctx) => hubBindingSync(ctx) ? null : "no hub joined for this scope",
  needs: (ctx) => ctx.pilot.live && hubBindingSync(ctx) ? { launchAgents: [launchAgentFor(ctx, "devtwin.hub-sync." + ctx.values.scope)] } : {},
  what: "Installs a user LaunchAgent, devtwin.hub-sync.<scope>.plist, that runs hub sync every 10 minutes: fetch the hub, push the outbox, rebuild the lesson index. The plist path must be in the launchAgents write class. Runs hub schedule.",
  why: "Keeps the hub clone current and posts queued notes and lessons, with its own consent and off switch.",
  undo: "hub schedule --scope <scope> --off, through preview and apply, removes the job. Then notes and lesson updates stop until you run hub sync by hand.",
  plan: async (ctx) => (await hubCmd()).hubScheduleCommand.run({ scope: ctx.values.scope }, ctx),
  apply: async (ctx, fingerprint) => (await hubCmd()).hubScheduleCommand.run({ scope: ctx.values.scope, apply: true, "plan-fingerprint": fingerprint }, ctx),
  // Upgrade fix: an enabled job whose plist differs from what hub schedule would write now (after live set-kit) is
  // outdated, not done; the batch then rewrites it.
  done: async (ctx) => hubBindingSync(ctx)?.jobs?.hubSync?.enabled === true && (await scheduleJobs()).hubJobFileState(ctx.roots, ctx, ctx.values.scope) === "current",
  outdated: async (ctx) => hubBindingSync(ctx)?.jobs?.hubSync?.enabled === true && (await scheduleJobs()).hubJobFileState(ctx.roots, ctx, ctx.values.scope) !== "current"
};

// U20: the radar, advisory and review jobs, through schedule plan and schedule apply (owner steps, like hub sync).
const scheduleCmd = () => import("../schedule/commands.mjs");
const scheduleJobs = () => import("../schedule/jobs.mjs");
const jobEnabled = (ctx, job) => { try { return JSON.parse(readFileSync(join(ctx.roots.stateRoot, "schedule", "jobs.json"), "utf8")).jobs?.[job]?.enabled === true; } catch { return false; } };
const stackApproved = (ctx) => existsSync(join(ctx.roots.stateRoot, "stack", "approval.json"));
// A job whose plist is not an approved launchAgents path is skipped with the command that approves it.
const plistApproved = (ctx, job) => (ctx.roots.pilot?.writeClasses?.launchAgents ?? []).some((path) => path.endsWith("/devtwin." + job + ".plist"));
const jobStep = (id, job, title, what, why, skip) => ({
  id, title, available: true, owner: true, what, why, job,
  needs: (ctx) => ctx.pilot.live ? { launchAgents: [launchAgentFor(ctx, "devtwin." + job)] } : {},
  skip: (ctx) => plistApproved(ctx, job) ? skip(ctx) : "launch agent not approved; run live write-classes --launch-agent ~/Library/LaunchAgents/devtwin." + job + ".plist",
  undo: "schedule off --job " + job + ", through preview and apply, unloads the job and removes its plist." + (job === "radar-weekly" ? " It turns off the advisory job too." : ""),
  plan: async (ctx) => (await scheduleCmd()).schedulePlanCommand.run({ job }, ctx),
  apply: async (ctx, fingerprint) => (await scheduleCmd()).scheduleApplyCommand.run({ job, "plan-fingerprint": fingerprint }, ctx),
  // Upgrade fix: an enabled job is done only while its plist holds what schedule apply would write now. After live
  // set-kit the kit path differs, so the step is outdated and the batch rewrites the plist. A missing plist is outdated
  // too; a plist that is a link or not the owner's file throws PATH_UNSAFE and the step reports that problem.
  done: async (ctx) => jobEnabled(ctx, job) && (await scheduleJobs()).jobFileState(ctx.roots, ctx, job) === "current",
  outdated: async (ctx) => jobEnabled(ctx, job) && (await scheduleJobs()).jobFileState(ctx.roots, ctx, job) !== "current"
});
const jobRadar = jobStep("job-radar", "radar-weekly", "Scheduled job: weekly radar",
  "Installs a user LaunchAgent, devtwin.radar-weekly.plist, that writes one digest for each scope once a week and shows a short notification. The plist path must be in the launchAgents write class. Runs schedule apply.",
  "Tells you about relevant changes in your stack, new agent tools and ideas, without a manual run.",
  (ctx) => stackApproved(ctx) ? null : "no stack approval; run stack plan --with radar, then stack approve");
const jobAdvisories = jobStep("job-advisories", "advisory-hourly", "Scheduled job: security advisories",
  "Installs devtwin.advisory-hourly.plist, which checks security advisories for your stack every hour. An urgent advisory shows a notification at once, at most three a day. Runs schedule apply.",
  "Tells you at once about an urgent fix for a package in your stack.",
  (ctx) => !stackApproved(ctx) ? "no stack approval with the advisories group" : jobEnabled(ctx, "radar-weekly") ? null : "turn on the weekly radar job first");
const jobReview = jobStep("job-review-reminder", "review-monthly", "Scheduled job: monthly review reminder",
  "Installs devtwin.review-monthly.plist, which shows a monthly reminder with a count of waiting preference and lesson proposals. It makes no request. Runs schedule apply.",
  "Reminds you to review what devtwin keeps and does.", () => null);

// U24 (KTD33): the daily backup. The folder step approves --backup-target as a backupTargets folder in the live config;
// the job step installs the backup-daily job, which writes there.
const backupTargets = (ctx) => (ctx.roots?.pilot ?? ctx.pilot)?.writeClasses?.backupTargets ?? [];
const backupFolders = (ctx) => [...new Set([...backupTargets(ctx), ...list(ctx.values["backup-target"])])];
const backupFolder = {
  id: "backup-folder", title: "Approve the backup folder", available: true, owner: true, config: true,
  skip: (ctx) => !ctx.pilot.live ? "a disposable pilot lists its backup folders in the pilot file" : ctx.values["backup-target"] || backupTargets(ctx).length ? null : "no --backup-target given",
  needs: (ctx) => ctx.pilot.live && ctx.values["backup-target"] ? { backupTargets: list(ctx.values["backup-target"]) } : {},
  what: "Adds the folder you name with --backup-target to the backupTargets write class of the live config. Runs live write-classes --backup-target. Folders approved before stay.",
  why: "The daily backup and backup create write encrypted archives of the store only into an approved folder, such as one a cloud drive saves.",
  undo: "live write-classes with the other folders, or --clear backupTargets, through preview and apply, removes the approval. Archives already written stay.",
  plan: async (ctx) => (await import("../config/commands.mjs")).liveWriteClassesCommand.run({ pilot: ctx.values.pilot, "backup-target": backupFolders(ctx) }, ctx),
  apply: async (ctx, fingerprint) => (await import("../config/commands.mjs")).liveWriteClassesCommand.run({ pilot: ctx.values.pilot, "backup-target": backupFolders(ctx), apply: true, "plan-fingerprint": fingerprint }, ctx),
  done: (ctx) => ctx.values["backup-target"] ? list(ctx.values["backup-target"]).every((path) => backupTargets(ctx).includes(path)) : backupTargets(ctx).length > 0
};
const jobBackup = jobStep("job-backup", "backup-daily", "Scheduled job: daily backup",
  "Installs devtwin.backup-daily.plist, which writes one encrypted backup of the store a day into the first approved backup folder and keeps the newest 14. Runs schedule apply.",
  "A lost or damaged store can be restored from the newest archive.",
  (ctx) => backupTargets(ctx).length ? null : "no backup folder approved; run the backup-folder step");

// U36 (KTD39): the standing consents, through consent grant (owner steps: the apply shows the owner dialog and the hook
// denies it from agent shells). --push-repo names the repository; --hold-hours sets the hold time (default 24).
const consentCmd = () => import("../consent/commands.mjs");
const consentValues = (ctx, target) => ({ ...target, ...pick(ctx.values, ["hold-hours"]) });
const consentDone = async (ctx, kind, target) => {
  try { return (await (await import("../consent/store.mjs")).readConsent(ctx.roots, kind, target))?.valid === true; } catch { return false; }
};
const consentStep = (id, kind, title, what, why, target, skip, doneTarget) => ({
  id, title, available: true, owner: true, what, why, skip,
  undo: "consent revoke --kind " + kind + ", through preview and apply, ends the consent. Agents then stop at \"needs consent\" for that target.",
  plan: async (ctx) => (await consentCmd()).consentGrantCommand.run(consentValues(ctx, target(ctx)), ctx),
  apply: async (ctx, fingerprint) => (await consentCmd()).consentGrantCommand.run({ ...consentValues(ctx, target(ctx)), apply: true, "plan-fingerprint": fingerprint }, ctx),
  done: async (ctx) => consentDone(ctx, kind, doneTarget(ctx))
});
const pushRepo = (ctx) => { try { return realpathSync(ctx.values["push-repo"]); } catch { return ctx.values["push-repo"]; } };
const consentRepo = consentStep("consent-repo", "repo-push", "Consent: push learning branches to a repository",
  "Records a standing consent for the bound repository at --push-repo: agents and jobs may push learning branches to its remote without asking each time. Runs consent grant --kind repo-push.",
  "Lets lessons reach a repository's docs without a prompt for each branch: lesson accept --target repo writes a learning branch, and its push waits in the held queue before it is sent.",
  (ctx) => ({ kind: "repo-push", repo: ctx.values["push-repo"] }), (ctx) => ctx.values["push-repo"] ? null : "no --push-repo given", pushRepo);
const consentHub = consentStep("consent-hub", "hub-publish", "Consent: publish lessons to the organization hub",
  "Records a standing consent for the hub that --scope joined: lesson accept --target hub then holds a lesson with no owner dialog and sends it after the hold. Runs consent grant --kind hub-publish.",
  "Lets accepted lessons reach colleagues' agents without a prompt for each lesson.",
  (ctx) => ({ kind: "hub-publish", scope: ctx.values.scope }), (ctx) => hubBindingSync(ctx) ? null : "no hub joined for this scope", (ctx) => ctx.values.scope);

const sandbox = {
  id: "sandbox", title: "Sandbox recommendations", available: true,
  what: "Reads the project scan of --repo and recommends agent sandbox settings, and a container setup when the scan finds services. It writes no agent setting. Apply stores the recommendations you accept (--recommendation <id>; with none, all) as personal preference records.",
  why: "An agent with fewer rights and with services in containers can do less damage to your machine and to shared data.",
  undo: "Nothing to undo in agent settings, because devtwin writes none. No command removes a personal record yet.",
  plan: planSandbox,
  apply: applySandbox,
  done: sandboxDone
};

export const STEPS = Object.freeze([
  liveFolder,
  ...AGENTS.map(skillsStep),
  writeClassesHooks,
  ...AGENTS.map(hooksStep),
  hookVerify,
  pathsConfirm,
  profile,
  starterPreferences,
  later("starter-templates", "Starter templates", "P4", "Will install starter output templates (U17).", "Templates give agents a shared shape for briefs, reviews and reports."),
  scope,
  firstProject,
  hubJoin,
  jobHubSync,
  consentHub,
  consentRepo,
  jobRadar,
  jobAdvisories,
  jobReview,
  backupFolder,
  jobBackup,
  sandbox
].map((step) => Object.freeze(step)));
export const OWNER_STEPS = Object.freeze(STEPS.filter((step) => step.owner === true).map((step) => step.id));
export function stepById(id) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new DevtwinError("INVALID_INPUT", "Unknown setup step", { field: "step" });
  return step;
}
