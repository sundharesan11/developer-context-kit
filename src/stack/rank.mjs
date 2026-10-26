// U19 (R28, R29, R31; KTD16): radar ranking and urgent advisory alerts. Ranking is local and deterministic: a match
// with the developer's stack or a project in this scope outweighs any interest match, and an item below the
// threshold is counted in the digest, not listed. Alerts cover urgent advisories only: at most one alert for one
// advisory, and at most three alerts a day.
import { hasTerm } from "./match.mjs";
import { INTEREST } from "../profile/validate.mjs";

export const RANK = Object.freeze({ project: 100, stack: 60, strong: 30, normal: 15, weak: 5, threshold: 15, listed: 30 });
export const ALERTS_PER_DAY = 3;
const URGENT = ["critical", "high"];
const KIND_ORDER = ["agent-tools", "approaches", "adjacent"];

// "term", "term:weak" or "term:strong" from the profile's radar interests.
export function parseInterests(list = []) {
  return list.map((text) => INTEREST.exec(text)).filter(Boolean).map((m) => ({ term: m[1].trim(), weight: m[2] ?? "normal" }));
}
// Scores one classified radar entry. The level comes from classifyEntry: project and stack matches use stack terms.
export function scoreEntry(entry, interests) {
  const text = entry.title + "\n" + entry.summary;
  const hits = interests.filter((i) => hasTerm(text, i.term));
  const interest = hits.reduce((sum, i) => sum + RANK[i.weight], 0);
  const base = entry.level === "project" ? RANK.project : entry.level === "stack" ? RANK.stack : 0;
  return { score: base + interest, interests: hits.map((i) => i.term).sort() };
}
// Ranks the fresh radar entries: highest score first, then newest, then by hash. Returns the listed entries (at most
// RANK.listed) and the number left out, both below the threshold and over the list cap.
export function rankRadar(entries, interests) {
  const scored = entries.map((entry) => ({ ...entry, ...scoreEntry(entry, interests) }));
  const kept = scored.filter((e) => e.score >= RANK.threshold)
    .sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? "") || (a.hash < b.hash ? -1 : 1));
  const listed = kept.slice(0, RANK.listed);
  return { listed, belowThreshold: scored.length - kept.length, overCap: kept.length - listed.length };
}
export const kindOrder = (kind) => KIND_ORDER.indexOf(kind);

// state: {alerted: [key], days: {"YYYY-MM-DD": count}}. A finding's key is its advisory ID, so a severity change or a
// second affected package does not alert twice. Returns the alerts to show now and the next state.
export const alertKey = (finding) => finding.id;
export function selectAlerts(findings, state, now) {
  const day = now.toISOString().slice(0, 10);
  const alerted = new Set(state?.alerted ?? []);
  let count = state?.days?.[day] ?? 0;
  const alerts = [];
  const urgent = findings.filter((f) => f.group === "advisories" && URGENT.includes(f.severity))
    .sort((a, b) => URGENT.indexOf(a.severity) - URGENT.indexOf(b.severity) || (alertKey(a) < alertKey(b) ? -1 : 1));
  for (const finding of urgent) {
    const key = alertKey(finding);
    if (alerted.has(key) || count >= ALERTS_PER_DAY) continue;
    alerted.add(key);
    count++;
    alerts.push(finding);
  }
  // Only the last week of day counts is kept; the alerted keys keep the newest 1,000.
  const days = Object.fromEntries(Object.entries({ ...(state?.days ?? {}), [day]: count }).filter(([d]) => Date.parse(d) > now.getTime() - 7 * 86400000));
  return { alerts, state: { alerted: [...alerted].slice(-1000), days } };
}
