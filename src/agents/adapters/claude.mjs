import { join } from "node:path";
import { shellPaths, commandText } from "../../hooks/tool-text.mjs";
// Issue #8: the Claude Code adapter. Every Claude-specific fact devtwin relies on is here, as data and small pure
// functions; src/agents/adapters/index.mjs lists the adapters. Codex reuses the hook helpers below: both agents read
// the same settings shape and the same hookSpecificOutput.
// Hook entry: { "matcher"?: "<regex>", "hooks": [ { "type": "command", "command": "...", "timeout": 10 } ] }, timeout in seconds.
export const hookEntry = ({ command, matcher }) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 10 }] });
// Both agents read hookSpecificOutput.additionalContext, and the same PreToolUse deny shape.
export function formatClaudeLike(result) {
  if (result.kind === "deny") return { stdout: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: result.reason } }, exitCode: 0 };
  return { stdout: { hookSpecificOutput: { hookEventName: result.event, additionalContext: result.text } }, exitCode: 0 };
}
// The tool names both agents' shell tools use. Codex names its shell tool in several ways; the owner block and command
// lessons accept every one of them from either agent.
export const SHELL_TOOLS = Object.freeze(["Bash", "shell", "local_shell", "exec_command"]);
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]), EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]), DIR_TOOLS = new Set(["Glob", "Grep"]);
const str = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
export const kindOf = (tools, name) => Object.keys(tools).find((kind) => tools[kind].includes(name)) ?? null;
const TOOLS = Object.freeze({ shell: SHELL_TOOLS, read: Object.freeze(["Read"]), edit: Object.freeze([...EDIT_TOOLS]), search: Object.freeze([...DIR_TOOLS]) });
// The normalized payload the hook code reads: the event (the agent's own name, which is devtwin's internal name here),
// session, cwd, start source, prompt, tool kind and name, the raw shell command (text or argv), the raw file paths
// the call names and whether it edits files.
function parse(payload) {
  const tool = payload?.tool_name, input = payload?.tool_input ?? {}, kind = kindOf(TOOLS, tool);
  let paths = [];
  if (FILE_TOOLS.has(tool)) paths = [str(input.file_path) ?? str(input.notebook_path)].filter(Boolean);
  else if (DIR_TOOLS.has(tool)) paths = [str(input.path)].filter(Boolean);
  else if (tool === "Bash") paths = shellPaths(commandText(input));
  return { event: payload?.hook_event_name, sessionId: payload?.session_id, cwd: payload?.cwd, source: payload?.source, prompt: payload?.prompt,
    toolName: tool, toolKind: kind, command: kind === "shell" ? input?.command : undefined, paths, edit: EDIT_TOOLS.has(tool) };
}
export default Object.freeze({
  id: "claude", name: "Claude Code", actor: "claude",
  // listed: shown by status and targeted by instructions without a live config naming it, as before adapters existed.
  listed: true,
  // The actor for a CLI caller. Claude Code sets CLAUDECODE in the shells it starts. It is checked first, because a
  // Claude Code plugin can set a CODEX_ variable too.
  detect: (env) => Boolean(env.CLAUDECODE),
  // The agent folder for hooks and instructions. CLAUDE_CONFIG_DIR wins, as Claude Code itself reads it.
  agentDir: ({ home, env }) => env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
  skills: { folder: ".claude/skills", dir: ({ home, env }) => env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(home, ".claude/skills"), legacy: [] },
  // owned: CLAUDE.md imports devtwin.md, a devtwin-owned file beside it (Claude Code reads "@<path>" lines as imports).
  instructions: { file: "CLAUDE.md", display: "~/.claude/CLAUDE.md", owned: true, ownedFiles: true },
  hooks: {
    file: "settings.json", display: "~/.claude/settings.json", format: "claude-settings",
    // [agent event, devtwin hook event, matcher]. Claude matches tool names exactly. Stop (U33) is added last, so every
    // earlier entry keeps its bytes.
    events: Object.freeze([["SessionStart", "session-start", null], ["UserPromptSubmit", "user-prompt", null], ["PreToolUse", "pre-tool", "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash"], ["PreCompact", "pre-compact", null], ["Stop", "stop", null]]),
    tools: TOOLS, entry: hookEntry, parse, format: formatClaudeLike,
    // The internal event that delivers command lessons: the context is read before the tool runs.
    lessonEvent: "PreToolUse",
    compacted: (event, input) => event === "PreCompact" || (event === "SessionStart" && input.source === "compact")
  },
  capabilities: Object.freeze({ skills: true, instructions: true, sessionStartContext: true, preToolContext: true, ownerBlock: true, stopHook: true })
});
