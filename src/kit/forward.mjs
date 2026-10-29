// U46 (KTD6): the global command forwards a human's live command to the kit the live config pins. Agents never come
// through here for that: hooks and jobs call the pinned kit's bin directly, and skills run node '<kit>/bin/devtwin.mjs'
// with the path the session-start line names. The checks here only choose which kit runs; that kit then runs every
// gate itself. Forwarding runs execPath with the kit's bin and the same arguments, never a shell, once.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DevtwinError, toJson } from "../errors.mjs";
import { COMMANDS, isRootFree, routeOf, main } from "../cli.mjs";
import { pilotDigest, samePath } from "../config/pilot.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { kitIdentity, displayKitId, kitsFolder, DIGEST, VERSION } from "./identity.mjs";
import { readManifest } from "./manifest.mjs";
import { gitCommit } from "./version.mjs";
const KIT = resolve(import.meta.dirname, "../..");
// Routes that always run in this kit: the root-free ones (--version, version, help, demo, kit install, kit list, the
// skill source reads, skill template-list), which never touch a live config, and the hook, whose command line already
// names the pinned kit. Every other route, hook verify included, may forward.
export const LOCAL_ROUTES = Object.freeze([...Object.keys(COMMANDS).filter(isRootFree), "hook"].sort());
const KIT_ROUTES = ["live set-kit", "live init"];
const MAX_CONFIG_BYTES = 65536;
// Every value given for --name, as "--name v" or "--name=v".
const valuesOf = (argv, name) => argv.flatMap((arg, i) => arg === "--" + name ? [argv[i + 1]] : arg.startsWith("--" + name + "=") ? [arg.slice(name.length + 3)] : []);
const stay = (target, reason) => ({ note: "devtwin: not forwarding to " + target + " (" + reason + "); running this kit\n" });
// The kit to forward to, or a note on why not: the folder exists, is not the running kit, sits where its kind belongs
// and its HEAD or manifest names the identity. The full checks are the kit's own.
function checkKit(kitRoot, identity, running, home) {
  const display = displayKitId(identity);
  let real;
  try { real = realpathSync(kitRoot); } catch { return stay(display, "missing"); }
  if (samePath(real, running)) return {};
  if (identity.kind === "package") {
    let kits;
    try { kits = realpathSync(kitsFolder(home)); } catch { return stay(display, "outside-kits"); }
    if (!samePath(dirname(real), kits)) return stay(display, "outside-kits");
    let m;
    try { m = readManifest(real); } catch { return stay(display, "kit-check"); }
    if (m.version !== identity.version || m.digest !== identity.digest) return stay(display, "kit-check");
  } else if (gitCommit(real) !== identity.commit) return stay(display, "kit-check");
  return { kitRoot: real, display };
}
// live set-kit --kit and live init --kit name a package kit under <home>/.devtwin/kits; they must run from it.
function namedKit(argv, running, home) {
  const named = valuesOf(argv, "kit"), parts = named.length === 1 ? String(named[0]).split("+") : [];
  if (parts.length !== 2 || !VERSION.test(parts[0]) || !DIGEST.test(parts[1])) return {};
  return checkKit(join(kitsFolder(home), parts[0] + "-" + parts[1].slice(0, 12)), { kind: "package", version: parts[0], digest: parts[1] }, running, home);
}
// The live config --pilot names, or <home>/.devtwin/live.json: no file, or a disposable pilot, runs here with no note.
async function pinnedKit(argv, running, home) {
  const pilots = valuesOf(argv, "pilot");
  if (pilots.length > 1) return stay("the live config", "pilot-twice");
  const path = resolve(pilots[0] ?? join(home, ".devtwin", "live.json"));
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) { return error instanceof SyntaxError ? stay("the live config", "unreadable") : {}; }
  if (!raw || typeof raw !== "object" || !Object.hasOwn(raw, "live")) return {};
  let identity;
  try { raw = await readPrivateJson(path, MAX_CONFIG_BYTES); identity = kitIdentity(raw.live); if (typeof raw.live.kitRoot !== "string") throw new Error(); }
  catch { return stay("the live config", "unreadable"); }
  try { if (samePath(realpathSync(raw.live.kitRoot), running)) return {}; } catch { /* checkKit names it missing. */ }
  let approved = false;
  try {
    const record = await readPrivateJson(join(raw.stateRoot, "live", "approved-config.json"), 4096), digest = pilotDigest(raw);
    approved = record.schemaVersion === 1 && record.configId === raw.live.configId && (record.digest === digest || record.previousDigest === digest);
  } catch { approved = false; }
  if (!approved) return stay(displayKitId(identity), "unapproved");
  return checkKit(raw.live.kitRoot, identity, running, home);
}
// { kitRoot, display } to forward, { note } to run here with a note, or {} to run here quietly.
export async function forwardTarget(argv, { home = homedir(), kitRoot } = {}) {
  const route = routeOf(argv);
  if (route === null || LOCAL_ROUTES.includes(route)) return {};
  const running = realpathSync(kitRoot ?? KIT);
  if (KIT_ROUTES.includes(route) && valuesOf(argv, "kit").length) return namedKit(argv, running, home);
  return pinnedKit(argv, running, home);
}
// bin/devtwin.mjs. Seams: home, env, kitRoot (the running kit), spawn, execPath, stdout, stderr and run (the local CLI).
export async function runDevtwin(argv, { home = homedir(), env = process.env, kitRoot, spawn = spawnSync, execPath = process.execPath, stdout = process.stdout, stderr = process.stderr, run = (args) => main(args) } = {}) {
  const target = await forwardTarget(argv, { home, kitRoot });
  if (!target.kitRoot) {
    if (target.note) stderr.write(target.note);
    return run(argv);
  }
  if (env.DEVTWIN_FORWARDED === "1") {
    const error = new DevtwinError("GATE_REQUIRED", "Kit forwarding refused a second hop", { field: "kit", reason: "second-hop", kitRoot: target.kitRoot });
    stdout.write(JSON.stringify({ ok: false, command: routeOf(argv), error: toJson(error) }) + "\n");
    return 1;
  }
  stderr.write("devtwin: running kit " + target.display + "\n");
  const result = spawn(execPath, [join(target.kitRoot, "bin", "devtwin.mjs"), ...argv], { stdio: "inherit", env: { ...env, DEVTWIN_FORWARDED: "1" } });
  if (result.error) { stderr.write("devtwin: the kit did not start (" + (result.error.code ?? "error") + ")\n"); return 1; }
  return result.status ?? 1;
}
