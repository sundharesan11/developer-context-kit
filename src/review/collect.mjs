// U21 (R34, R35, R36; R19 of the promotion plan): the monthly setup review. `review plan` collects suggestions from what
// devtwin already keeps. Each suggestion is one line: a stable ID (from its kind and target), the kind, the target, the
// evidence (IDs, counts, hashes, dates and paths, never record or preference text) and the proposed change. The
// collectors only read; nothing here writes.
//   preference-overridden  an active preference whose topic got a later pending or accepted proposal: the developer
//                          corrected the agent again, so the saved rule may be wrong. Change: pref retire.
//   preference-declined    a topic with two or more declined proposals and no active preference: agents keep asking.
//                          Informational: write the rule yourself, or leave it.
//   sandbox-setting        a repository with accepted sandbox settings whose latest scan recommends another set: a new
//                          recommendation (change: setup apply --step sandbox for that one), a changed text or one the
//                          scan no longer recommends (informational).
//   radar-interest         a radar item you wrote a try-it guide for (radar guide --apply), whose name is not one of
//                          your radar interests. Change: profile apply adding it. At most as many lines as the
//                          profile has room for (30 interests).
//   promoted-source-changed  an imported record whose source changed since the import, or whose change the import
//                          skipped because the record was reviewed. Informational.
//   promoted-source-removed  an imported record whose source file is gone. Change: undo of the import's audit entry,
//                          when that entry replaced nothing; otherwise informational.
//   promoted-source-skipped  an imported record whose source is still there but the import now skips (unreadable,
//                          too large, a symlink...). The evidence names the reason. Informational.
//   lesson-unused          a lesson older than 30 days that the hooks did not deliver in the last 30 days (the budget
//                          log's lesson IDs, from hook injections and from the summary's ask-before lines). Change:
//                          undo of the entry that wrote it, when there is one. Collected only when the budget log
//                          reaches back at least 30 days; otherwise plan lists it under notCollected.
//   memory-delivered-twice an imported Claude memory whose file still exists, so sessions read it twice. devtwin never
//                          edits memory: the suggestion points at the file, and the owner decides. Informational.
//   consent-unused         a consent older than 30 days with no audit entry under it since it was granted.
//                          Change: consent revoke.
//   learning-branch-stale  a learning branch that stayed local (never queued) for more than 14 days. Informational:
//                          delete it yourself, or send it. Its reason is shown but not hashed, so a new reason alone
//                          does not bring a decided line back.
// Skill and template use is not collected: the hook log records error codes only, not which skill or template ran.
import { join } from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { digest } from "../storage/canonical.mjs";
import { readPrivateText } from "../storage/fsx.mjs";
import { configuredScopes } from "../records/isolation.mjs";

export const SUGGESTION_ID = /^sug_[a-f0-9]{24}$/;
export const SUGGESTION_KINDS = Object.freeze(["preference-overridden", "preference-declined", "sandbox-setting", "radar-interest", "promoted-source-changed",
  "promoted-source-removed", "promoted-source-skipped", "lesson-unused", "memory-delivered-twice", "consent-unused", "learning-branch-stale"]);
export const NOT_COLLECTED = Object.freeze([{ kind: "skill-template-use", reason: "The hook log records error codes only, not which skill or template ran." }]);
export const INTEREST_MAX = 30;
const DAY_MS = 86400000, UNUSED_DAYS = 30, BRANCH_DAYS = 14, DECLINED_MIN = 2, INTEREST_CHARS = 80;
const suggestionId = (kind, target) => "sug_" + digest({ kind, target }).slice(7, 31);
// One line. change.action names the route that makes the change ({ plan, apply, values }); without it the change is
// informational and accepting it only records the decision. shown joins the evidence without counting in its hash.
const line = (kind, target, evidence, change, shown = {}) => ({ id: suggestionId(kind, target), kind, target, evidence: { ...evidence, ...shown }, evidenceHash: digest(evidence), change });
const older = (iso, days, now) => typeof iso === "string" && Date.parse(iso) < now().getTime() - days * DAY_MS;
// A collector that fails reports its code and gives no lines, so one damaged store does not hide the rest.
const failure = (error) => error?.code ?? "DEVTWIN_INTERNAL";

async function preferences(roots) {
  const { activePreferences, listPreferenceProposals } = await import("../prefs/store.mjs");
  const active = await activePreferences(roots), proposals = (await listPreferenceProposals(roots, { all: true })).proposals, out = [];
  for (const pref of active.filter((p) => p.topic)) {
    const later = proposals.filter((p) => p.topic === pref.topic && ["pending", "accepted"].includes(p.state) && p.outcome?.recordId !== pref.id && p.createdAt > pref.createdAt);
    if (!later.length) continue;
    out.push(line("preference-overridden", pref.id, { preference: pref.id, recordHash: pref.recordHash, topic: pref.topic, savedAt: pref.createdAt, later: later.map((p) => ({ id: p.id, state: p.state, at: p.createdAt })) },
      { text: "Retire the saved preference. A later correction on the same topic suggests it no longer holds.", command: "devtwin pref retire --id " + pref.id, action: { plan: "pref retire", apply: "pref retire", values: { id: pref.id } } }));
  }
  const declined = new Map();
  for (const p of proposals.filter((p) => p.state === "declined" && p.topic)) declined.set(p.topic, [...(declined.get(p.topic) ?? []), p.id]);
  for (const [topic, ids] of [...declined].sort()) {
    if (ids.length < DECLINED_MIN || active.some((p) => p.topic === topic)) continue;
    out.push(line("preference-declined", "topic:" + topic, { topic, declined: ids.sort() },
      { text: "Agents proposed " + ids.length + " rules on this topic and you declined each. Write the rule you want with pref propose, or leave it." }));
  }
  return out;
}

async function sandbox(roots) {
  const { scanSignals, recommend, sandboxRequestFor } = await import("../setup/sandbox.mjs");
  const { readPersonalSnapshot } = await import("../records/personal.mjs");
  const records = (await readPersonalSnapshot(roots)).records.filter((r) => r.requestId.startsWith("req_setup_sandbox_") && r.effective !== "superseded");
  const out = [];
  for (const repo of roots.pilot?.repos ?? []) {
    const suffix = "_" + sandboxRequestFor(repo, "x").split("_").at(-1), saved = records.filter((r) => r.requestId.endsWith(suffix));
    if (!saved.length) continue;
    let recs;
    try { recs = recommend(await scanSignals(roots.pilot, repo)); } catch { continue; }
    const byRequest = new Map(saved.map((r) => [r.requestId, r]));
    for (const rec of recs) {
      const record = byRequest.get(sandboxRequestFor(repo, rec.id)), textHash = digest({ text: rec.text });
      if (!record) out.push(line("sandbox-setting", repo + "#" + rec.id, { repo, recommendation: rec.id, state: "new", textHash },
        { text: "The latest scan recommends a setting you have not saved. Save it.", command: "devtwin setup apply --step sandbox --repo " + repo + " --recommendation " + rec.id,
          action: { plan: "setup plan", apply: "setup apply", values: { step: "sandbox", repo, recommendation: [rec.id] } } }));
      else if (record.body !== rec.text + "\n") out.push(line("sandbox-setting", repo + "#" + rec.id, { repo, recommendation: rec.id, state: "changed", record: record.id, recordHash: record.recordHash, textHash },
        { text: "The latest scan recommends other text for this setting. Run devtwin setup plan --step sandbox --repo " + repo + " to read it, and change your agent settings by hand if you agree." }));
    }
    for (const record of saved) {
      const id = record.requestId.slice("req_setup_sandbox_".length, -suffix.length);
      if (!recs.some((r) => r.id === id)) out.push(line("sandbox-setting", repo + "#" + id, { repo, recommendation: id, state: "gone", record: record.id, recordHash: record.recordHash },
        { text: "The latest scan no longer recommends this setting. Check whether your agent settings still need it." }));
    }
  }
  return out;
}

const GUIDE = /^guide-([0-9a-f]{12})\.md$/, TITLE = /^# Try `([^`\r\n]{1,120})`$/m;
async function radar(roots) {
  const { readProfile } = await import("../profile/store.mjs");
  const { parseInterests } = await import("../stack/rank.mjs");
  const { INTEREST } = await import("../profile/validate.mjs");
  const interests = (await readProfile(roots)).profile?.radar?.interests ?? [], terms = new Set(parseInterests(interests).map((i) => i.term.toLowerCase()));
  // The profile holds at most INTEREST_MAX interests: suggest no more than it has room for.
  const room = INTEREST_MAX - interests.length;
  if (room <= 0) return [];
  const out = [], seen = new Set();
  for (const scope of [null, ...(await configuredScopes(roots)).sort()]) {
    const dir = join(roots.dataRoot, ...(scope ? ["scopes", scope] : []), "guides", "radar");
    let names;
    try { names = (await readdir(dir)).filter((n) => GUIDE.test(n)).sort(); } catch { continue; }
    for (const name of names) {
      if (out.length >= room) return out;
      // The guide's title is the catalog name devtwin wrote (src/stack/guide.mjs), never feed text.
      let label;
      try { label = TITLE.exec(await readPrivateText(join(dir, name), 65536))?.[1]?.trim(); } catch { continue; }
      if (!label || [...label].length > INTEREST_CHARS || !INTEREST.test(label) || terms.has(label.toLowerCase()) || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push(line("radar-interest", "interest:" + label.toLowerCase(), { item: GUIDE.exec(name)[1], scope, guide: [...(scope ? ["scopes", scope] : []), "guides", "radar", name].join("/"), interests: interests.length },
        { text: "You wrote a try-it guide for this radar item. Add it to your radar interests, so the radar ranks items like it higher.", command: "devtwin profile apply --interest <current interests> --interest " + JSON.stringify(label),
          action: { plan: "profile plan", apply: "profile apply", values: {}, addInterest: label } }));
    }
  }
  return out;
}

// The audit entry that wrote a record, when it wrote only that record, replaced nothing, landed and is not undone:
// undoing it retracts the record and nothing else.
async function undoableEntry(roots, entries, done, recordId) {
  const { landed } = await import("../audit/log.mjs");
  const entry = entries.filter((e) => e.kind === "record" && e.recordIds.length === 1 && e.recordIds[0] === recordId).at(-1);
  return entry && !entry.supersedes.length && !done.has(entry.id) && landed(roots, entry) ? entry : null;
}
const undoChange = (text, entry) => ({ text, command: "devtwin undo --id " + entry.id, action: { plan: "undo", apply: "undo", values: { id: entry.id } } });

// True when a memory source file is absent from its folder (lstat ENOENT). Any other answer counts as present.
async function gone(folder, source) {
  if (!folder) return true;
  try { await lstat(join(folder, "memory", source.slice(source.indexOf("/") + 1))); return false; } catch (error) { return error.code === "ENOENT"; }
}
async function promoted(roots, ctx, audit) {
  const { gather, readSeen } = await import("../import/commands.mjs");
  const { readSnapshot } = await import("../records/store.mjs");
  const seen = await readSeen(roots), sources = Object.entries(seen.sources).filter(([, s]) => typeof s?.recordId === "string").sort(([a], [b]) => a < b ? -1 : 1);
  if (!sources.length) return [];
  const { items, projects, skipped, memoryFolders } = await gather(roots, { env: ctx.env ?? process.env });
  const current = new Map(items.map((i) => [i.source, i])), left = new Map(skipped.map((k) => [k.source, k.reason])), out = [], snapshots = new Map();
  const read = (s) => projects.find((p) => p.scope === s.scope && p.project === s.project);
  const record = async (s) => {
    const key = s.scope + "\0" + s.project;
    if (!snapshots.has(key)) snapshots.set(key, await readSnapshot(roots, s.scope, s.project).then((snap) => snap.records, () => []));
    return snapshots.get(key).find((r) => r.id === s.recordId) ?? null;
  };
  for (const [source, s] of sources) {
    const type = source.split(":")[0], item = current.get(source), report = read(s);
    if (!report || report[type === "memory" ? "memory" : "solutions"] !== "read") continue;
    const r = await record(s);
    if (!r || r.effective === "superseded" || r.kind === "retraction") continue;
    // A source the import skips (unreadable, too large, a symlink) is still there: say why, and retract nothing.
    if (!item && (left.has(source) || (type === "memory" && !await gone(memoryFolders.get(s.scope + "\0" + s.project), source)))) {
      out.push(line("promoted-source-skipped", s.recordId, { source, record: s.recordId, scope: s.scope, project: s.project, seenHash: s.hash, reason: left.get(source) ?? "unreadable" },
        { text: "The import skips the source of this imported record now (" + (left.get(source) ?? "unreadable") + "), so it cannot tell whether the record still holds. Fix the file, or retract the record by hand." }));
      continue;
    }
    if (!item) {
      const entry = await undoableEntry(roots, audit.entries, audit.done, s.recordId);
      const text = "The source of this imported record is gone. Retract the record.";
      out.push(line("promoted-source-removed", s.recordId, { source, record: s.recordId, scope: s.scope, project: s.project, seenHash: s.hash },
        entry ? undoChange(text, entry) : { text: text + " The record replaced an earlier one, so retract it by hand with record supersede." }));
      continue;
    }
    const reviewed = s.state === "skipped" && ["owner-reviewed", "branched"].includes(s.reason);
    if (item.hash !== s.hash || reviewed) {
      out.push(line("promoted-source-changed", s.recordId, { source, record: s.recordId, scope: s.scope, project: s.project, seenHash: s.hash, currentHash: item.hash, state: s.state, ...(s.reason ? { reason: s.reason } : {}) },
        { text: reviewed ? "The source changed after you reviewed this record, so the import left it alone. Compare them, and replace the record with record supersede if it should change."
          : "The source changed since the last import. The next import run updates the record." }));
    }
    if (type === "memory" && s.state === "written" && item.path) {
      out.push(line("memory-delivered-twice", source, { source, record: s.recordId, scope: s.scope, project: s.project, file: item.path },
        { text: "Sessions read this as Claude memory and as a devtwin record. devtwin never edits memory: delete the memory file yourself if you want only the record." }));
    }
  }
  return out;
}

// The budget log rotates and starts empty: unless its oldest line is UNUSED_DAYS old, a missing delivery proves nothing,
// so the collector does not run.
async function lessons(roots, ctx, audit, skip) {
  const { readIndex } = await import("../lessons/index.mjs");
  const { lastDelivered } = await import("../hooks/session.mjs");
  const { delivered, oldest } = await lastDelivered(roots.stateRoot), since = new Date(ctx.now().getTime() - UNUSED_DAYS * DAY_MS).toISOString(), out = [], seen = new Set();
  if (oldest === null) { skip("lesson-unused", "The budget log is empty, so devtwin cannot tell which lessons sessions got."); return []; }
  if (oldest > since) { skip("lesson-unused", "The budget log covers less than " + UNUSED_DAYS + " days, so devtwin cannot tell which lessons sessions got."); return []; }
  for (const scope of (await configuredScopes(roots)).sort()) {
    let index;
    try { index = await readIndex(roots, scope); } catch { continue; }
    // Hub lessons are a colleague's; only the owner's own lessons are suggested.
    for (const entry of index?.entries ?? []) {
      if (entry.kind !== "lesson" || entry.source === "hub" || seen.has(entry.id) || !older(entry.createdAt, UNUSED_DAYS, ctx.now) || (delivered.get(entry.id) ?? "") >= since) continue;
      seen.add(entry.id);
      const written = await undoableEntry(roots, audit.entries, audit.done, entry.id);
      const text = "No session got this lesson in " + UNUSED_DAYS + " days. Retract it, or keep it if it guards a rare case.";
      out.push(line("lesson-unused", entry.id, { lesson: entry.id, scope, source: entry.source, createdAt: entry.createdAt, lastDelivered: delivered.get(entry.id) ?? null },
        written ? undoChange(text, written) : { text: text + " devtwin has no audit entry that wrote it alone, so retract it by hand." }));
    }
  }
  return out;
}

async function consents(roots, ctx, audit) {
  const { listConsents } = await import("../consent/store.mjs");
  const { learningRoot } = await import("../learnings/repo-write.mjs");
  const rootOf = new Map(), out = [];
  const repoOf = async (e) => {
    const key = e.scope + "\0" + e.project;
    if (!rootOf.has(key)) rootOf.set(key, await learningRoot(roots, e.scope, e.project).catch(() => null));
    return rootOf.get(key);
  };
  for (const c of (await listConsents(roots)).filter((c) => c.valid && older(c.grantedAt, UNUSED_DAYS, ctx.now))) {
    const after = audit.entries.filter((e) => e.at >= c.grantedAt);
    let used = false;
    if (c.kind === "hub-publish") used = after.some((e) => (e.kind === "hub-lesson" || e.kind === "held-state") && e.scope === c.target);
    else for (const e of after.filter((e) => e.kind === "repo-learning")) if (await repoOf(e) === c.target) { used = true; break; }
    if (used) continue;
    const flag = c.kind === "repo-push" ? { repo: c.target } : { scope: c.target };
    out.push(line("consent-unused", c.kind + ":" + c.target, { kind: c.kind, target: c.target, grantedAt: c.grantedAt, ruleDigest: c.ruleDigest },
      { text: "Nothing ran under this consent since you granted it. Revoke it; you can grant it again when you need it.", command: "devtwin consent revoke --kind " + c.kind + (c.kind === "repo-push" ? " --repo " : " --scope ") + c.target,
        action: { plan: "consent revoke", apply: "consent revoke", values: { kind: c.kind, ...flag } } }));
  }
  return out;
}

async function branches(roots, ctx) {
  const { waitingBranches } = await import("../learnings/push.mjs");
  const { learningRoot } = await import("../learnings/repo-write.mjs");
  const out = [];
  for (const b of (await waitingBranches(roots)).filter((b) => older(b.at, BRANCH_DAYS, ctx.now))) {
    const root = await learningRoot(roots, b.scope, b.project).catch(() => null);
    out.push(line("learning-branch-stale", b.branch, { branch: b.branch, audit: b.audit, writtenAt: b.at, scope: b.scope, project: b.project, root },
      { text: "This learning branch stayed on your machine for more than " + BRANCH_DAYS + " days. Delete it yourself" + (root ? " with git -C " + root + " branch -D " + b.branch : "") + ", or send it with devtwin learning send --branch " + b.branch + "." }, { reason: b.reason }));
  }
  return out;
}

// Every suggestion, sorted by kind and target, the collectors that failed, and what was not collected (NOT_COLLECTED
// and the collectors that skipped this run, with the reason). ctx: { now, env }.
export async function collectSuggestions(roots, ctx) {
  const { readAudit, undoneMap } = await import("../audit/log.mjs");
  const { entries } = await readAudit(roots), audit = { entries, done: undoneMap(roots, entries) };
  const collectors = { preferences, sandbox, radar, promoted, lessons, consents, branches }, suggestions = [], failed = [], notCollected = [...NOT_COLLECTED];
  const skip = (kind, reason) => notCollected.push({ kind, reason });
  for (const [name, collect] of Object.entries(collectors)) {
    try { suggestions.push(...await collect(roots, ctx, audit, skip)); } catch (error) { failed.push({ collector: name, code: failure(error) }); }
  }
  suggestions.sort((a, b) => SUGGESTION_KINDS.indexOf(a.kind) - SUGGESTION_KINDS.indexOf(b.kind) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { suggestions, failed, notCollected };
}
