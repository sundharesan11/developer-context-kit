// U36 (KTD38): the tier table, the one place that decides who may run a route's write. Every route in src/cli.mjs
// has one line here; the test checks both lists match, so a new route needs a new line.
//   automatic   agents and jobs run it with no prompt: the write is local and reversible
//   consented   agents and jobs run it while a standing consent for the target exists (src/consent/store.mjs)
//   always-ask  only the owner, after the owner dialog; the hook denies it from agent shells (OWNER_ACTIONS)
//   read        it writes nothing that needs a tier: a read, a preview or a derived cache
// A line is a tier, or a map from target to tier for a route whose tier depends on the target. A map key is the target,
// with "@<source>" added for a source other than "local" (for example "@fetched" for an item devtwin fetched). A map
// value can be { tier, consent } (the consent kind it needs), { tier, via } (the route that does this action
// instead; the route itself refuses it) or { tier, dialog: true } (an always-ask action the route gates with the owner
// dialog alone: the hook cannot tell it from the route's automatic targets by its words, so it is not in OWNER_ACTIONS).
import { DevtwinError } from "../errors.mjs";
import { AGENT_IDS } from "../agents/adapters/index.mjs";

export const TIERS = Object.freeze(["automatic", "consented", "always-ask"]);
export const READ = "read";
const A = "automatic", C = "consented", ASK = "always-ask", R = READ;
const REVIEW = { tier: ASK, via: "activity review" };
const DIALOG = { tier: ASK, dialog: true };
// Review fix: a record's target is its status. observed and proposed knowledge is automatic; a confirmed or disputed
// record, or a write that replaces a confirmed or disputed record ("replaces-confirmed", "replaces-disputed"), needs
// the owner dialog whoever calls, because the caller's actor comes from environment variables any process can unset.
const RECORD_WRITE = { observed: A, proposed: A, confirmed: DIALOG, disputed: DIALOG };
// setup apply has the tier of the step it applies; the owner steps run an always-ask action.
// Each agent adapter has a skills-<id> and a hooks-<id> step (src/setup/steps.mjs).
const SETUP_STEPS = { "live-folder": R, ...Object.fromEntries(AGENT_IDS.flatMap((id) => [["skills-" + id, ASK], ["hooks-" + id, ASK]])), "write-classes-hooks": ASK,
  "hook-verify": A, "paths-confirm": ASK, profile: A, "starter-preferences": A, "starter-templates": R, scope: A, "first-project": A, "hub-join": ASK, "job-hub-sync": ASK,
  "job-radar": ASK, "job-advisories": ASK, "job-review-reminder": ASK, "consent-repo": ASK, "consent-hub": ASK, "backup-folder": ASK, "job-backup": ASK, sandbox: A,
  // U9 (one approval): setup apply --steps or --all-pending runs several owner steps after one owner dialog.
  batch: ASK };
const TABLE = {
  // demo writes only inside the fresh pilot root it is given or makes.
  version: R, help: R, demo: R,
  // U44 (KTD5): kit install --apply stages a kit that nothing runs until live set-kit, so it has no owner dialog; the
  // hook still denies it from agent shells, so an agent cannot stage kits on its own. Its plan and kit list only read.
  "kit install": ASK, "kit list": R,
  // The skill-source and skill-builder routes keep their own recorded approval chain (content-approve, local-approve).
  "skill-sources catalog": R, "skill-sources check": R, "skill-sources preview": R, "skill-sources stage": A, "skill-sources inspect": R,
  "skill-sources package-review": A, "skill-sources content-approve": A, "skill-sources local-plan": R, "skill-sources local-approve": A,
  "skill-sources local-apply": A, "skill-sources local-status": R,
  doctor: R, init: A, "scope add": A,
  "live init": ASK, "live add-repo": ASK, "live set-kit": ASK, "live write-classes": ASK, "live stack-watch": ASK, "live migrate": ASK,
  // U26 (KTD34): letting a terminal answer the owner prompt weakens it, so the switch is always ask.
  "live approval": ASK,
  "record add": RECORD_WRITE, "record supersede": { ...RECORD_WRITE, "replaces-confirmed": DIALOG, "replaces-disputed": DIALOG }, "record propose": A, "record publish": ASK,
  "lesson match": R, "lesson show": R, "lesson index": R, "lesson propose": A, "lesson proposals": R, "lesson edit": A, "lesson reject": A,
  // U30 (R8): the targets of lesson accept. A --target value is a set of them; each member is asked on its own. repo
  // writes a local learning branch (automatic); pushing it is the consented "learning send" step below.
  "lesson accept": { project: A, general: REVIEW, hub: { tier: C, consent: "hub-publish" }, repo: A },
  "lesson copy": ASK, "lesson supersede-propose": A, "lesson notices": ASK,
  hook: A, "hook verify": A, "budget report": R,
  // U27 (KTD35): a confirmation makes skills stop asking for the paths, so only the owner records it.
  "paths confirm": ASK, "paths check": R,
  setup: ASK, "setup status": R, "setup plan": R, "setup apply": SETUP_STEPS,
  "project onboard": A,
  // U30 (KTD29, KTD39): project set changes where lessons go in a repository, which voids its consent; learning send
  // queues the push of a branch written before the consent existed.
  // learning send needs the repository's repo-push consent (src/learnings/push.mjs).
  "project set": ASK, "learning send": C,
  "profile show": R, "profile plan": R, "profile apply": A, "profile export": R, "profile suggest-stack": R,
  "stack plan": R, "stack approve": A, "stack check": A, "stack digest": A, "radar guide": R,
  "draft save": A, "context resolve": R, "context brief": R, "handoff export": A,
  // U33 (KTD32): a handoff is an observed project record, so it is automatic like record add.
  "handoff write": { observed: A },
  // U28 (KTD42): the daily import writes observed project records only, and supersedes only observed ones.
  "import run": { observed: A },
  "agents install": ASK, "agents uninstall": ASK, "agents status": R, "agents recover": A, "agents rollback-check": R,
  "locks release": A,
  "pref propose": A, "pref proposals": R, "pref list": R, "pref accept": ASK, "pref decline": A, "pref retire": ASK,
  "instructions plan": R, "instructions apply": ASK,
  "template list": R, "template show": R, "template from": A,
  "note list": R, "note revoke": ASK, "note consent": ASK,
  "consent grant": ASK, "consent revoke": ASK, "consent list": R,
  // U37 (KTD40): activity reads the audit log. Review fix: every undo needs the owner, because a caller's --session
  // cannot be proven. The hook denies undo --apply by its words (OWNER_ACTIONS) and the apply shows the owner dialog.
  activity: R, undo: ASK,
  // U25 (R7, R8): the owner's weekly review accepts global preferences, general lessons and capped or outside writes
  // after the owner dialog. Its preview is open; the hook denies --apply.
  "activity review": ASK,
  // U21 (R36): the setup review. Its plan only reads; apply changes settings through other routes, so it is always ask
  // with the owner dialog listing every accepted line, and each route it runs keeps its own tier and dialog.
  "review plan": R, "review apply": ASK,
  // U24 (KTD33): backups are automatic and not audited. restore is always ask: it writes decrypted files into a folder a
  // cloud drive may sync. Showing the key is always ask.
  "backup create": A, "backup restore": ASK, "backup status": R, "backup key export": ASK,
  "hub propose": A, "hub join": ASK, "hub sync": A, "hub leave": ASK, "hub status": R, "hub schedule": ASK,
  "schedule plan": R, "schedule apply": ASK, "schedule off": ASK, "schedule status": R, "schedule run": A,
  "published list": R, "published delete": ASK,
  "skill workspace-create": A, "skill requirements-record": A, "skill design-record": A, "skill design-approve": A, "skill draft-create": A,
  "skill draft-validate": R, "skill content-approve": A, "skill local-plan": R, "skill local-approve": A, "skill local-apply": A,
  "skill local-status": R, "skill workspace-show": R, "skill discover": R, "skill template-list": R, "skill template-seed": A, "skill template-verify": R
};
const freezeRule = (value) => Object.freeze(typeof value === "string" ? { tier: value } : { ...value });
export const TIER_TABLE = Object.freeze(Object.fromEntries(Object.entries(TABLE).map(([route, line]) =>
  [route, typeof line === "string" ? freezeRule(line) : Object.freeze({ targets: Object.freeze(Object.fromEntries(Object.entries(line).map(([key, value]) => [key, freezeRule(value)]))) })])));

const unknown = (route, target, source) => { throw new DevtwinError("INVALID_INPUT", "No tier for this action", { field: "tier", route, target: target ?? null, source }); };
// The rule for one action: { tier, consent?, via? }. Throws for an action the table does not name.
export function tierRule({ route, target = null, source = "local" } = {}) {
  const line = typeof route === "string" && Object.hasOwn(TIER_TABLE, route) ? TIER_TABLE[route] : unknown(route, target, source);
  const key = (target ?? "") + (source === "local" ? "" : "@" + source);
  if (!line.targets) return key === "" ? line : unknown(route, target, source);
  return typeof target === "string" && Object.hasOwn(line.targets, key) ? line.targets[key] : unknown(route, target, source);
}
export const tierOf = (action) => tierRule(action).tier;
const askRule = (line, test) => (line.targets ? Object.values(line.targets) : [line]).some((rule) => rule.tier === ASK && test(rule));
// Routes with an always-ask action the hook denies by its words (an action with via is done by another route; an
// action with dialog is gated by the owner dialog alone).
export const alwaysAskRoutes = () => Object.keys(TIER_TABLE).filter((route) => askRule(TIER_TABLE[route], (rule) => !rule.via && !rule.dialog)).sort();
// Routes with an always-ask target that only the owner dialog gates.
export const dialogOnlyRoutes = () => Object.keys(TIER_TABLE).filter((route) => askRule(TIER_TABLE[route], (rule) => rule.dialog === true)).sort();
// The targets of a route that have the given tier.
export const targetsWithTier = (route, tier) => Object.entries(TIER_TABLE[route]?.targets ?? {}).filter(([, rule]) => rule.tier === tier).map(([key]) => key).sort();
