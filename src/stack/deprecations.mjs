// U34 (R18; KTD37): model retirements. A `deprecations` radar source names a fixed vendor page. The page is fetched
// like any other radar source, under the approval and, in live mode, the stackWatch exception. A fixed extractor reads
// only table rows whose header names a model column and a retirement column, and keeps only a model ID and a date from
// each row. No other page text leaves this module, so an instruction on the page cannot reach the digest.
import { DevtwinError } from "../errors.mjs";
import { decodeUtf8, reduceHtml, withoutScripts } from "./feed.mjs";

export const PAGE_TYPES = Object.freeze(["text/html", "application/xhtml+xml"]);
export const RETIREMENT_WINDOW_DAYS = 180;
const DAY = 86400000;
const MAX_ROWS = 500;
const CELL = 300;
const MAX_CELLS = 20;
// A model ID: lowercase letters and digits in at least two parts joined by "-" or ".", with a digit and a hyphen.
const MODEL = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+){1,12}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const LONG_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/i;
const DATE_HEADER = /\b(?:retire|retired|retirement|retirements|shutdown|shut down|sunset)\b/i;
const MODEL_HEADER = /\b(?:model|models|system|systems)\b/i;
const NOT_MODEL_HEADER = /\b(?:replacement|replacements|recommended|alternative|alternatives|upgrade)\b/i;

function isoOf(year, month, day) {
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (year < 2000 || year > 2100 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}
// The first ISO or "Month D, YYYY" date in a cell, as YYYY-MM-DD; null when the cell has none.
export function cellDate(text) {
  const iso = ISO_DATE.exec(text);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const long = LONG_DATE.exec(text);
  return long ? isoOf(Number(long[3]), MONTHS.indexOf(long[1].toLowerCase()) + 1, Number(long[2])) : null;
}
// Every model-ID-shaped token in a cell. Words, sentences and links are not model IDs and are dropped.
export function cellModels(text) {
  return [...new Set(text.split(/[\s,;:()[\]{}"'`|/<>*]+/).map((t) => t.replace(/\.+$/, "")).filter((t) => t.length <= 64 && MODEL.test(t) && /\d/.test(t) && t.includes("-")))];
}
// A forward-only search for an opening tag (name followed by whitespace, "/" or ">") or a plain text. It remembers its
// last answer, and callers only ask at rising positions, so each search covers the text once and the cost stays linear.
function seeker(lower, needle, tag) {
  let last = -2;
  return (from) => {
    if (last === -1 || last >= from) return last;
    for (let p = lower.indexOf(needle, from); ; p = lower.indexOf(needle, p + 1)) if (p === -1 || !tag || /[\s/>]/.test(lower[p + needle.length] ?? "")) return (last = p);
  };
}
const nearest = (...positions) => { const found = positions.filter((p) => p !== -1); return found.length ? Math.min(...found) : -1; };
// Rows in document order: {table, cells: [{header, text}]}.
function tableRows(html) {
  const lower = html.toLowerCase();
  const [table, tr, td, th, trEnd, tableEnd] = [seeker(lower, "<table", true), seeker(lower, "<tr", true), seeker(lower, "<td", true), seeker(lower, "<th", true), seeker(lower, "</tr", false), seeker(lower, "</table", false)];
  const rows = [];
  let count = 0;
  for (let start = tr(0); start !== -1 && rows.length < MAX_ROWS * 2;) {
    while (table(0) !== -1 && table(0) < start) { count++; table(table(0) + 1); }
    const next = tr(start + 3);
    const close = nearest(trEnd(start), next, tableEnd(start), table(start));
    const end = close === -1 ? lower.length : close;
    const cells = [];
    for (let c = nearest(td(start), th(start)); c !== -1 && c < end && cells.length < MAX_CELLS;) {
      const gt = lower.indexOf(">", c);
      if (gt === -1 || gt >= end) break;
      const after = nearest(td(gt), th(gt));
      const stop = after === -1 || after > end ? end : after;
      cells.push({ header: lower.startsWith("<th", c), text: reduceHtml(html.slice(gt + 1, stop), CELL) });
      c = stop === end ? -1 : after;
    }
    rows.push({ table: count, cells });
    start = next;
  }
  return rows;
}
// The columns a header row names, or null. A header row names a retirement column and a model column and has no date.
function headerOf(cells) {
  if (cells.some((c) => cellDate(c.text))) return null;
  const date = cells.findIndex((c) => DATE_HEADER.test(c.text));
  const model = cells.findIndex((c) => MODEL_HEADER.test(c.text) && !NOT_MODEL_HEADER.test(c.text) && !DATE_HEADER.test(c.text));
  return date === -1 || model === -1 ? null : { date, model };
}
// Returns [{model, date}] sorted by date then model. Only rows under a matching header count; nothing else is kept.
export function extractRetirements(bytes) {
  const html = withoutScripts(typeof bytes === "string" ? bytes : decodeUtf8(bytes));
  const found = new Map();
  let table = -1, columns = null;
  for (const row of tableRows(html)) {
    if (row.table !== table) { table = row.table; columns = null; }
    const header = headerOf(row.cells);
    if (header) { columns = header; continue; }
    if (!columns) continue;
    const date = cellDate(row.cells[columns.date]?.text ?? "");
    if (!date) continue;
    for (const model of cellModels(row.cells[columns.model]?.text ?? "")) if (found.size < MAX_ROWS) found.set(model + " " + date, { model, date });
  }
  return [...found.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.model < b.model ? -1 : 1));
}
// Days from now to a retirement date; a date within the window (today included) is reported.
export const daysUntil = (date, now) => Math.ceil((Date.parse(date + "T00:00:00Z") - now.getTime()) / DAY);
export const upcoming = (rows, now) => rows.filter((r) => { const days = daysUntil(r.date, now); return days >= 0 && days <= RETIREMENT_WINDOW_DAYS; });
// KTD37: a page that had rows before and has none now is a source failure, not "no retirements".
export function assertRows(rows, previous) {
  if (!rows.length && Number.isInteger(previous) && previous > 0) throw new DevtwinError("UPSTREAM_INVALID", "Deprecation page has no rows", { reason: "rows-missing" });
  return rows;
}
// The radar state keeps the row count of each page from the last applied digest: {url: count}.
export function checkPageRows(value) {
  if (value === undefined) return {};
  const ok = value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 40 &&
    Object.entries(value).every(([url, n]) => /^https:\/\/[^\s]{1,2040}$/.test(url) && Number.isInteger(n) && n >= 0 && n <= MAX_ROWS);
  if (!ok) throw new DevtwinError("INTEGRITY", "Radar items invalid");
  return value;
}
