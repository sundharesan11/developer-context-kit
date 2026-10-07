import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/cli.mjs";
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
