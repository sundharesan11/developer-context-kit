// U47 (KTD3, KTD8): prints the kit digest of a packed npm tarball, the digest that kit install computes for the same
// package. Usage: node scripts/kit-digest.mjs <tarball>. It extracts the tarball with tar into a new empty folder, checks
// that the root is package/ and that every file is in the runtime set, and prints one JSON line with the version, the
// digest and the kitId. It exits nonzero on any failure. The release workflow publishes this digest in the GitHub release.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { kitDigest, VERSION } from "../src/kit/manifest.mjs";
import { listRuntimeFiles } from "../src/kit/runtime-files.mjs";
import { kitId } from "../src/kit/identity.mjs";
const args = process.argv.slice(2);
const temp = realpathSync(mkdtempSync(join(tmpdir(), "devtwin-kit-digest-")));
let out;
try {
  if (args.length !== 1) throw new Error("usage: node scripts/kit-digest.mjs <tarball>");
  const tarball = resolve(args[0]);
  if (!statSync(tarball, { throwIfNoEntry: false })?.isFile()) throw new Error("tarball not found");
  const r = spawnSync("tar", ["-xzf", tarball, "-C", temp], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  if (r.status !== 0) throw new Error("tar failed");
  if (readdirSync(temp).join("\0") !== "package") throw new Error("tarball root is not package/");
  const root = join(temp, "package");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("version invalid");
  const files = listRuntimeFiles(root), runtime = new Set(files);
  const extra = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => relative(root, join(e.parentPath, e.name))).filter((f) => !runtime.has(f));
  if (extra.length) throw new Error("tarball holds files outside the runtime set: " + extra.sort().join(", "));
  const digest = kitDigest(root, files);
  out = { ok: true, version, digest, kitId: kitId({ kind: "package", version, digest }) };
} catch (error) {
  out = { ok: false, error: error.message };
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exitCode = out.ok ? 0 : 1;
