import { join } from "node:path";
import { shellPaths, commandText } from "../../hooks/tool-text.mjs";
import { kindOf } from "./claude.mjs";
// Issue #8: the Gemini CLI adapter (checked against Gemini CLI 0.50 and geminicli.com/docs/hooks/reference,
// /docs/cli/skills and /docs/reference/tools).
//   skills        ~/.agents/skills, the alias Gemini reads in the user tier, where it wins over ~/.gemini/skills. Codex
//                 reads the same folder, so one install serves both agents (src/agents/install.mjs).
//   instructions  a marker block in ~/.gemini/GEMINI.md, the global context file.
//   hooks         the top-level "hooks" key of ~/.gemini/settings.json. Entries have a name, and timeout is in
//                 milliseconds. Tool matchers are regexes; lifecycle events take no matcher here.
// Gemini honors hookSpecificOutput.additionalContext only on SessionStart, BeforeAgent and AfterTool, never on
// BeforeTool. So BeforeTool runs only the owner-action block (decision "deny" with a reason, which Gemini sends to the
// agent as the tool error), and lessons for files and commands arrive on AfterTool, appended to the tool result.
// AfterAgent ends every agent turn, as Claude's Stop does, so it writes the stop stub.
const TOOLS = Object.freeze({ shell: Object.freeze(["run_shell_command"]), read: Object.freeze(["read_file", "read_many_files"]), edit: Object.freeze(["write_file", "replace"]),
  search: Object.freeze(["glob", "grep_search", "search_file_content"]) });
// devtwin's internal event names (the Claude names) and the Gemini event that stands for each.
const EVENT_NAMES = Object.freeze({ SessionStart: "SessionStart", UserPromptSubmit: "BeforeAgent", PreToolUse: "BeforeTool", PostToolUse: "AfterTool", PreCompact: "PreCompress", Stop: "AfterAgent" });
const INTERNAL = Object.fromEntries(Object.entries(EVENT_NAMES).map(([internal, name]) => [name, internal]));
const str = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
const GLOB = /[*?{}[\]]/;
const list = (value) => Array.isArray(value) ? value.slice(0, 64).map(str).filter((path) => path && !GLOB.test(path)) : [];
function parse(payload) {
  const tool = payload?.tool_name, input = payload?.tool_input ?? {}, kind = kindOf(TOOLS, tool), event = payload?.hook_event_name;
  let paths = [];
  if (["read_file", "write_file", "replace"].includes(tool)) paths = [str(input.file_path)].filter(Boolean);
  else if (tool === "read_many_files") paths = [...list(input.include), ...list(input.paths)];
  else if (kind === "search") paths = [str(input.dir_path) ?? str(input.path)].filter(Boolean);
  else if (kind === "shell") paths = shellPaths(commandText(input));
  return { event: typeof event === "string" && Object.hasOwn(INTERNAL, event) ? INTERNAL[event] : event, sessionId: payload?.session_id, cwd: payload?.cwd, source: payload?.source, prompt: payload?.prompt,
    toolName: tool, toolKind: kind, command: kind === "shell" ? input?.command : undefined, paths, edit: TOOLS.edit.includes(tool) };
}
// Exit 0 with one JSON object: a deny is { decision, reason }; context sits under hookSpecificOutput.
function format(result) {
  if (result.kind === "deny") return { stdout: { decision: "deny", reason: result.reason }, exitCode: 0 };
  return { stdout: { hookSpecificOutput: { hookEventName: EVENT_NAMES[result.event] ?? result.event, additionalContext: result.text } }, exitCode: 0 };
}
const entry = ({ command, matcher, event }) => ({ ...(matcher ? { matcher } : {}), hooks: [{ name: "devtwin-" + event, type: "command", command, timeout: 10000 }] });
export default Object.freeze({
  id: "gemini", name: "Gemini CLI", actor: "gemini", listed: false,
  // run_shell_command sets GEMINI_CLI=1 in the shells it starts (geminicli.com/docs/tools/shell).
  detect: (env) => Boolean(env.GEMINI_CLI),
  agentDir: ({ home }) => join(home, ".gemini"),
  skills: { folder: ".agents/skills", dir: ({ home }) => join(home, ".agents/skills"), legacy: [] },
  instructions: { file: "GEMINI.md", display: "~/.gemini/GEMINI.md", owned: false, ownedFiles: false },
  hooks: {
    file: "settings.json", display: "~/.gemini/settings.json", format: "gemini-settings", eventNames: EVENT_NAMES,
    events: Object.freeze([["SessionStart", "session-start", null], ["BeforeAgent", "user-prompt", null], ["BeforeTool", "pre-tool", "^run_shell_command$"],
      ["AfterTool", "post-tool", "^(" + Object.values(TOOLS).flat().join("|") + ")$"], ["PreCompress", "pre-compact", null], ["AfterAgent", "stop", null]]),
    tools: TOOLS, entry, parse, format, lessonEvent: "PostToolUse",
    compacted: (event) => event === "PreCompact"
  },
  capabilities: Object.freeze({ skills: true, instructions: true, sessionStartContext: true, preToolContext: false, ownerBlock: true, stopHook: true })
});
