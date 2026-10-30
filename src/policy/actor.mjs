import { DevtwinError } from "../errors.mjs";
import { AGENT_IDS, actorOf } from "../agents/adapters/index.mjs";
// U36 (KTD38): who runs a command, for a record's recordedBy. Each agent adapter says how its shells show (issue #8):
// Claude Code sets CLAUDECODE, Codex sets CODEX_* variables (CODEX_SANDBOX, CODEX_THREAD_ID) and Gemini CLI sets
// GEMINI_CLI. The first match in registry order wins, so CLAUDECODE wins, because a Claude Code plugin can set a
// CODEX_ variable too. Anything else is the human at the terminal. This is a label for the audit trail, not a gate:
// the tier table and the owner dialog decide what runs.
export const ACTORS = Object.freeze(["human", ...AGENT_IDS]);
export const callerActor = (env = process.env) => actorOf(env);
// recordedBy for a CLI write. runId stays the fixed CLI run until jobs record their own.
export const cliRecorder = (env) => Object.freeze({ actor: callerActor(env), runId: "run_cli00001" });
// U28 (KTD38): recordedBy for a devtwin job, such as the daily import. The actor is "other" and the run ID names the
// job run. No CLI caller gets this actor (callerActor gives human or an agent), so a job write is never an agent's.
export const JOB_RUN_ID = /^run_job_[a-f0-9]{16}$/;
export const isJobRecorder = (recordedBy) => recordedBy?.actor === "other" && JOB_RUN_ID.test(recordedBy?.runId ?? "");
export function jobRecorder(runId) {
  if (!JOB_RUN_ID.test(runId ?? "")) throw new DevtwinError("INVALID_ID", "Invalid job run ID");
  return Object.freeze({ actor: "other", runId });
}
