// U8: the owner-action block (KTD9). On a PreToolUse shell call, devtwin's own hook denies a command that runs an
// owner-only devtwin action, including through terminal wrappers (script, expect, unbuffer, env, sh -c, xargs, nohup,
// time, sudo, npx). The check is text-based and conservative: it is not a shell parser, and a harmless command whose
// text names an owner action can be denied too. It is a separate path from lesson delivery: a denied call returns only
// the deny, and a call that is not denied goes on to the lesson path, which never returns a decision.
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const MAX_COMMAND_BYTES = 65536;
// words: the route words (one for undo, two, or three for backup key export). apply: the action is owner-only only with --apply (its preview stays allowed).
export const OWNER_ACTIONS = Object.freeze([
  // The owner decided on 2026-10-26 that agents may preview these three; the apply stays owner-only, and each apply
  // shows the owner dialog as a second gate. U36 (KTD38): lesson accept left this list; it refuses the targets its tier
  // does not allow (src/policy/tiers.mjs).
  { words: ["lesson", "copy"], apply: true },
  { words: ["published", "delete"], apply: true }, { words: ["hub", "join"], apply: true },
  // U15 and U16: the preview of pref accept stays open, as above. instructions apply is itself the apply; its preview is
  // instructions plan.
  { words: ["pref", "accept"], apply: true }, { words: ["pref", "retire"], apply: true }, { words: ["instructions", "apply"] },
  { words: ["live", "migrate"], apply: true }, { words: ["record", "publish"], apply: true },
  { words: ["agents", "install"], apply: true }, { words: ["agents", "uninstall"], apply: true },
  { words: ["live", "set-kit"], apply: true }, { words: ["live", "add-repo"], apply: true }, { words: ["live", "init"], apply: true },
  { words: ["live", "write-classes"], apply: true }, { words: ["live", "stack-watch"], apply: true }, { words: ["hub", "leave"], apply: true }, { words: ["hub", "schedule"], apply: true },
  // U20: turning a scheduled job on or off. schedule apply is itself the apply; its preview is schedule plan.
  { words: ["schedule", "apply"] }, { words: ["schedule", "off"], apply: true },
  // U12: acknowledging a replacement notice; an agent may list the notices but not hide them from its developer.
  { words: ["lesson", "notices"], apply: true },
  // U13: stopping or granting the standing note consent.
  { words: ["note", "revoke"], apply: true }, { words: ["note", "consent"], apply: true },
  // U36: granting or revoking a standing consent (KTD39).
  { words: ["consent", "grant"], apply: true }, { words: ["consent", "revoke"], apply: true },
  // U37: undo. Review fix: every undo apply is owner-only, since a caller's --session cannot be proven; its preview
  // stays open. The one word "undo" with --apply is enough, so a harmless command naming both is denied too.
  { words: ["undo"], apply: true },
  // U25 (KTD38): the weekly review. An agent may list the waiting items; only the owner answers them.
  { words: ["activity", "review"], apply: true },
  // U21 (R36): the setup review. An agent may list the suggestions and preview the decisions; only the owner applies them.
  { words: ["review", "apply"], apply: true },
  // U24 (KTD33): printing the backup key. Its preview stays open.
  { words: ["backup", "key", "export"], apply: true }, { words: ["backup", "restore"], apply: true },
  // U27 (KTD35): recording the confirmed kit and config paths. U26 (KTD34): the owner-answer mode.
  { words: ["paths", "confirm"], apply: true }, { words: ["live", "approval"], apply: true },
  // U30 (KTD29): where a project's lessons go in its repository; a change voids the repository's consent.
  { words: ["project", "set"], apply: true },
  // U44 (KTD5): staging a package kit under ~/.devtwin/kits. Its plan stays open.
  { words: ["kit", "install"], apply: true }
].map((action) => Object.freeze({ ...action, words: Object.freeze(action.words) })));
// U9: setup steps whose apply runs an owner action above (src/setup/steps.mjs marks them owner: true). setup apply is
// an allowlist: from an agent shell it is allowed only with exactly one --step <id> whose id is not listed here, and
// with neither --steps nor --all-pending. Anything else that names setup apply is denied, and so is the "setup"
// terminal loop, which can apply owner steps. setup status and setup plan stay allowed.
export const OWNER_SETUP_STEPS = Object.freeze(["skills-claude", "skills-codex", "write-classes-hooks", "hooks-claude", "hooks-codex", "hub-join", "job-hub-sync", "job-radar", "job-advisories", "job-review-reminder", "consent-repo", "consent-hub", "paths-confirm", "backup-folder", "job-backup"]);
// U9 (one approval): the flags that make setup apply a batch of owner steps (src/setup/batch.mjs). Its preview is
// setup plan with the same flags, so every setup apply that names one is denied, with or without --apply.
export const SETUP_BATCH_FLAGS = Object.freeze(["--steps", "--all-pending"]);
const SETUP_READS = ["status", "plan", "apply"];
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The one step a setup apply names, or null when it names none, several, a list or a batch flag.
function singleStep(words) {
  if (words.some((word) => SETUP_BATCH_FLAGS.some((flag) => word === flag || word.startsWith(flag + "=")))) return null;
  const ids = [];
  words.forEach((word, i) => {
    if (word === "--step") ids.push(words[i + 1]);
    else if (word.startsWith("--step=")) ids.push(word.slice("--step=".length));
  });
  return ids.length === 1 && STEP_ID.test(ids[0] ?? "") ? ids[0] : null;
}
function setupAction(words) {
  if (!words.includes("setup")) return null;
  if (words.includes("apply")) {
    if (SETUP_BATCH_FLAGS.some((flag) => words.some((word) => word === flag || word.startsWith(flag + "=")))) return "setup apply --steps";
    // A step list such as "hooks-claude,job-radar" is one word; each name in it counts.
    const names = words.flatMap((word) => word.split(/[,=]/));
    const owner = OWNER_SETUP_STEPS.find((id) => names.includes(id));
    if (owner) return "setup apply --step " + owner;
    return singleStep(words) ? null : "setup apply";
  }
  return SETUP_READS.some((word) => words.includes(word)) ? null : "setup";
}
export const DENY_REASON = "devtwin: this command runs an owner-only devtwin action. An agent may not run it. Ask your developer to run it themselves in their own terminal.";
// Codex sends shell commands as text or as an argv array; both are read as one text.
function commandText(input) {
  const command = Array.isArray(input?.command) ? input.command.filter((part) => typeof part === "string").join(" ") : input?.command;
  if (typeof command !== "string") return "";
  return Buffer.byteLength(command) <= MAX_COMMAND_BYTES ? command : command.slice(0, MAX_COMMAND_BYTES);
}
// Lower-case words with quotes, backslashes and shell operators removed. Quotes and backslashes are deleted, not
// turned into spaces, because the shell joins "--ap""ply" into --apply. "A=accept" gives "a" and "accept", so a value
// set in a variable still counts.
const wordsOf = (text) => text.toLowerCase().replace(/\\\n/g, " ").replace(/["'`\\]/g, "").split(/[\s;|&()<>{}$=]+/).filter(Boolean);
// Shell expansions that can hide or build words: ${...}, $'...', $"...", $(...) and backticks.
const HIDING = /\$\{|\$'|\$"|\$\(|`/;
// The owner action a payload's shell command runs, or null. Only shell tools are checked.
export function ownerAction(agent, payload) {
  if (!["claude", "codex"].includes(agent) || !SHELL_TOOLS.has(payload?.tool_name)) return null;
  const text = commandText(payload.tool_input);
  if (!/devtwin/i.test(text)) return null;
  const words = wordsOf(text), apply = words.includes("--apply");
  // Every route word anywhere, adjacent or not: a wrapper such as xargs or a variable can split the route.
  const found = OWNER_ACTIONS.find(({ words: route, apply: needsApply }) => (!needsApply || apply) && route.every((word) => words.includes(word)));
  if (found) return found.words.join(" ") + (found.apply ? " --apply" : "");
  const setup = setupAction(words);
  if (setup) return setup;
  // Review fix: shell expansion can build a word the match above never sees ("--ap${X}ply", $'--all-pe\x6eding').
  // When the text names an owner route (all its words, or its first word with --apply) or setup, any such expansion
  // denies, previews included.
  if (HIDING.test(text) && (words.includes("setup") || OWNER_ACTIONS.some(({ words: route }) => route.every((word) => words.includes(word)) || (apply && words.includes(route[0]))))) return "shell expansion near an owner action";
  return null;
}
// Both agents read the same PreToolUse deny shape.
export const denyOutput = () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } });
