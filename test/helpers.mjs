import { mkdtemp, realpath, rm, mkdir, writeFile, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
export { sleep };
export const now = () => new Date("2026-10-07T00:00:00.000Z");
export async function sandbox(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "devctx-t-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function runCli(args, { env = {} } = {}) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main(args, { stdout, now, home: tmpdir(), env });
  return { code, json: JSON.parse(chunks.join("")) };
}
export async function makePilot(t, { env = {} } = {}) {
  const sb = await sandbox(t), fakeHome = join(sb, "home");
  const root = join(sb, "pilot"), forbidden = [join(sb, "outside-forbidden")];
  await mkdir(fakeHome);
  await mkdir(forbidden[0]);
  for (const rel of ["homes/claude", "homes/codex", "repos", "inputs"]) await mkdir(join(root, rel), { recursive: true });
  const obj = { schemaVersion: 1, pilotRoot: root, configRoot: join(root, "config"), dataRoot: join(root, "data"), stateRoot: join(root, "state"), inputsRoot: join(root, "inputs"), agentHomes: [join(root, "homes/claude"), join(root, "homes/codex")], repos: [join(root, "repos/atlas"), join(root, "repos/beacon")], forbidden };
  const path = join(sb, "pilot.json");
  await writeFile(path, JSON.stringify(obj));
  const pilot = await loadPilot(path, { home: fakeHome, kitRoot: "/nonexistent-kit", env });
  let n = 0;
  return { path, pilot, roots: rootsFromPilot(pilot), configRoot: obj.configRoot, dataRoot: obj.dataRoot, stateRoot: obj.stateRoot, inputsRoot: obj.inputsRoot, agentHomes: obj.agentHomes, reposDir: join(root, "repos"), fakeHome, forbidden, sandbox: sb, async with(patch) { const p = join(sb, "pilot-" + ++n + ".json"); await writeFile(p, JSON.stringify({ ...obj, ...patch })); return p; } };
}
export async function lockFile(t) { return join(await sandbox(t), "x.lock"); }
export async function fixtureGit(cwd, args) {
  const env = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...args], { env, encoding: "utf8" });
}
export async function makeRepo(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "fixture"]);
  return realpath(dir);
}
export async function treeSnapshot(dir) {
  const rows = [];
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), st = await lstat(child);
      const row = [relative(dir, child), st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file", st.mode, st.size, st.mtimeMs];
      if (st.isFile()) row.push(createHash("sha256").update(await readFile(child)).digest("hex"));
      rows.push(row);
      if (st.isDirectory()) await walk(child);
    }
  }
  await walk(dir);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
