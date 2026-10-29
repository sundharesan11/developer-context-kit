// KTD9: the owner dialog that every owner-only action shows before it writes. It runs osascript with a fixed script;
// the title and body reach the script only as arguments of its run handler (KTD24), never as script text, so quotes
// or AppleScript in them stay inert. With no GUI session, no osascript or any failure, the answer is "denied".
// Tests and other callers pass ctx.ownerDialog(content) => "approved" | "denied" | { decision, reason }.
// U26 (KTD34): the opt-in terminal answer for a session with no GUI; see src/owner/tty.mjs.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { hasGuiSession, ttyApproval } from "./tty.mjs";

export const DIALOG_LIMITS = Object.freeze({ titleChars: 80, bodyChars: 2000, timeoutSeconds: 300 });
const OSASCRIPT = "/usr/bin/osascript";
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
// Deny is the default and the cancel button, so Return or Escape denies.
export const DIALOG_SCRIPT = Object.freeze([
  "on run argv",
  "set dialogTitle to item 1 of argv",
  "set dialogBody to item 2 of argv",
  "try",
  "set answer to display dialog dialogBody with title dialogTitle buttons {\"Deny\", \"Approve\"} default button \"Deny\" cancel button \"Deny\" with icon caution giving up after " + DIALOG_LIMITS.timeoutSeconds,
  "if gave up of answer then return \"denied\"",
  "if button returned of answer is \"Approve\" then return \"approved\"",
  "end try",
  "return \"denied\"",
  "end run"
]);
function cap(text, limit) {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join("") + "\u2026";
}
// Control, format and bidi characters are removed. The body keeps its line breaks; a tab becomes a space.
function clean(value, { lines }) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  return text.replace(UNSAFE, (ch) => lines && ch === "\n" ? ch : lines ? "" : " ").replace(/\n{3,}/g, "\n\n").trim();
}
const BODY_PREFIX = "Approve only if you started this action yourself.\n\n";
// The exact text the dialog shows. Fixed prefixes keep either argument from starting with "-".
export function dialogText({ title, body }) {
  return {
    title: cap("devtwin: " + clean(title, { lines: false }), DIALOG_LIMITS.titleChars),
    body: cap(BODY_PREFIX + clean(body, { lines: true }), DIALOG_LIMITS.bodyChars)
  };
}
// U25: whether the dialog shows the whole body, with nothing cut at the limit.
export const fitsDialog = ({ body }) => [...(BODY_PREFIX + clean(body, { lines: true }))].length <= DIALOG_LIMITS.bodyChars;
export function dialogArgv(content) {
  const shown = dialogText(content);
  return [...DIALOG_SCRIPT.flatMap((line) => ["-e", line]), shown.title, shown.body];
}
// The production dialog. platform, env, exists and spawn are seams; no test shows a real dialog.
export function osascriptDialog(content, { platform = process.platform, env = process.env, exists = existsSync, spawn = spawnSync } = {}) {
  if (platform !== "darwin" || !exists(OSASCRIPT)) return { decision: "denied", reason: "no-dialog" };
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return { decision: "denied", reason: "no-gui-session" };
  let result;
  try { result = spawn(OSASCRIPT, dialogArgv(content), { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: (DIALOG_LIMITS.timeoutSeconds + 15) * 1000, killSignal: "SIGKILL", maxBuffer: 4096 }); }
  catch { return { decision: "denied", reason: "dialog-failed" }; }
  if (result?.error || result?.status !== 0) return { decision: "denied", reason: "dialog-failed" };
  return String(result.stdout ?? "").trim() === "approved" ? { decision: "approved" } : { decision: "denied", reason: "denied" };
}
// U26 (KTD34): the approval mode of the loaded live config; "dialog" when the key is absent.
const approvalMode = (ctx) => (ctx?.pilot ?? ctx?.roots?.pilot)?.approval === "dialog-or-tty" ? "dialog-or-tty" : "dialog";
// One approval for a setup batch (src/setup/batch.mjs). After the owner approved the batch dialog, the batch runs each
// step with a grant under ctx[BATCH_GRANT]. A grant is an object that only issueBatchGrant makes and that this module
// remembers, so no argument or environment variable can stand for one. It is bound to the batch fingerprint, the step
// and the step's plan fingerprint, and is revoked when the step ends. It stands for one dialog only: the dialog of the
// plan whose fingerprint the caller passes to requireOwnerApproval, which must equal the grant's step fingerprint.
// A dialog with no fingerprint or another fingerprint is shown as usual (fail safe), and the grant stays unused.
export const BATCH_GRANT = Symbol("devtwin.batchGrant");
const GRANTS = new WeakMap();
export function issueBatchGrant({ batchFingerprint, step, stepFingerprint }) {
  const grant = Object.freeze({ batchFingerprint, step, stepFingerprint });
  GRANTS.set(grant, { uses: 0 });
  return grant;
}
export const revokeBatchGrant = (grant) => { GRANTS.delete(grant); };
function useBatchGrant(ctx, fingerprint) {
  const grant = ctx?.[BATCH_GRANT], state = grant ? GRANTS.get(grant) : undefined;
  if (!state || state.uses > 0) return null;
  if (typeof fingerprint !== "string" || !fingerprint || fingerprint !== grant.stepFingerprint) return null;
  state.uses++;
  return grant;
}
// Shows the dialog and throws OWNER_DENIED unless the owner clicked Approve. Call it before the first write.
// In mode dialog-or-tty with no GUI session, the owner answers on the terminal instead (src/owner/tty.mjs).
// fingerprint: the fingerprint of the plan this dialog approves; only a batch grant for that same plan stands for it.
export async function requireOwnerApproval(ctx, content, { fingerprint } = {}) {
  const shown = dialogText(content);
  const grant = useBatchGrant(ctx, fingerprint);
  if (grant) return { approved: true, title: shown.title, batch: grant.batchFingerprint, step: grant.step };
  const tty = approvalMode(ctx) === "dialog-or-tty" && !hasGuiSession(ctx);
  // An injected dialog gets the cleaned text; osascriptDialog cleans the raw content itself.
  const show = tty ? () => ttyApproval(shown, ctx) : typeof ctx?.ownerDialog === "function" ? () => ctx.ownerDialog(shown) : () => osascriptDialog(content, { env: ctx?.env ?? process.env });
  let result;
  try { result = await show(); } catch { result = { decision: "denied", reason: "dialog-failed" }; }
  const decision = typeof result === "string" ? result : result?.decision;
  if (decision !== "approved") throw new DevtwinError("OWNER_DENIED", "The owner dialog was not approved", { reason: (typeof result === "object" && result?.reason) || "denied" });
  return { approved: true, title: shown.title };
}
