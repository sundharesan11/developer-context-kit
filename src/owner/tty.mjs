// U26 (KTD34): the owner's terminal answer, opt-in through the live config key approval: "dialog-or-tty". GUI presence
// comes from the launchd session type (`launchctl managername` prints "Aqua" in a GUI login), never from SSH_*
// variables. With no GUI session, the prompt and the answer use /dev/tty, so stdout keeps only the JSON result line.
// The owner types a random six-letter code; anything else, end of input, a timeout or no terminal denies.
// Review fix: the terminal answer is used only when the caller is not an agent (callerActor) and stdin is the SSH
// login's own terminal: process.stdin is a TTY and its device equals the device SSH_TTY names. Otherwise it denies.
// This stops an agent shell that merely sets SSH_TTY, but not a process of the same user that drives a terminal
// (for example through a pseudo-terminal it opens), so this mode is a convenience for an owner over SSH, not a barrier
// against agents. The dialog mode stays the barrier.
// Seams: ctx.sessionType (a string, or a function that returns one), ctx.tty ({ write, readLine, close? }, or a
// function that opens one) and ctx.sshTerminal (a boolean, or a function of env that returns one). Tests set them, so
// no test reads the real terminal or runs launchctl.
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, openSync, statSync, writeSync } from "node:fs";
import { randomInt } from "node:crypto";
import { ReadStream } from "node:tty";
import { callerActor } from "../policy/actor.mjs";

const LAUNCHCTL = "/bin/launchctl";
// No I or O, which read like 1 and 0.
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 6, TTY_TIMEOUT_SECONDS = 300;
const MAX_LINE = 256;
export const approvalCode = (pick = randomInt) => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[pick(CODE_ALPHABET.length)]).join("");
// The launchd session type, or null when it cannot be read.
export function launchdSessionType({ spawn = spawnSync } = {}) {
  try {
    const result = spawn(LAUNCHCTL, ["managername"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 1024 });
    if (result?.error || result?.status !== 0) return null;
    return String(result.stdout ?? "").trim() || null;
  } catch { return null; }
}
// A session type that cannot be read counts as a GUI session, so the dialog stays required.
export function hasGuiSession(ctx) {
  const type = typeof ctx?.sessionType === "function" ? ctx.sessionType() : ctx?.sessionType !== undefined ? ctx.sessionType : launchdSessionType();
  return type === null || type === "Aqua";
}
// Whether stdin is the terminal of the SSH login: a TTY whose device is the one SSH_TTY names.
export function onSshTerminal(env, { stdin = process.stdin, fstat = fstatSync, stat = statSync } = {}) {
  const path = env?.SSH_TTY;
  if (!stdin?.isTTY || typeof path !== "string" || !path.startsWith("/dev/")) return false;
  try { const own = fstat(0), named = stat(path); return own.isCharacterDevice() && named.isCharacterDevice() && own.rdev === named.rdev; } catch { return false; }
}
// Why the terminal answer may not be used, or null when it may.
export function ttyProblem(ctx) {
  const env = ctx?.env ?? process.env;
  if (callerActor(env) !== "human") return "agent-caller";
  const ssh = typeof ctx?.sshTerminal === "function" ? ctx.sshTerminal(env) : ctx?.sshTerminal !== undefined ? ctx.sshTerminal : onSshTerminal(env);
  return ssh === true ? null : "not-ssh-terminal";
}
// The production terminal: one write descriptor and one read stream on /dev/tty. Opening fails with no controlling terminal.
export function openTty() {
  const out = openSync("/dev/tty", "w");
  let input;
  try { input = new ReadStream(openSync("/dev/tty", "r")); } catch (error) { closeSync(out); throw error; }
  return {
    write: (text) => { writeSync(out, text); },
    readLine: (timeoutMs) => new Promise((resolve) => {
      let buffer = "", timer;
      const done = (value) => { clearTimeout(timer); input.off("data", onData); input.pause(); resolve(value); };
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end >= 0) done(buffer.slice(0, end)); else if (buffer.length > MAX_LINE) done(null);
      };
      timer = setTimeout(() => done(null), timeoutMs);
      input.on("data", onData);
      input.once("end", () => done(null));
      input.once("error", () => done(null));
    }),
    close: () => { input.destroy(); closeSync(out); }
  };
}
// shown is the cleaned dialog text (dialogText), so no control character reaches the terminal.
export async function ttyApproval(shown, ctx, { timeoutMs = TTY_TIMEOUT_SECONDS * 1000 } = {}) {
  const problem = ttyProblem(ctx);
  if (problem) return { decision: "denied", reason: problem };
  let io;
  try { io = typeof ctx?.tty === "function" ? ctx.tty() : ctx?.tty ?? openTty(); }
  catch { return { decision: "denied", reason: "no-tty" }; }
  if (!io || typeof io.write !== "function" || typeof io.readLine !== "function") return { decision: "denied", reason: "no-tty" };
  try {
    const code = approvalCode();
    io.write(["", shown.title, "", shown.body, "", "To approve, type this code and press Return: " + code, "Anything else denies.", "> "].join("\n"));
    const line = await io.readLine(timeoutMs);
    if (typeof line !== "string") return { decision: "denied", reason: "no-answer" };
    return line.trim() === code ? { decision: "approved" } : { decision: "denied", reason: "denied" };
  } catch { return { decision: "denied", reason: "tty-failed" }; }
  finally { try { io.close?.(); } catch { /* The decision stands. */ } }
}
