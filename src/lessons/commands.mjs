import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertScopeId, RECORD_ID } from "../identity/ids.mjs";
import { isWithin } from "../storage/fsx.mjs";
import { renderInbound } from "../records/isolation.mjs";
import { LESSON_ID } from "../hubs/read.mjs";
import { buildIndex, rebuildIndex, readIndex, findLesson, findRepoRoot, readCommonDir, resolveRepo } from "./index.mjs";
import { matchLessons, normalizeRelPath, packageName, isStale } from "./match.mjs";
import { commandWords } from "../hooks/shell-words.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const options = { scope: { type: "string" }, cwd: { type: "string" }, path: { type: "string", multiple: true }, package: { type: "string", multiple: true }, text: { type: "string" }, command: { type: "string" }, id: { type: "string" } };
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid lesson match input", { field }); };
// The worktree for --cwd, resolved through the index's path-to-scope map, as the hook does.
function repoFor(index, cwd) {
  let canonical;
  try { canonical = realpathSync(cwd); } catch { throw new DevtwinError("PATH_UNSAFE", "Working directory unavailable"); }
  if (canonical !== resolve(cwd)) throw new DevtwinError("PATH_UNSAFE", "Working directory must be canonical");
  const root = findRepoRoot(canonical);
  const repo = root && resolveRepo(index, { root, commonDir: readCommonDir(root) });
  if (!repo) throw new DevtwinError("PROJECT_UNBOUND", "Worktree not bound in selected scope", { reason: "not-bound-in-scope" });
  return { root, repo };
}
// An absolute --path must sit inside the --cwd worktree. Every path must stay inside the repository.
function relativePath(path, root) {
  if (isAbsolute(path)) {
    if (!root || !isWithin(resolve(path), root)) invalid("path");
    path = relative(root, resolve(path));
  }
  return normalizeRelPath(path) ?? invalid("path");
}
// Read-only: builds the index in memory from current sources, and reports whether the stored index matches.
export const lessonMatchCommand = { options, async run(values, ctx) {
  const scope = assertScopeId(values.scope);
  const index = await buildIndex(ctx.roots, scope);
  let stored;
  try { stored = await readIndex(ctx.roots, scope); } catch { stored = undefined; }
  const state = stored === null ? "missing" : stored === undefined ? "invalid" : stored.fingerprint === index.fingerprint ? "current" : "stale";
  const located = values.cwd === undefined ? null : repoFor(index, values.cwd);
  const paths = list(values.path).map((p) => relativePath(p, located?.root));
  const packages = list(values.package).map((p) => packageName(p) ?? invalid("package"));
  // U32: --command is shell text, split as the hook splits a shell call.
  const matches = matchLessons(index, { paths, packages, text: values.text ?? "", commands: commandWords(values.command ?? ""), project: located?.repo.project ?? null, now: ctx.now() });
  return { scope, repo: located?.repo ?? null, index: state, matches };
} };
// The full lesson as fenced, claimed, capped data (KTD11). Only an effective lesson in the scope's index is shown.
export const lessonShowCommand = { options, async run(values, ctx) {
  const scope = assertScopeId(values.scope);
  if (!RECORD_ID.test(values.id ?? "") && !LESSON_ID.test(values.id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid record ID");
  const found = await findLesson(ctx.roots, scope, values.id);
  if (!found) throw new DevtwinError("NOT_FOUND", "No effective lesson with this ID", { id: values.id });
  const { entry, body } = found;
  return { id: entry.id, kind: entry.kind, reach: entry.reach, scope: entry.scope, project: entry.project, claimedBy: entry.claimedBy, revisitAfter: entry.revisitAfter, stale: isStale(entry, ctx.now()), ...(entry.contested ? { contested: true } : {}), recordHash: entry.recordHash, text: renderInbound(entry.title + "\n\n" + body, { handle: entry.claimedBy }) };
} };
// Rebuilds stateRoot/lessons/<scope>.json. The file is a cache of record data, so the write needs no plan fingerprint.
export const lessonIndexCommand = { options: { scope: { type: "string" } }, run: (values, ctx) => rebuildIndex(ctx.roots, assertScopeId(values.scope)) };

// U11: lesson propose (agent-callable, private, at most three per session) and the owner's proposals, edit, reject,
// accept and copy. Each state change previews first. propose applies with --apply, as record propose does; reject,
// edit, accept and copy apply with --apply and the plan fingerprint. accept to a hub and copy show the owner dialog.
const lessonOptions = { session: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, path: { type: "string", multiple: true }, package: { type: "string", multiple: true }, topic: { type: "string", multiple: true }, command: { type: "string", multiple: true }, apply: { type: "boolean" } };
const BODY_BYTES = 32768;
async function readStdin(stdin) {
  if (typeof stdin === "string") return stdin;
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") throw new DevtwinError("INVALID_INPUT", "Body file unavailable", { field: "body-file" });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    bytes += chunk.length;
    if (bytes > BODY_BYTES) throw new DevtwinError("INVALID_INPUT", "Body file unavailable", { field: "body-file" });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
// --body, --body-file <file inside the pilot inputs folder> or --body-file - for stdin. undefined when none is given.
async function bodyFrom(values, ctx) {
  if (values.body !== undefined && values["body-file"] !== undefined) throw new DevtwinError("USAGE", "Choose one body input");
  if (values["body-file"] === undefined) return values.body;
  if (values["body-file"] === "-") return readStdin(ctx.stdin);
  const { dirname, relative } = await import("node:path");
  const { assertInPilot } = await import("../config/pilot.mjs");
  const { readApprovedSource } = await import("../storage/source-read.mjs");
  assertInPilot(ctx.pilot, dirname(values["body-file"]), "inputsRoot");
  const read = await readApprovedSource(ctx.pilot.inputsRoot, relative(ctx.pilot.inputsRoot, values["body-file"]));
  if (read.skipped || Buffer.byteLength(read.text) > BODY_BYTES) throw new DevtwinError("INVALID_INPUT", "Body file unavailable", { field: "body-file" });
  return read.text;
}
// U32: --command is a command prefix of one to three lower-case words, such as "git push".
const matchFrom = (values) => values.path === undefined && values.package === undefined && values.topic === undefined && values.command === undefined ? undefined
  : { paths: list(values.path), packages: list(values.package), topics: list(values.topic), ...(values.command === undefined ? {} : { commands: list(values.command) }) };
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const planOptions = { id: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
export const lessonProposeCommand = { options: lessonOptions, async run(values, ctx) {
  const { proposeLesson } = await import("./propose.mjs");
  const lesson = { title: values.title, summary: values.summary ?? null, text: await bodyFrom(values, ctx) ?? "", match: matchFrom(values) ?? {} };
  return proposeLesson(ctx.roots, { session: values.session, scope: values.scope, project: values.project ?? null, lesson }, { now: ctx.now, apply: values.apply ?? false });
} };
export const lessonProposalsCommand = { options: { scope: { type: "string" }, all: { type: "boolean" } }, run: async (values, ctx) => (await import("./propose.mjs")).listProposals(ctx.roots, { scope: values.scope, all: values.all ?? false }) };
export const lessonRejectCommand = { options: planOptions, async run(values, ctx) {
  const propose = await import("./propose.mjs");
  if (!values.apply) return propose.planReject(ctx.roots, { id: values.id });
  needPlan(values);
  return propose.applyReject(ctx.roots, { id: values.id }, { fingerprint: values["plan-fingerprint"], now: ctx.now });
} };
export const lessonEditCommand = { options: { ...lessonOptions, ...planOptions }, async run(values, ctx) {
  const propose = await import("./propose.mjs");
  const input = { id: values.id, title: values.title, summary: values.summary, text: await bodyFrom(values, ctx), match: matchFrom(values) };
  if (!values.apply) return propose.planEdit(ctx.roots, input);
  needPlan(values);
  return propose.applyEdit(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now });
} };
// U37: --session names the agent session for the audit entry, so that session may undo the write itself.
export const lessonAcceptCommand = { options: { ...planOptions, target: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, session: { type: "string" } }, async run(values, ctx) {
  const publish = await import("./publish.mjs");
  const input = { id: values.id, target: values.target, scope: values.scope, project: values.project, session: values.session ?? null };
  if (!values.apply) return publish.planAccept(ctx.roots, input);
  needPlan(values);
  return publish.applyAccept(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
// U12: lesson supersede-propose (agent-callable, like propose) and lesson notices. The notices list is open to agents;
// --ack previews, and --ack --apply with the plan fingerprint is an owner action that the hook denies from agent shells.
export const lessonSupersedeProposeCommand = { options: { ...lessonOptions, predecessor: { type: "string" }, target: { type: "string" } }, async run(values, ctx) {
  const { proposeSupersede } = await import("./supersede.mjs");
  const lesson = { title: values.title, summary: values.summary ?? null, text: await bodyFrom(values, ctx) ?? "", match: matchFrom(values) ?? {} };
  if (values.target === "server") return (await import("./supersede.mjs")).proposeServerSupersede(ctx.roots, { session: values.session, scope: values.scope, project: values.project ?? null, predecessor: values.predecessor, lesson }, { now: ctx.now, apply: values.apply ?? false });
  if (values.target !== undefined && values.target !== "hub") throw new DevtwinError("INVALID_INPUT", "Invalid replacement target", { field: "target" });
  return proposeSupersede(ctx.roots, { session: values.session, scope: values.scope, project: values.project ?? null, predecessor: values.predecessor, lesson }, { now: ctx.now, apply: values.apply ?? false });
} };
export const lessonNoticesCommand = { options: { scope: { type: "string" }, id: { type: "string" }, ack: { type: "boolean" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const supersede = await import("./supersede.mjs");
  if (!values.ack) {
    if (values.apply) throw new DevtwinError("USAGE", "lesson notices applies only with --ack");
    return supersede.listNotices(ctx.roots, { scope: values.scope });
  }
  const input = { scope: values.scope, id: values.id };
  if (!values.apply) return supersede.planNoticeAck(ctx.roots, input);
  needPlan(values);
  return supersede.applyNoticeAck(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now });
} };
export const lessonCopyCommand = { options: { ...planOptions, "to-scope": { type: "string" } }, async run(values, ctx) {
  const publish = await import("./publish.mjs");
  const input = { id: values.id, toScope: values["to-scope"] };
  if (!values.apply) return publish.planCopy(ctx.roots, input);
  needPlan(values);
  return publish.applyCopy(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
