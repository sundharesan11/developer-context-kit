import { join } from "node:path";
import { readPrivateText, atomicReplace } from "../storage/fsx.mjs";
import { sha256, canonicalJson } from "../storage/canonical.mjs";
import { assertWritable } from "./pilot.mjs";
import { DevctxError } from "../errors.mjs";
export async function readRegistry(roots) {
  const text = await readPrivateText(join(roots.configRoot, "registry.json"));
  const value = JSON.parse(text);
  if (value.schemaVersion !== 1) throw new DevctxError("SCHEMA_UNSUPPORTED", "Registry schema unsupported");
  return { value, sha: sha256(text) };
}
export const findByPath = (registry, canonicalPath) => registry.bindings.find((entry) => entry.path === canonicalPath) ?? null;
export async function publishRegistry(roots, next, { expectGeneration }) {
  const path = join(roots.configRoot, "registry.json");
  assertWritable(roots, [path]);
  const current = (await readRegistry(roots)).value;
  if (current.generation !== expectGeneration || next.generation !== expectGeneration + 1) throw new DevctxError("STALE_VERSION", "Registry generation changed");
  await atomicReplace(path, canonicalJson(next) + "\n");
  return { generation: next.generation };
}
