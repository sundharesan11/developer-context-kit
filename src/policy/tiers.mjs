// U36 (KTD38): the tier table, the one place that decides who may run a route's write. Every route in src/cli.mjs
// has one line here; the test checks both lists match, so a new route needs a new line.
//   automatic   agents and jobs run it with no prompt: the write is local and reversible
//   consented   agents and jobs run it while a standing consent for the target exists (src/consent/store.mjs)
//   always-ask  only the owner, after the owner dialog; the hook denies it from agent shells (OWNER_ACTIONS)
//   read        it writes nothing that needs a tier: a read, a preview or a derived cache
// A line is a tier, or a map from target to tier for a route whose tier depends on the target. A map key is the target,
// with "@<source>" added for a source other than "local" (for example "@fetched" for an item devtwin fetched). A map
// value can be { tier, consent } (the consent kind it needs) or { tier, via } (the route that does this action
// instead; the route itself refuses it).
import { DevtwinError } from "../errors.mjs";

export const TIERS = Object.freeze(["automatic", "consented", "always-ask"]);
export const READ = "read";
const A = "automatic", C = "consented", ASK = "always-ask", R = READ;
const REVIEW = { tier: ASK, via: "activity review" };
// setup apply has the tier of the step it applies; the owner steps run an always-ask action.
const SETUP_STEPS = { "live-folder": R, "skills-claude": ASK, "skills-codex": ASK, "write-classes-hooks": ASK, "hooks-claude": ASK, "hooks-codex": ASK,
  "hook-verify": A, profile: A, "starter-preferences": A, "starter-templates": R, scope: A, "first-project": A, "hub-join": ASK, "job-hub-sync": ASK,
  "job-radar": ASK, "job-advisories": ASK, "job-review-reminder": ASK, "consent-repo": ASK, "consent-hub": ASK, sandbox: A };
const TABLE = {
  version: R, help: R,
  // The skill-source and skill-builder routes keep their own recorded approval chain (content-approve, local-approve).
  "skill-sources catalog": R, "skill-sources check": R, "skill-sources preview": R, "skill-sources stage": A, "skill-sources inspect": R,
  "skill-sources package-review": A, "skill-sources content-approve": A, "skill-sources local-plan": R, "skill-sources local-approve": A,
  "skill-sources local-apply": A, "skill-sources local-status": R,
  doctor: R, init: A, "scope add": A,
  "live init": ASK, "live add-repo": ASK, "live set-kit": ASK, "live write-classes": ASK, "live stack-watch": ASK, "live migrate": ASK,
  "record add": A, "record supersede": A, "record propose": A, "record publish": ASK,
  "lesson match": R, "lesson show": R, "lesson index": R, "lesson propose": A, "lesson proposals": R, "lesson edit": A, "lesson reject": A,
  "lesson accept": { project: A, hub: { tier: C, consent: "hub-publish" }, "hub+general": REVIEW, general: REVIEW },
  "lesson copy": ASK, "lesson supersede-propose": A, "lesson notices": ASK,
  hook: A, "hook verify": A, "budget report": R,
  setup: ASK, "setup status": R, "setup plan": R, "setup apply": SETUP_STEPS,
  "project onboard": A,
  "profile show": R, "profile plan": R, "profile apply": A, "profile export": R, "profile suggest-stack": R,
  "stack plan": R, "stack approve": A, "stack check": A, "stack digest": A, "radar guide": R,
  "draft save": A, "context resolve": R, "context brief": R, "handoff export": A,
  "agents install": ASK, "agents uninstall": ASK, "agents status": R, "agents recover": A, "agents rollback-check": R,
  "locks release": A,
  "pref propose": A, "pref proposals": R, "pref list": R, "pref accept": ASK, "pref decline": A, "pref retire": ASK,
  "instructions plan": R, "instructions apply": ASK,
  "template list": R, "template show": R, "template from": A,
  "note list": R, "note revoke": ASK, "note consent": ASK,
  "consent grant": ASK, "consent revoke": ASK, "consent list": R,
  // U37 (KTD40): activity reads the audit log. undo --id of an entry from the calling session (--session matches the
  // entry's) is automatic; undo --id of any other entry and undo --since need the owner. The hook denies undo --since
  // --apply by its words (OWNER_ACTIONS); it cannot see sessions, so the "other" target is gated by the owner dialog.
  activity: R, undo: { session: A, other: ASK, since: ASK },
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
// Routes with an always-ask action of their own (an action with via is done by another route).
export const alwaysAskRoutes = () => Object.keys(TIER_TABLE).filter((route) => {
  const line = TIER_TABLE[route];
  return (line.targets ? Object.values(line.targets) : [line]).some((rule) => rule.tier === ASK && !rule.via);
}).sort();
// The targets of a route that have the given tier.
export const targetsWithTier = (route, tier) => Object.entries(TIER_TABLE[route]?.targets ?? {}).filter(([, rule]) => rule.tier === tier).map(([key]) => key).sort();
