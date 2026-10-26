// U20 (KTD24): desktop notifications. The text never enters a script: the AppleScript is three fixed lines, and the
// title and message reach it only as arguments (argv). Before that they are stripped of control and format
// characters, quotes and backslashes, and capped in length. ctx.notifier(args) -> { status } is the test seam.
import { spawnSync } from "node:child_process";

export const NOTIFY_LIMITS = Object.freeze({ title: 60, message: 200 });
const SCRIPT = Object.freeze(["on run argv", "display notification (item 1 of argv) with title (item 2 of argv)", "end run"]);
export function notificationText(text, max) {
  const clean = String(text ?? "").normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/["'`\\‘’“”«»]/g, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean;
}
// The osascript arguments: the fixed script lines, then the message and the title as plain arguments.
export function osascriptArgs({ title, message }) {
  return [...SCRIPT.flatMap((line) => ["-e", line]), notificationText(message, NOTIFY_LIMITS.message), notificationText(title, NOTIFY_LIMITS.title)];
}
export function defaultNotifier(args) {
  if (process.platform !== "darwin") return { status: 1 };
  const result = spawnSync("/usr/bin/osascript", args, { stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" });
  return { status: result.status ?? 1 };
}
// A failed notification never fails the job; the result says whether it was shown.
export function notify(ctx, content) {
  const args = osascriptArgs(content);
  const run = typeof ctx?.notifier === "function" ? ctx.notifier : defaultNotifier;
  let shown = false;
  try { shown = run(args)?.status === 0; } catch { shown = false; }
  return { shown, title: args.at(-1), message: args.at(-2) };
}
