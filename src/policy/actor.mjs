// U36 (KTD38): who runs a command, for a record's recordedBy. Claude Code sets CLAUDECODE in the shells it starts and
// Codex sets CODEX_* variables (CODEX_SANDBOX, CODEX_THREAD_ID). CLAUDECODE wins, because a Claude Code plugin can set a
// CODEX_ variable too. Anything else is the human at the terminal. This is a label for the audit trail, not a gate:
// the tier table and the owner dialog decide what runs.
export const ACTORS = Object.freeze(["human", "claude", "codex"]);
export function callerActor(env = process.env) {
  if (env?.CLAUDECODE) return "claude";
  if (Object.keys(env ?? {}).some((key) => key.startsWith("CODEX_") && env[key])) return "codex";
  return "human";
}
// recordedBy for a CLI write. runId stays the fixed CLI run until jobs record their own.
export const cliRecorder = (env) => Object.freeze({ actor: callerActor(env), runId: "run_cli00001" });
