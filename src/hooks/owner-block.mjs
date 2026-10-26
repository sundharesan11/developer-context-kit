// U8: the owner-action block (KTD9). On a PreToolUse shell call, devtwin's own hook denies a command that runs an
// owner-only devtwin action, including through terminal wrappers (script, expect, unbuffer, env, sh -c, xargs, nohup,
// time, sudo, npx). The check is text-based and conservative: it is not a shell parser, and a harmless command whose
// text names an owner action can be denied too. It is a separate path from lesson delivery: a denied call returns only
// the deny, and a call that is not denied goes on to the lesson path, which never returns a decision.
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const MAX_COMMAND_BYTES = 65536;
// words: the two route words. apply: the action is owner-only only with --apply (its preview stays allowed).
export const OWNER_ACTIONS = Object.freeze([
  // The owner decided on 2026-10-26 that agents may preview these four; the apply stays owner-only, and each apply
  // shows the owner dialog as a second gate.
  { words: ["lesson", "accept"], apply: true }, { words: ["lesson", "copy"], apply: true },
  { words: ["published", "delete"], apply: true }, { words: ["hub", "join"], apply: true },
  // U15 and U16: the preview of pref accept stays open, as above. instructions apply is itself the apply; its preview is
  // instructions plan.
  { words: ["pref", "accept"], apply: true }, { words: ["pref", "retire"], apply: true }, { words: ["instructions", "apply"] },
  { words: ["live", "migrate"], apply: true }, { words: ["record", "publish"], apply: true },
  { words: ["agents", "install"], apply: true }, { words: ["agents", "uninstall"], apply: true },
  { words: ["live", "set-kit"], apply: true }, { words: ["live", "add-repo"], apply: true }, { words: ["live", "init"], apply: true },
  { words: ["live", "write-classes"], apply: true }, { words: ["hub", "leave"], apply: true }, { words: ["hub", "schedule"], apply: true },
  // U12: acknowledging a replacement notice; an agent may list the notices but not hide them from its developer.
  { words: ["lesson", "notices"], apply: true },
  // U13: stopping or granting the standing note consent.
  { words: ["note", "revoke"], apply: true }, { words: ["note", "consent"], apply: true }
].map((action) => Object.freeze({ ...action, words: Object.freeze(action.words) })));
// U9: setup steps whose apply runs an owner action above (src/setup/steps.mjs marks them owner: true). "setup apply"
// naming one of them is denied, and so is the "setup" terminal loop, which can apply them. setup status, setup plan
// and setup apply for any other step stay allowed.
export const OWNER_SETUP_STEPS = Object.freeze(["skills-claude", "skills-codex", "write-classes-hooks", "hooks-claude", "hooks-codex", "hub-join", "job-hub-sync"]);
const SETUP_READS = ["status", "plan", "apply"];
function setupAction(words) {
  if (!words.includes("setup")) return null;
  if (words.includes("apply")) {
    const step = OWNER_SETUP_STEPS.find((id) => words.includes(id));
    return step ? "setup apply --step " + step : null;
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
// The owner action a payload's shell command runs, or null. Only shell tools are checked.
export function ownerAction(agent, payload) {
  if (!["claude", "codex"].includes(agent) || !SHELL_TOOLS.has(payload?.tool_name)) return null;
  const text = commandText(payload.tool_input);
  if (!/devtwin/i.test(text)) return null;
  const words = wordsOf(text), apply = words.includes("--apply");
  const adjacent = (a, b) => words.some((word, i) => word === a && words[i + 1] === b);
  // An adjacent route pair, or both words anywhere: a wrapper such as xargs or a variable can split the pair.
  const found = OWNER_ACTIONS.find(({ words: [a, b], apply: needsApply }) => (!needsApply || apply) && (adjacent(a, b) || (words.includes(a) && words.includes(b))));
  return found ? found.words.join(" ") + (found.apply ? " --apply" : "") : setupAction(words);
}
// Both agents read the same PreToolUse deny shape.
export const denyOutput = () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } });
