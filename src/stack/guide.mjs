// U19 (R32, R33; KTD16): "how to try this" guides. A guide is a fixed template: the item's catalog name, its kind, the
// digest it came from and its sourced links. It never copies feed text, so an instruction hidden in a title or summary
// cannot reach the guide. Writing a guide creates that one file and nothing else: no sandbox, no project change.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { sha256, digest } from "../storage/canonical.mjs";
import { ensurePrivatePath, fsyncDir, info, readPrivateBytes, readPrivateJson, writeNewFile } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { plainText } from "./feed.mjs";
import { radarItemsPath } from "./digest.mjs";

const ID = /^[0-9a-f]{12}$/;
const KIND_LABELS = { release: "a release in your stack", "agent-tools": "an agent tool or skill", approaches: "an approach or design idea", adjacent: "adjacent tech to try" };
const guideSegments = (scope) => [...(scope ? ["scopes", scope] : []), "guides", "radar"];
const safeUrl = (url) => typeof url === "string" && /^https:\/\/[^\s<>`\p{Cc}\p{Cf}]+$/u.test(url) ? "<" + url + ">" : null;
const code = (text) => { const value = plainText(String(text), 120).replace(/`/g, ""); return "`" + value + "`"; };

async function readItems(roots, scope) {
  let value;
  try { value = await readPrivateJson(radarItemsPath(roots, scope), 1048576); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("NOT_FOUND", "No digest has been written for this scope", { remedy: "stack digest --apply" }); throw error; }
  if (!value || value.schemaVersion !== 1 || value.kind !== "radar-items" || value.scope !== scope || !Array.isArray(value.items)) throw new DevtwinError("INTEGRITY", "Radar items invalid");
  return value;
}
export function renderGuide(item, { scope, digestDate }) {
  const links = [safeUrl(item.link) ? "- Entry: " + safeUrl(item.link) : null, safeUrl(item.sourceUrl) ? "- Source: " + safeUrl(item.sourceUrl) : null].filter(Boolean);
  return [
    "# Try " + code(item.label), "",
    "- Kind: " + (KIND_LABELS[item.kind] ?? "a radar item"),
    "- From: the " + (scope ?? "unscoped") + " digest of " + digestDate,
    "- Item: " + code(item.id), "",
    "## Read first", "",
    "Open the links below. Read what changed and what it needs before you try it.", "",
    ...(links.length ? links : ["No link was kept for this item."]), "",
    "## Try it", "",
    "1. Make a new folder outside your projects for the test.",
    "2. Follow only the official steps on the linked page. devtwin does not run them for you.",
    "3. Write down what worked, what failed and what it cost.",
    "4. Delete the folder when you are done.", "",
    "## Keep what you learned", "",
    "If the result is worth keeping, propose it as a lesson. The lesson goes through the usual review:", "",
    "```sh",
    "devtwin lesson propose --scope <scope> --session <session> --title \"<what you learned>\" --body-file <notes.md>",
    "```", ""
  ].join("\n");
}
// The guide preview; --apply writes it once under the data root. A second apply of the same guide changes nothing.
export async function planGuide(roots, { scope = null, id }) {
  if (scope !== null) assertScopeId(scope);
  if (typeof id !== "string" || !ID.test(id)) throw new DevtwinError("INVALID_INPUT", "Invalid radar item ID", { field: "item" });
  const items = await readItems(roots, scope);
  const item = items.items.find((i) => i.id === id);
  if (!item) throw new DevtwinError("NOT_FOUND", "Item is not in the latest digest", { item: id });
  const markdown = renderGuide(item, { scope, digestDate: items.date });
  const destination = { root: "dataRoot", path: [...guideSegments(scope), "guide-" + id + ".md"].join("/") };
  return finalizePlan({ kind: "radar-guide", scope, item: id, destination, markdown, markdownHash: sha256(markdown), source: digest(item) });
}
export async function applyGuide(roots, input, { fingerprint }) {
  const plan = await planGuide(roots, input);
  assertFingerprint(plan, fingerprint);
  const path = join(roots.dataRoot, ...plan.destination.path.split("/"));
  if (info(path)) {
    if (sha256(await readPrivateBytes(path, 1048576)) === plan.markdownHash) return { written: false, destination: plan.destination };
    throw new DevtwinError("CONFLICT", "A different guide already exists", { destination: plan.destination });
  }
  const dir = join(roots.dataRoot, ...guideSegments(plan.scope));
  return withPilotLock(roots, join(roots.stateRoot, "locks", "radar-guide.lock"), { kind: "radar-guide" }, async () => {
    if (info(path)) throw new DevtwinError("CONFLICT", "A guide was written during this apply", { destination: plan.destination });
    ensurePrivatePath(roots.dataRoot, guideSegments(plan.scope));
    await writeNewFile(path, plan.markdown);
    fsyncDir(dir);
    return { written: true, destination: plan.destination, markdownHash: plan.markdownHash };
  }, { destinations: [dir, path] });
}
