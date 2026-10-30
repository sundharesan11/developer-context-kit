import { join } from "node:path";
import { shellPaths, patchPaths, commandText } from "../../hooks/tool-text.mjs";
import { hookEntry, formatClaudeLike, SHELL_TOOLS, kindOf } from "./claude.mjs";
// Issue #8: the Codex adapter. Codex reads ~/.codex/hooks.json in the Claude settings shape, matches tool names with
// regexes and reads the same hookSpecificOutput. Codex ignores CODEX_HOME in live mode, as for skills.
export const CODEX_TRUST_NOTE = Object.freeze({ code: "CODEX_HOOK_TRUST", message: "Codex runs a new or changed hook only after you review it. Open Codex, run /hooks, and trust each devtwin entry." });
const TOOLS = Object.freeze({ shell: SHELL_TOOLS, edit: Object.freeze(["apply_patch"]) });
// Codex puts patch or command text in tool_input; an argv command is joined so both shapes parse the same way.
function parse(payload) {
  const tool = payload?.tool_name, input = payload?.tool_input ?? {}, kind = kindOf(TOOLS, tool);
  const paths = tool === "apply_patch" ? patchPaths(commandText(input) || input.patch || input.input) : kind === "shell" ? shellPaths(commandText(input)) : [];
  return { event: payload?.hook_event_name, sessionId: payload?.session_id, cwd: payload?.cwd, source: payload?.source, prompt: payload?.prompt,
    toolName: tool, toolKind: kind, command: kind === "shell" ? input?.command : undefined, paths, edit: tool === "apply_patch" };
}
export default Object.freeze({
  id: "codex", name: "Codex", actor: "codex", listed: true,
  // Codex sets CODEX_* variables (CODEX_SANDBOX, CODEX_THREAD_ID) in the shells it starts.
  detect: (env) => Object.keys(env).some((key) => key.startsWith("CODEX_") && env[key]),
  agentDir: ({ home }) => join(home, ".codex"),
  // Earlier releases wrote Codex skills to .codex/skills. Status reports leftovers there; nothing ever acts on them.
  skills: { folder: ".agents/skills", dir: ({ home }) => join(home, ".agents/skills"), legacy: [".codex/skills"] },
  instructions: { file: "AGENTS.md", display: "~/.codex/AGENTS.md", owned: false, ownedFiles: true },
  hooks: {
    file: "hooks.json", display: "~/.codex/hooks.json", format: "claude-settings", note: CODEX_TRUST_NOTE, trustLine: "Then trust them in Codex with /hooks",
    events: Object.freeze([["SessionStart", "session-start", null], ["UserPromptSubmit", "user-prompt", null], ["PreToolUse", "pre-tool", "^(apply_patch|Bash)$"], ["PostToolUse", "post-tool", "^Bash$"], ["PreCompact", "pre-compact", null], ["Stop", "stop", null]]),
    tools: TOOLS, entry: hookEntry, parse, format: formatClaudeLike, lessonEvent: "PreToolUse",
    compacted: (event, input) => event === "PreCompact" || event === "PostCompact" || (event === "SessionStart" && input.source === "compact")
  },
  capabilities: Object.freeze({ skills: true, instructions: true, sessionStartContext: true, preToolContext: true, ownerBlock: true, stopHook: true })
});
