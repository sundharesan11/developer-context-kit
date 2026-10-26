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
function hookTargetsFor(ctx) {
  const dirs = agentDirsFor({ home: ctx.pilot.live.home, env: ctx.env ?? process.env });
  return AGENTS.filter((agent) => Object.hasOwn(ctx.pilot.live.skillDirs, agent)).map((agent) => join(dirs[agent], HOOK_FILES[agent]));
}
const writeClassesHooks = {
  id: "write-classes-hooks", title: "Approve the hook settings files", available: true, owner: true,
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
  try { return (await receiptProblem(ctx.pilot.stateRoot, { pilotPath: pilotPathOf(ctx), pilotBytes: readPilotBytes(pilotPathOf(ctx)), kitRoot: ctx.kitRoot, now: ctx.now() })) ?? "ok"; }
  catch { return "invalid"; }
}
const hookVerify = {
  id: "hook-verify", title: "Hook verify", available: true,
  what: "Writes the kit receipt that the hook trusts, in the store at state/hooks/kit-receipt.json. Runs hook verify.",
  why: "The hook runs only for a kit and a live config whose receipt is current. A hook install writes it too. Run this step again after a kit upgrade or when the receipt expires.",
  undo: "Nothing to undo outside the store. The receipt expires by itself after seven days.",
  plan: async (ctx) => ({ ...receiptPlan(ctx), current: await receiptState(ctx) }),
  apply: async (ctx, fingerprint) => {
    assertFingerprint(receiptPlan(ctx), fingerprint);
    return (await import("../hooks/commands.mjs")).hookVerifyCommand.run({ pilot: ctx.values.pilot }, ctx);
  },
  done: async (ctx) => await receiptState(ctx) === "ok"
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
  what: "Installs a user LaunchAgent, devtwin.hub-sync.<scope>.plist, that runs hub sync every 10 minutes: fetch the hub, push the outbox, rebuild the lesson index. The plist path must be in the launchAgents write class. Runs hub schedule.",
  why: "Keeps the hub clone current and posts queued notes and lessons, with its own consent and off switch.",
  undo: "hub schedule --scope <scope> --off, through preview and apply, removes the job. Then notes and lesson updates stop until you run hub sync by hand.",
  plan: async (ctx) => (await hubCmd()).hubScheduleCommand.run({ scope: ctx.values.scope }, ctx),
  apply: async (ctx, fingerprint) => (await hubCmd()).hubScheduleCommand.run({ scope: ctx.values.scope, apply: true, "plan-fingerprint": fingerprint }, ctx),
  done: (ctx) => hubBindingSync(ctx)?.jobs?.hubSync?.enabled === true
};

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
  profile,
  starterPreferences,
  later("starter-templates", "Starter templates", "P4", "Will install starter output templates (U17).", "Templates give agents a shared shape for briefs, reviews and reports."),
  scope,
  firstProject,
  hubJoin,
  jobHubSync,
  later("job-radar", "Scheduled job: weekly radar", "P5", "Will schedule the weekly stack radar, with its own consent and off switch (U20).", "Tells you about relevant changes in your stack."),
  later("job-advisories", "Scheduled job: security advisories", "P5", "Will schedule the security advisory check, with its own consent and off switch (U20).", "Tells you about advisories for your stack."),
  later("job-review-reminder", "Scheduled job: monthly review reminder", "P5", "Will schedule the monthly setup review reminder, with its own consent and off switch (U20).", "Reminds you to review what devtwin keeps and does."),
  sandbox
].map((step) => Object.freeze(step)));
export const OWNER_STEPS = Object.freeze(STEPS.filter((step) => step.owner === true).map((step) => step.id));
export function stepById(id) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new DevtwinError("INVALID_INPUT", "Unknown setup step", { field: "step" });
  return step;
}
