// U10 (KTD15): scheduled jobs as user LaunchAgents. A job's plist is an approved launchAgents write-class file
// (devtwin.<name>.plist in ~/Library/LaunchAgents). The job command itself checks the live gate (the CLI loads the
// live config), its own config flag and its last-run receipt before any network call.
// ctx.launchctl(args) -> { status } is the seam for launchctl; tests always inject it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { editOwnedFile, readOwnedText } from "../storage/owned-file.mjs";
import { info } from "../storage/fsx.mjs";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HUB_SYNC_INTERVAL = 600;
export const HUB_SYNC_OFF_SWITCH = "Turning off the hub sync job means notes and lesson updates stop for this scope: devtwin no longer posts your queued notes or lessons and no longer fetches colleagues' lessons, until you run hub sync by hand or turn the job on again.";
export const hubSyncLabel = (scope) => "devtwin.hub-sync." + scope;
// The approved plist path for a label, or GATE_REQUIRED naming the class to approve.
export function launchAgentPath(roots, label) {
  const name = label + ".plist", found = (roots.pilot?.writeClasses?.launchAgents ?? []).find((path) => basename(path) === name);
  if (!found) throw new DevtwinError("GATE_REQUIRED", "Launch agent path not approved", { field: "writeClasses.launchAgents", remedy: "live write-classes --launch-agent ~/Library/LaunchAgents/" + name, name });
  return found;
}
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function renderPlist({ label, programArguments, interval }) {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>", "  <string>" + xml(label) + "</string>",
    "  <key>ProgramArguments</key>", "  <array>", ...programArguments.map((arg) => "    <string>" + xml(arg) + "</string>"), "  </array>",
    "  <key>StartInterval</key>", "  <integer>" + interval + "</integer>",
    "  <key>RunAtLoad</key>", "  <false/>",
    "  <key>ProcessType</key>", "  <string>Background</string>",
    "  <key>LowPriorityIO</key>", "  <true/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}
// Upgrade fix: an enabled job's plist against what renderPlist writes now. "current" when the bytes match, "outdated"
// when they differ (after live set-kit the kit path in ProgramArguments, the Node path, the pilot path or the
// interval changed), "missing" when the file is absent. The read never follows a link: a link or another unsafe file
// throws PATH_UNSAFE (readOwnedText), so a caller reports it instead of rewriting through it.
export function plistState(path, content) {
  const text = readOwnedText(path);
  return text === null ? "missing" : text === content ? "current" : "outdated";
}
// The Node a job runs. Homebrew's process.execPath names a versioned folder (<prefix>/Cellar/<formula>/<version>/bin/node)
// that brew upgrade removes, which would break every job. When execPath is in such a folder, a job uses the stable link
// of the same prefix and the same formula instead: <prefix>/bin/node for the formula node, <prefix>/opt/node@NN/bin/node
// for node@NN. The link is used only when its real path is a file <prefix>/Cellar/<formula>/<version>/bin/node, so a link
// that leads to another install, another formula or another prefix is never used. Otherwise the job keeps execPath. The
// hook lines in the agent settings run plain "node" from PATH, which an upgrade does not break either.
// ctx.nodeLookup ({ execPath, realpath, isFile }) is the seam.
const CELLAR = /^(\/.+)\/Cellar\/(node(?:@[0-9]+)?)\/[^/]+\/bin\/node$/;
const isFileAt = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
export function stableNodePath({ execPath = process.execPath, realpath = realpathSync, isFile = isFileAt } = {}) {
  const match = CELLAR.exec(execPath);
  if (!match) return execPath;
  const [, prefix, formula] = match;
  const link = formula === "node" ? prefix + "/bin/node" : prefix + "/opt/" + formula + "/bin/node";
  try {
    const real = realpath(link);
    const target = CELLAR.exec(real);
    if (target && target[1] === prefix && target[2] === formula && isFile(real)) return link;
  } catch { /* No link here. */ }
  return execPath;
}
export const jobNodePath = (ctx) => stableNodePath(ctx?.nodeLookup ?? {});
// The hub sync job command: the running kit's CLI with the live config, the scope and --job.
export function hubSyncArguments(ctx, scope) {
  const kit = ctx.pilot?.live?.kitRoot ?? ctx.kitRoot ?? KIT;
  return [jobNodePath(ctx), join(kit, "bin/devtwin.mjs"), "hub", "sync", "--pilot", resolve(ctx.pilot.path), "--scope", scope, "--job"];
}
export function defaultLaunchctl(args) {
  if (process.platform !== "darwin") return { status: 1, stdout: "", stderr: "launchctl unavailable" };
  const r = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
export const launchctlOf = (ctx) => typeof ctx?.launchctl === "function" ? ctx.launchctl : defaultLaunchctl;
export const domain = () => "gui/" + process.getuid();
// Writes the plist through the owned-file edit (backup record, atomic replace, mode 0600) and loads it.
export async function installJob(roots, ctx, { label, programArguments, interval, now = () => new Date() }) {
  const path = launchAgentPath(roots, label), content = renderPlist({ label, programArguments, interval });
  const runId = "run_job_" + now().getTime().toString(36) + "_" + randomBytes(4).toString("hex");
  await editOwnedFile(roots, { path, writeClass: "launchAgents", runId, edit: () => content });
  const run = launchctlOf(ctx);
  run(["bootout", domain() + "/" + label]);
  const loaded = run(["bootstrap", domain(), path]);
  return { plist: path, label, loaded: loaded?.status === 0, runId };
}
// Unloads the job and removes its plist. A missing plist is fine.
export function removeJob(roots, ctx, { label }) {
  const path = launchAgentPath(roots, label);
  const unloaded = launchctlOf(ctx)(["bootout", domain() + "/" + label]);
  const node = info(path);
  if (node) {
    assertWritable(roots, [path], { writeClass: "launchAgents" });
    if (node.isSymbolicLink() || !node.isFile() || lstatSync(path).uid !== process.getuid()) throw new DevtwinError("PATH_UNSAFE", "Launch agent file unsafe");
    unlinkSync(path);
  }
  return { plist: path, label, removed: Boolean(node), unloaded: unloaded?.status === 0 };
}
