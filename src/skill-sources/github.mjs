import { DevctxError } from "../errors.mjs";
import { validateSourceRecipe } from "./catalog.mjs";

const SHA = /^[0-9a-f]{40}$/;
const BASE = "https://api.github.com/repos";
const BODY_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 1024 * 1024;
const CHECK_MS = 15000;
const NO_RELEASE = Symbol("no release");
const fail = (code, message, details = {}) => { throw new DevctxError(code, message, details); };
const validTag = (tag) => typeof tag === "string" && tag.length >= 1 && tag.length <= 128 &&
  !/[~^:?*\[\\\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u.test(tag) && !tag.includes("..") && !tag.includes("@{") &&
  tag.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
const tagPath = (tag) => tag.split("/").map(encodeURIComponent).join("/");
const validSha = (sha) => typeof sha === "string" && SHA.test(sha);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const previous = (lock) => lock ? { tag: lock.tag, commit: lock.commit } : undefined;

export function validatePriorLock(lock, sourceId) {
  if (!object(lock) || Object.keys(lock).length !== 4 ||
      ["sourceId", "channel", "tag", "commit"].some((key) => !Object.hasOwn(lock, key)) ||
      lock.sourceId !== sourceId || lock.channel !== "stable-release" || !validTag(lock.tag) || !validSha(lock.commit)) {
    fail("INVALID_INPUT", "Invalid prior lock");
  }
  return { sourceId: lock.sourceId, channel: lock.channel, tag: lock.tag, commit: lock.commit };
}

function retryDetails(headers) {
  const details = {};
  const after = headers.get("retry-after");
  if (after !== null && /^\d{1,5}$/.test(after) && Number(after) <= 86400) details.retryAfterSeconds = Number(after);
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^\d{1,12}$/.test(reset)) {
    const seconds = Number(reset);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 253402300799) details.resetAt = new Date(seconds * 1000).toISOString();
  }
  return details;
}

function httpFailure(status, headers, kind) {
  if (status >= 300 && status < 400) fail(kind === "repository" ? "SOURCE_MOVED" : "REDIRECT_REFUSED", "GitHub redirect refused", kind === "repository" ? { status } : {});
  if (status === 404) {
    if (kind === "release") return NO_RELEASE;
    fail(kind === "repository" ? "SOURCE_NOT_FOUND" : "UPSTREAM_INVALID", "GitHub resource missing");
  }
  if (status === 401) fail("GITHUB_UNAUTHORIZED", "GitHub denied the request");
  const details = retryDetails(headers);
  if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || Object.hasOwn(details, "retryAfterSeconds")))) {
    fail("RATE_LIMITED", "GitHub rate limit reached", details);
  }
  if (status === 403) fail("GITHUB_FORBIDDEN", "GitHub forbade the request");
  if (status >= 500) fail("UPSTREAM_UNAVAILABLE", "GitHub is unavailable");
  fail("UPSTREAM_HTTP", "GitHub returned an HTTP error", { status });
}

export async function checkSource(source, { request = fetch, priorLock, timeoutMs = 5000 } = {}) {
  source = validateSourceRecipe(source);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) fail("INVALID_INPUT", "Invalid timeout");
  const lock = priorLock === undefined ? undefined : validatePriorLock(priorLock, source.id);
  const stem = `${BASE}/${encodeURIComponent(source.repository.owner)}/${encodeURIComponent(source.repository.name)}`;
  const started = Date.now();
  let calls = 0;
  let transferred = 0;

  async function getJson(path, kind) {
    // Maximum chain: repository + release + ref + four tag objects + commit = eight requests.
    if (++calls > 8 || Date.now() - started >= CHECK_MS) fail("NETWORK_TIMEOUT", "GitHub check deadline exceeded");
    const controller = new AbortController();
    const remaining = Math.min(timeoutMs, CHECK_MS - (Date.now() - started));
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    let reader;
    try {
      try {
        response = await request(`${stem}${path}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "devctx-skill-sources" },
          signal: controller.signal, redirect: "manual"
        });
      } catch {
        fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "NETWORK_UNAVAILABLE", "GitHub request failed");
      }
      if (!response || typeof response.status !== "number" || !response.headers || typeof response.headers.get !== "function") fail("UPSTREAM_INVALID", "Invalid GitHub response");
      if (response.status < 200 || response.status >= 300) {
        const outcome = httpFailure(response.status, response.headers, kind);
        if (outcome === NO_RELEASE) return outcome;
      }
      const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (type !== "application/json") fail("UPSTREAM_INVALID", "Invalid GitHub JSON media type");
      const declared = response.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > BODY_LIMIT) fail("UPSTREAM_INVALID", "GitHub response too large");
      if (!response.body || typeof response.body.getReader !== "function") fail("UPSTREAM_INVALID", "Missing GitHub response body");
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        let item;
        try { item = await reader.read(); }
        catch { fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "UPSTREAM_INVALID", "GitHub body read failed"); }
        if (item.done) break;
        size += item.value.byteLength;
        transferred += item.value.byteLength;
        if (size > BODY_LIMIT || transferred > TOTAL_LIMIT) fail("UPSTREAM_INVALID", "GitHub response too large");
        chunks.push(item.value);
      }
      const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
      if (encoding === "identity" && declared !== null && /^\d+$/.test(declared) && size !== Number(declared)) fail("UPSTREAM_INVALID", "Truncated GitHub response");
      const bytes = Buffer.concat(chunks, size);
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { fail("UPSTREAM_INVALID", "Invalid GitHub JSON"); }
    } finally {
      clearTimeout(timer);
      if (reader) { try { await reader.cancel(); } catch { /* stream already closed */ } }
      else if (response?.body) { try { await response.body.cancel(); } catch { /* response already closed */ } }
    }
  }

  const repository = await getJson("", "repository");
  if (!object(repository) || typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== `${source.repository.owner}/${source.repository.name}`.toLowerCase()) fail("UPSTREAM_INVALID", "Unexpected GitHub repository");
  const release = await getJson("/releases/latest", "release");
  if (release === NO_RELEASE) return { sourceId: source.id, status: "no_release", channel: "stable-release", ...(lock ? { previous: previous(lock) } : {}) };
  if (!object(release) || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean" || typeof release.tag_name !== "string") fail("UPSTREAM_INVALID", "Invalid GitHub release");
  if (release.draft || release.prerelease) fail("NO_STABLE_RELEASE", "GitHub latest release is not stable");
  const tag = release.tag_name;
  if (!validTag(tag)) fail("UPSTREAM_INVALID", "Invalid GitHub release tag");
  const ref = await getJson(`/git/ref/tags/${tagPath(tag)}`, "ref");
  if (!object(ref) || ref.ref !== `refs/tags/${tag}` || !object(ref.object) ||
      !["commit", "tag"].includes(ref.object.type) || !validSha(ref.object.sha)) fail("UPSTREAM_INVALID", "Invalid GitHub tag ref");
  let target = ref.object;
  const visited = new Set();
  for (let depth = 0; target.type === "tag"; depth++) {
    if (depth >= 4 || visited.has(target.sha)) fail("UPSTREAM_INVALID", "Invalid GitHub tag chain");
    visited.add(target.sha);
    const annotated = await getJson(`/git/tags/${target.sha}`, "tag");
    if (!object(annotated) || annotated.sha !== target.sha || (depth === 0 && annotated.tag !== tag) || !object(annotated.object) ||
        !["commit", "tag"].includes(annotated.object.type) || !validSha(annotated.object.sha)) fail("UPSTREAM_INVALID", "Invalid GitHub tag object");
    target = annotated.object;
  }
  const commit = await getJson(`/git/commits/${target.sha}`, "commit");
  if (!object(commit) || commit.sha !== target.sha) fail("UPSTREAM_INVALID", "Invalid GitHub commit");
  const status = !lock ? "untracked" : lock.tag !== tag ? "release_changed" : lock.commit !== target.sha ? "moved_tag" : "stable";
  return { sourceId: source.id, status, channel: "stable-release", tag, commit: target.sha, ...(lock ? { previous: previous(lock) } : {}) };
}
