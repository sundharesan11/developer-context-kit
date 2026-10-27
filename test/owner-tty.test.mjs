import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, chmod, readFile } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { requireOwnerApproval } from "../src/owner/dialog.mjs";
import { CODE_ALPHABET, approvalCode, hasGuiSession, launchdSessionType, onSshTerminal, ttyProblem } from "../src/owner/tty.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";

const CONTENT = { title: "Example action", body: "Writes one example file." };
// The owner at the SSH login's own terminal: a human caller, and the sshTerminal seam in place of the device check.
const TTY_MODE = { pilot: { approval: "dialog-or-tty" }, env: {}, sshTerminal: true };
// A fake terminal. answer(code) gives the line the owner types; null is end of input.
function fakeTty(answer = (code) => code) {
  const written = [];
  return { written, calls: 0, write(text) { written.push(text); }, async readLine() { this.calls++; return answer(/code and press Return: ([A-Z]{6})/.exec(written.join(""))?.[1]); }, close() { this.closed = true; } };
}
const denied = (reason) => (error) => error.code === "DEVTWIN_OWNER_DENIED" && (reason === undefined || error.details.reason === reason);

test("owner tty approves with the right code in dialog-or-tty mode with no GUI session", async () => {
  const tty = fakeTty();
  let dialogs = 0;
  const result = await requireOwnerApproval({ ...TTY_MODE, sessionType: "Background", tty, ownerDialog: () => { dialogs++; return "approved"; } }, CONTENT);
  assert.equal(result.approved, true);
  assert.equal(dialogs, 0, "the terminal answers instead of the dialog");
  const text = tty.written.join("");
  assert.match(text, /devtwin: Example action/);
  assert.match(text, /Writes one example file\./);
  const code = /: ([A-Z]{6})\n/.exec(text)[1];
  assert.ok([...code].every((ch) => CODE_ALPHABET.includes(ch)));
  assert.equal(tty.closed, true);
  assert.equal(approvalCode(() => 0), "AAAAAA");
  assert.notEqual(approvalCode(), approvalCode(), "the code is random");
});

test("owner tty is not used in a GUI session even with SSH_TTY set", async () => {
  const tty = fakeTty();
  const shown = [];
  const ctx = { ...TTY_MODE, sessionType: "Aqua", env: { SSH_TTY: "/dev/ttys001", SSH_CONNECTION: "192.0.2.1 22 192.0.2.2 22" }, tty, ownerDialog: (content) => { shown.push(content); return "approved"; } };
  assert.equal((await requireOwnerApproval(ctx, CONTENT)).approved, true);
  assert.equal(shown.length, 1, "the dialog is required");
  assert.equal(tty.calls + tty.written.length, 0, "the terminal is never used");
  // A denied dialog in a GUI session stays denied; the terminal is no fallback.
  await assert.rejects(requireOwnerApproval({ ...ctx, ownerDialog: () => "denied" }, CONTENT), denied());
  assert.equal(tty.written.length, 0);
  // A session type that cannot be read counts as a GUI session.
  assert.equal(hasGuiSession({ sessionType: null }), true);
  assert.equal(hasGuiSession({ sessionType: () => "Background" }), false);
  assert.equal(launchdSessionType({ spawn: () => ({ status: 0, stdout: "Aqua\n" }) }), "Aqua");
  assert.equal(launchdSessionType({ spawn: () => ({ status: 1, stdout: "" }) }), null);
  assert.equal(launchdSessionType({ spawn: () => { throw new Error("no launchctl"); } }), null);
});

test("owner tty denies a wrong code, no answer, no terminal and the default mode", async () => {
  const base = { ...TTY_MODE, sessionType: "Background" };
  await assert.rejects(requireOwnerApproval({ ...base, tty: fakeTty((code) => code.toLowerCase()) }, CONTENT), denied("denied"));
  await assert.rejects(requireOwnerApproval({ ...base, tty: fakeTty((code) => code + "X") }, CONTENT), denied("denied"));
  await assert.rejects(requireOwnerApproval({ ...base, tty: fakeTty(() => "") }, CONTENT), denied("denied"));
  await assert.rejects(requireOwnerApproval({ ...base, tty: fakeTty(() => null) }, CONTENT), denied("no-answer"));
  await assert.rejects(requireOwnerApproval({ ...base, tty: () => { throw Object.assign(new Error("no tty"), { code: "ENXIO" }); } }, CONTENT), denied("no-tty"));
  await assert.rejects(requireOwnerApproval({ ...base, tty: { write() { throw new Error("EIO"); }, async readLine() { return "x"; } } }, CONTENT), denied("tty-failed"));
  // The default mode never asks the terminal: with no GUI the dialog path denies, as before.
  for (const pilot of [{}, { approval: "dialog" }]) {
    const tty = fakeTty();
    await assert.rejects(requireOwnerApproval({ pilot, sessionType: "Background", tty, ownerDialog: () => "denied" }, CONTENT), denied());
    await assert.rejects(requireOwnerApproval({ pilot, sessionType: "Background", tty, env: { SSH_CONNECTION: "192.0.2.1 22 192.0.2.2 22" } }, CONTENT), denied());
    assert.equal(tty.written.length, 0);
  }
});

test("owner tty refuses an agent caller and a stdin that is not the SSH login's terminal", async () => {
  const base = { ...TTY_MODE, sessionType: "Background" };
  for (const [ctx, reason] of [[{ env: { CLAUDECODE: "1" } }, "agent-caller"], [{ env: { CODEX_SANDBOX: "seatbelt" } }, "agent-caller"], [{ sshTerminal: false }, "not-ssh-terminal"], [{ sshTerminal: () => false }, "not-ssh-terminal"]]) {
    const tty = fakeTty();
    await assert.rejects(requireOwnerApproval({ ...base, ...ctx, tty }, CONTENT), denied(reason), reason);
    assert.equal(tty.written.length, 0, "the terminal is never asked");
  }
  assert.equal(ttyProblem({ env: {}, sshTerminal: (env) => env.SSH_TTY === "/dev/ttys001" }), "not-ssh-terminal");
  assert.equal(ttyProblem({ env: { SSH_TTY: "/dev/ttys001" }, sshTerminal: (env) => env.SSH_TTY === "/dev/ttys001" }), null);
  // The device check: stdin must be a TTY whose device is the one SSH_TTY names.
  const dev = (rdev, character = true) => ({ rdev, isCharacterDevice: () => character });
  const seams = (own, named, isTTY = true) => ({ stdin: { isTTY }, fstat: () => own, stat: () => named });
  const env = { SSH_TTY: "/dev/ttys001" };
  assert.equal(onSshTerminal(env, seams(dev(16), dev(16))), true);
  assert.equal(onSshTerminal(env, seams(dev(16), dev(17))), false, "another terminal");
  assert.equal(onSshTerminal(env, seams(dev(16), dev(16), false)), false, "stdin is not a TTY");
  assert.equal(onSshTerminal(env, seams(dev(16), dev(16, false))), false, "SSH_TTY is not a device");
  assert.equal(onSshTerminal({}, seams(dev(16), dev(16))), false, "no SSH_TTY");
  assert.equal(onSshTerminal({ SSH_TTY: "ttys001" }, seams(dev(16), dev(16))), false);
  assert.equal(onSshTerminal(env, { stdin: { isTTY: true }, fstat: () => { throw new Error("EBADF"); }, stat: () => dev(16) }), false);
});

// A live config in a fixture home, made through the CLI as the owner makes it.
async function liveHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".codex"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json");
  const run = async (args, seams = {}) => {
    const chunks = [];
    const code = await main(args, { stdout: { write(value) { chunks.push(value); return true; } }, now, home, env: {}, kitRoot: kit, ...seams });
    return { code, out: chunks.join(""), json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, seams) => { const r = await run(args, seams); assert.equal(r.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(r.json.error)); return r.json.result; };
  const initArgs = ["--pilot", liveConfig, "--agent", "claude", "--repo", repo];
  const preview = await ok(["live", "init", ...initArgs]);
  await ok(["live", "init", ...initArgs, "--apply", "--plan-fingerprint", preview.fingerprint]);
  await ok(["init", "--pilot", liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  return { run, ok, liveConfig, kit };
}

test("owner tty mode is set by live approval after the owner dialog and keeps stdout to one JSON line", async (t) => {
  const h = await liveHome(t);
  const args = ["live", "approval", "--pilot", h.liveConfig, "--mode", "dialog-or-tty"];
  const before = await readFile(h.liveConfig, "utf8");
  const preview = await h.ok(args);
  assert.deepEqual(preview.approval, { from: "dialog", to: "dialog-or-tty" });
  assert.equal(await readFile(h.liveConfig, "utf8"), before, "the preview writes nothing");
  assert.equal((await h.run(["live", "approval", "--pilot", h.liveConfig, "--mode", "ssh"])).json.error.code, "DEVTWIN_INVALID_INPUT");
  // A denied dialog leaves the config as it was.
  const refused = await h.run([...args, "--apply", "--plan-fingerprint", preview.fingerprint], { ownerDialog: () => "denied" });
  assert.equal(refused.json.error.code, "DEVTWIN_OWNER_DENIED");
  assert.equal(await readFile(h.liveConfig, "utf8"), before);
  await h.ok([...args, "--apply", "--plan-fingerprint", preview.fingerprint], { ownerDialog: () => "approved" });
  assert.equal(JSON.parse(await readFile(h.liveConfig, "utf8")).approval, "dialog-or-tty");
  // Now an always-ask apply in a session with no GUI asks on the terminal; stdout holds only the result line.
  const back = ["live", "approval", "--pilot", h.liveConfig, "--mode", "dialog"];
  const plan = await h.ok(back);
  const tty = fakeTty();
  const applied = await h.run([...back, "--apply", "--plan-fingerprint", plan.fingerprint], { sessionType: "Background", tty, sshTerminal: true, ownerDialog: () => { throw new Error("the dialog must not show"); } });
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  assert.equal(applied.out.split("\n").filter(Boolean).length, 1);
  assert.doesNotMatch(applied.out, /type this code|Anything else denies/);
  assert.match(tty.written.join(""), /Anything else denies/);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(h.liveConfig, "utf8")), "approval"), false, "dialog removes the key");
  assert.equal(await readFile(h.liveConfig, "utf8"), before, "the config is the one before the opt-in");
});

test("owner tty mode switch from a hooked agent shell is denied", () => {
  const shell = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const kit = "node /opt/kit/bin/devtwin.mjs";
  assert.equal(ownerAction("claude", shell(kit + " live approval --pilot /x/live.json --mode dialog-or-tty --apply --plan-fingerprint sha256:00")), "live approval --apply");
  assert.equal(ownerAction("codex", { tool_name: "shell", tool_input: { command: ["bash", "-c", kit + " live approval --mode dialog-or-tty --apply"] } }), "live approval --apply");
  assert.equal(ownerAction("claude", shell(kit + " live approval --pilot /x/live.json --mode dialog-or-tty")), null, "the preview stays open");
});
