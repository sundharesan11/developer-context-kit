import { DevctxError } from "../errors.mjs";

// KTD16: a small bounded reader for RSS 2.0, Atom 1.0 and JSON Feed 1.1. No DTD, no external or custom entity,
// only the five predefined entities and numeric references. Only title, link, ID, date and summary are kept.
export const FEED_LIMITS = Object.freeze({ depth: 32, elements: 20000, entries: 200, nodeText: 262144, title: 300, summary: 1000, link: 2048, id: 512 });
const invalid = (reason) => { throw new DevctxError("FEED_INVALID", "Feed could not be parsed", { reason }); };
const limit = (reason) => { throw new DevctxError("FEED_LIMIT", "Feed exceeds a parser limit", { reason }); };
const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const HTML_ENTITIES = { ...XML_ENTITIES, nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™" };
const NAME = /^[A-Za-z_][\w.:-]*$/;
const codePoint = (n) => Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
function decodeEntities(text, table) {
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (whole, ref) => {
    if (ref[0] === "#") return codePoint(ref[1] === "x" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    return Object.hasOwn(table, ref) ? table[ref] : whole;
  });
}
// Control, format (including bidirectional) and line-separator characters are removed; whitespace collapses.
export function plainText(text, max) {
  const clean = String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean;
}
// HTML is reduced to text before matching and rendering: tags (with their attributes) go, then entities decode.
export function reduceHtml(text, max) {
  const stripped = String(text).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ").replace(/</g, " ");
  return plainText(decodeEntities(stripped, HTML_ENTITIES), max);
}
function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === "\"" || c === "'") quote = c;
    else if (c === ">") return i;
    else if (c === "<") invalid("tag");
  }
  return invalid("tag");
}
function attributes(rest) {
  const attrs = {};
  const body = rest.replace(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, name, a, b) => {
    if (Object.hasOwn(attrs, name)) invalid("attribute");
    attrs[name] = decodeEntities(a ?? b, XML_ENTITIES);
    return " ";
  });
  if (body.trim()) invalid("attribute");
  return attrs;
}
export function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid("doctype");
  const root = { name: "#document", attrs: {}, children: [], size: 0 };
  const stack = [root];
  let i = 0, elements = 0;
  const append = (value) => {
    const top = stack.at(-1);
    if (!value) return;
    if (top === root) { if (value.trim()) invalid("text"); return; }
    top.size += value.length;
    if (top.size > FEED_LIMITS.nodeText) limit("field");
    top.children.push(value);
  };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { append(decodeEntities(text.slice(i), XML_ENTITIES)); break; }
    if (lt > i) append(decodeEntities(text.slice(i, lt), XML_ENTITIES));
    const close = (marker, start) => { const end = text.indexOf(marker, start); if (end < 0) invalid("unterminated"); return end; };
    if (text.startsWith("<!--", lt)) { i = close("-->", lt + 4) + 3; continue; }
    if (text.startsWith("<![CDATA[", lt)) { const end = close("]]>", lt + 9); append(text.slice(lt + 9, end)); i = end + 3; continue; }
    if (text.startsWith("<?", lt)) { i = close("?>", lt + 2) + 2; continue; }
    if (text.startsWith("<!", lt)) invalid("declaration");
    const gt = tagEnd(text, lt + 1);
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (stack.length < 2 || stack.at(-1).name !== name) invalid("nesting");
      stack.pop();
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const inner = selfClosing ? tag.slice(0, -1) : tag;
    const name = inner.match(/^[^\s/>]+/)?.[0] ?? "";
    if (!NAME.test(name)) invalid("name");
    if (stack.length === 1 && root.children.length) invalid("root");
    if (++elements > FEED_LIMITS.elements) limit("elements");
    const node = { name, attrs: attributes(inner.slice(name.length)), children: [], size: 0 };
    stack.at(-1).children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length - 1 > FEED_LIMITS.depth) limit("depth");
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) invalid("document");
  return root.children[0];
}
const local = (name) => name.slice(name.lastIndexOf(":") + 1);
const elementsOf = (node, name) => node.children.filter((c) => typeof c === "object" && local(c.name) === name);
const first = (node, name) => elementsOf(node, name)[0] ?? null;
const textOf = (node) => !node ? "" : node.children.map((c) => typeof c === "string" ? c : textOf(c)).join("");
function isoDate(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 64) return null;
  const time = Date.parse(text.trim());
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function cleanLink(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > FEED_LIMITS.link || /[\s\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  try { const url = new URL(trimmed); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
const entryOf = ({ title, link, id, date, summary }) => ({
  title: reduceHtml(title ?? "", FEED_LIMITS.title), link: cleanLink(link), id: plainText(id ?? "", FEED_LIMITS.id) || null,
  date: isoDate(date), summary: reduceHtml(summary ?? "", FEED_LIMITS.summary)
});
function cap(list) { if (list.length > FEED_LIMITS.entries) limit("entries"); return list; }
function rssEntries(root) {
  const channel = first(root, "channel");
  if (!channel) invalid("rss channel");
  return cap(elementsOf(channel, "item")).map((item) => entryOf({
    title: textOf(first(item, "title")), link: textOf(first(item, "link")), id: textOf(first(item, "guid")),
    date: textOf(first(item, "pubDate")) || textOf(first(item, "date")), summary: textOf(first(item, "description"))
  }));
}
function atomLink(entry) {
  const links = elementsOf(entry, "link");
  const pick = links.find((l) => (l.attrs.rel ?? "alternate") === "alternate") ?? links[0];
  return pick?.attrs.href ?? null;
}
function atomEntries(root) {
  return cap(elementsOf(root, "entry")).map((entry) => entryOf({
    title: textOf(first(entry, "title")), link: atomLink(entry), id: textOf(first(entry, "id")),
    date: textOf(first(entry, "updated")) || textOf(first(entry, "published")),
    summary: textOf(first(entry, "summary")) || textOf(first(entry, "content"))
  }));
}
const str = (value) => typeof value === "string" ? value : "";
function jsonFeedEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !/^https:\/\/jsonfeed\.org\/version\/1(?:\.1)?$/.test(str(value.version)) || !Array.isArray(value.items)) invalid("json feed");
  return cap(value.items).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("json feed item");
    return entryOf({ title: str(item.title), link: str(item.url), id: typeof item.id === "number" ? String(item.id) : str(item.id),
      date: str(item.date_modified) || str(item.date_published), summary: str(item.summary) || str(item.content_text) || str(item.content_html) });
  });
}
export function decodeUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""); }
  catch { return invalid("encoding"); }
}
// Returns {format, entries: [{title, link, id, date, summary}]}; titles and summaries are plain, capped text.
export function parseFeed(bytes) {
  const text = typeof bytes === "string" ? bytes.replace(/^﻿/, "") : decodeUtf8(bytes);
  if (/^\s*[{[]/.test(text)) {
    let value;
    try { value = JSON.parse(text); } catch { invalid("json"); }
    return { format: "json-feed", entries: jsonFeedEntries(value) };
  }
  const root = parseXml(text);
  if (local(root.name) === "rss") {
    if (root.attrs.version !== "2.0") invalid("rss version");
    return { format: "rss", entries: rssEntries(root) };
  }
  if (local(root.name) === "feed") return { format: "atom", entries: atomEntries(root) };
  return invalid("format");
}
