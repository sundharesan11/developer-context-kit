import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { loadScope } from "../config/store.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { atomicReplace, ensurePrivatePath, readPrivateJson, writeNewFile } from "../storage/fsx.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { readConsent } from "../consent/store.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { HELD_ID, listHeld, removeHeld, withHeldLock, isDue } from "../held/queue.mjs";
import { consentGap, markState } from "../held/send.mjs";
import { readAudit } from "../audit/log.mjs";

const NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const CLIENT = /^[a-z][a-z0-9-]{1,63}$/;
const LEARNING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const pathFor = (roots, scope) => join(roots.configRoot, "servers", assertScopeId(scope) + ".json");
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid knowledge server binding", { field }); };
export const serverTarget = (scope) => "server:" + assertScopeId(scope);
export async function readServerBinding(roots, scope) {
  let value;
  try { value = await readPrivateJson(pathFor(roots, scope), 4096); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (value?.schemaVersion !== 1 || value.scope !== scope || !NAME.test(value.server ?? "") || !CLIENT.test(value.client ?? "") || Object.keys(value).some((key) => !["schemaVersion", "scope", "server", "client"].includes(key))) throw new DevtwinError("INTEGRITY", "Knowledge server binding invalid");
  return value;
}
export async function requireServerBinding(roots, scope) {
  const binding = await readServerBinding(roots, scope);
  if (!binding) throw new DevtwinError("GATE_REQUIRED", "Scope has no knowledge server binding", { scope });
  return binding;
}
async function bindingForPlan(roots, scope) {
  try { return await readServerBinding(roots, scope); }
  catch (error) { if (error.code === "DEVTWIN_INTEGRITY") return { invalid: true }; throw error; }
}
export async function planBind(roots, { scope, name, client }) {
  assertScopeId(scope);
  await loadScope(roots, scope);
  if (!NAME.test(name ?? "")) invalid("name");
  if (!CLIENT.test(client ?? "")) invalid("client");
  return finalizePlan({ kind: "server-bind", scope, server: name, client, current: await bindingForPlan(roots, scope) });
}
export async function applyBind(roots, input, { fingerprint, ctx = {} } = {}) {
  const plan = await planBind(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, { title: "Bind a knowledge server", body: "Scope: " + plan.scope + "\nMCP server: " + plan.server + "\nClient: " + plan.client + (plan.current?.invalid ? "\nReplace the damaged binding." : "") + "\nAgents can search this client and submit held lessons after consent." });
  const path = pathFor(roots, plan.scope);
  assertWritable(roots, [path]);
  if (canonicalJson(await bindingForPlan(roots, plan.scope)) !== canonicalJson(plan.current)) throw new DevtwinError("STALE_VERSION", "Knowledge server binding changed");
  ensurePrivatePath(roots.configRoot, ["servers"]);
  await atomicReplace(path, canonicalJson({ schemaVersion: 1, scope: plan.scope, server: plan.server, client: plan.client }) + "\n");
  return { scope: plan.scope, server: plan.server, client: plan.client };
}

// Every value comes from the accepted lesson and the bound client. The CLI never calls MCP.
export function learningArguments(binding, lesson, repo = null) {
  const problem = lesson.summary ?? lesson.title;
  const solution = lesson.text.trim();
  const tags = [...new Set([...(lesson.match.topics ?? []), ...(lesson.match.packages ?? [])])];
  const doc_body = [
    "# " + lesson.title, "", "## Context", repo ?? "Client: " + binding.client, "",
    "## Symptom", problem, "", "## Investigation", "See the accepted lesson.", "",
    "## Root cause", "Not recorded.", "", "## Fix", solution, "",
    "## Verification", "Not recorded.", "", "## References", "Not recorded.", ""
  ].join("\n");
  return { client: binding.client, title: lesson.title, problem, solution, root_cause: "Not recorded.", tags, repo, doc_body };
}

async function itemFor(roots, id) {
  if (!HELD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid held item ID");
  const item = (await listHeld(roots)).find((x) => x.id === id);
  if (!item || item.kind !== "server-lesson") throw new DevtwinError("NOT_FOUND", "No held server lesson with this ID", { id });
  return item;
}
export async function serverPayload(roots, id, { now = () => new Date() } = {}) {
  const item = await itemFor(roots, id);
  if (!isDue(item, now())) throw new DevtwinError("GATE_REQUIRED", "Server lesson is still held", { sendAfter: item.sendAfter });
  const scope = item.payload.scope;
  const binding = await requireServerBinding(roots, scope);
  if (binding.server !== item.payload.server || binding.client !== item.payload.client) throw new DevtwinError("STALE_VERSION", "Knowledge server binding changed");
  if (item.payload.arguments?.client !== binding.client) throw new DevtwinError("INTEGRITY", "Server payload client does not match binding");
  if (consentGap(item, await readConsent(roots, "server-publish", scope))) throw new DevtwinError("APPROVAL_REQUIRED", "Server consent changed");
  assertOutboundClean(JSON.stringify(item.payload.arguments), await isolationTerms(roots), { except: scope });
  const issuedPath = join(roots.stateRoot, "server-issued", id + ".json");
  assertWritable(roots, [issuedPath]);
  ensurePrivatePath(roots.stateRoot, ["server-issued"]);
  const issued = { schemaVersion: 1, id, audit: item.audit, scope, server: binding.server, client: binding.client, supersedes: item.payload.supersedes ?? null };
  try { await writeNewFile(issuedPath, canonicalJson(issued) + "\n"); }
  catch (error) {
    if (error.code !== "DEVTWIN_CONFLICT") throw error;
    if (canonicalJson(await readPrivateJson(issuedPath, 4096)) !== canonicalJson(issued)) throw new DevtwinError("INTEGRITY", "Server payload issuance changed", { id });
  }
  return { id, server: binding.server, tool: "log_learning", arguments: item.payload.arguments };
}
export async function recordLearning(roots, id, learningId, { now = () => new Date() } = {}) {
  if (!HELD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid held item ID");
  if (!LEARNING_ID.test(learningId ?? "")) invalid("learning-id");
  const receiptPath = join(roots.stateRoot, "server-receipts", id + ".json");
  let prior = null;
  try { prior = await readPrivateJson(receiptPath, 4096); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (prior) {
    if (prior.learningId !== learningId) throw new DevtwinError("CONFLICT", "Held item was recorded with another learning ID", { id });
    const sent = (await readAudit(roots)).entries.some((x) => x.kind === "held-state" && x.target === "sent" && x.itemIds.includes(id));
    if (sent) return { id, learningId, sent: true, repeated: true };
  }
  const { item, repeated } = await withHeldLock(roots, "server-record", async () => {
    let existing = null;
    try { existing = await readPrivateJson(receiptPath, 4096); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing && existing.learningId !== learningId) throw new DevtwinError("CONFLICT", "Held item was recorded with another learning ID", { id });
    if (existing && (await readAudit(roots)).entries.some((x) => x.kind === "held-state" && x.target === "sent" && x.itemIds.includes(id))) return { item: null, repeated: true };
    let current;
    try { current = await itemFor(roots, id); }
    catch (error) {
      if (error.code !== "DEVTWIN_NOT_FOUND") throw error;
      let issued;
      try { issued = await readPrivateJson(join(roots.stateRoot, "server-issued", id + ".json"), 4096); }
      catch (readError) { if (readError.code === "ENOENT") throw error; throw readError; }
      const source = (await readAudit(roots)).entries.find((x) => x.kind === "server-lesson" && x.id === issued.audit && x.itemIds.includes(id));
      if (!source || issued.id !== id || issued.scope !== source.scope || !CLIENT.test(issued.client ?? "") || !NAME.test(issued.server ?? "")) throw new DevtwinError("INTEGRITY", "Server payload issuance invalid", { id });
      current = { id, audit: issued.audit, target: serverTarget(issued.scope), payload: issued };
    }
    if (current.sendAfter && !isDue(current, now())) throw new DevtwinError("GATE_REQUIRED", "Server lesson is still held");
    if (existing) return { item: current, repeated: true };
    if (current.sendAfter) await serverPayload(roots, id, { now });
    let receipts = [];
    try { receipts = await readdir(join(roots.stateRoot, "server-receipts")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of receipts.filter((x) => /^hld_[a-f0-9]{24}\.json$/.test(x))) {
      const other = await readPrivateJson(join(roots.stateRoot, "server-receipts", name), 4096);
      if (other.scope === current.payload.scope && other.server === current.payload.server && other.client === current.payload.client && other.learningId === learningId) throw new DevtwinError("CONFLICT", "Learning ID already belongs to another held item", { id });
    }
    assertWritable(roots, [receiptPath]);
    ensurePrivatePath(roots.stateRoot, ["server-receipts"]);
    await writeNewFile(receiptPath, canonicalJson({ schemaVersion: 1, id, scope: current.payload.scope, server: current.payload.server, client: current.payload.client, learningId, audit: current.audit, supersedes: current.payload.supersedes ?? null }) + "\n");
    return { item: current, repeated: false };
  });
  if (!item) return { id, learningId, sent: true, repeated: true };
  await markState(roots, item, "sent", { now, route: "server record", extra: ["srv_" + digest(learningId).slice(7, 31)] });
  await withHeldLock(roots, "server-record", async () => removeHeld(roots, item.target, id));
  return { id, learningId, sent: true, ...(repeated ? { repeated: true } : {}) };
}
export async function supersedePayload(roots, id) {
  if (!HELD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid held item ID");
  let receipt;
  try { receipt = await readPrivateJson(join(roots.stateRoot, "server-receipts", id + ".json"), 4096); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("NOT_FOUND", "No recorded server replacement with this ID", { id }); throw error; }
  if (!receipt.supersedes) throw new DevtwinError("INVALID_INPUT", "Lesson does not replace another server lesson", { id });
  if (!(await readAudit(roots)).entries.some((x) => x.kind === "held-state" && x.target === "sent" && x.itemIds.includes(id))) throw new DevtwinError("NOT_FOUND", "Server replacement is not recorded as sent", { id });
  const binding = await requireServerBinding(roots, receipt.scope);
  if (binding.server !== receipt.supersedes.server || binding.client !== receipt.supersedes.client) throw new DevtwinError("STALE_VERSION", "Knowledge server binding changed");
  return { id, server: binding.server, tool: "supersede_learning", arguments: { client: binding.client, old_id: receipt.supersedes.id, new_id: receipt.learningId, reason: "Accepted replacement lesson" } };
}
export async function serverPredecessor(roots, scope, id) {
  if (!LEARNING_ID.test(id ?? "")) invalid("predecessor");
  const binding = await requireServerBinding(roots, scope);
  const sentIds = new Set((await readAudit(roots)).entries.filter((x) => x.kind === "held-state" && x.target === "sent").flatMap((x) => x.itemIds));
  let names;
  try { names = await readdir(join(roots.stateRoot, "server-receipts")); }
  catch (error) { if (error.code === "ENOENT") names = []; else throw error; }
  for (const name of names.filter((x) => /^hld_[a-f0-9]{24}\.json$/.test(x))) {
    const receipt = await readPrivateJson(join(roots.stateRoot, "server-receipts", name), 4096);
    if (receipt.scope === scope && receipt.server === binding.server && receipt.client === binding.client && receipt.learningId === id && sentIds.has(receipt.id)) return { id, server: binding.server, client: binding.client };
  }
  throw new DevtwinError("NOT_FOUND", "No recorded server learning with this ID", { id });
}

export const serverBindCommand = { options: { scope: { type: "string" }, name: { type: "string" }, client: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(v, ctx) {
  const input = { scope: v.scope, name: v.name, client: v.client };
  if (!v.apply) return planBind(ctx.roots, input);
  if (!v["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyBind(ctx.roots, input, { fingerprint: v["plan-fingerprint"], ctx });
} };
export const serverStatusCommand = { options: { scope: { type: "string" } }, async run(v, ctx) {
  const scope = assertScopeId(v.scope), binding = await bindingForPlan(ctx.roots, scope);
  if (binding?.invalid) return { scope, server: null, invalid: true };
  return binding ? { scope, server: binding.server, client: binding.client } : { scope, server: null };
} };
export const serverPayloadCommand = { options: { id: { type: "string" } }, run: (v, ctx) => serverPayload(ctx.roots, v.id, { now: ctx.now }) };
export const serverRecordCommand = { options: { id: { type: "string" }, "learning-id": { type: "string" } }, run: (v, ctx) => recordLearning(ctx.roots, v.id, v["learning-id"], { now: ctx.now }) };
export const serverSupersedeCommand = { options: { id: { type: "string" } }, run: (v, ctx) => supersedePayload(ctx.roots, v.id) };
