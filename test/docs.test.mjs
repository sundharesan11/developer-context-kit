import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
test("public alpha onboarding documents only implemented CLI routes", async () => {
  const { COMMANDS } = await import("../src/cli.mjs");
  for (const file of ["README.md", "docs/GETTING-STARTED.md", "docs/ONBOARDING.md", "docs/SKILL-SOURCES.md"]) {
    const text = await readFile(join(import.meta.dirname, "..", file), "utf8");
    let count = 0;
    for (const match of text.matchAll(/node bin\/devctx\.mjs[ \t]+([a-z-]+)(?:[ \t]+([a-z-]+))?/g)) {
      const first = match[1], second = match[2];
      assert.ok(COMMANDS[first] || COMMANDS[first + " " + second], file + ": " + match[0]);
      count++;
    }
    assert.ok(count > 0, file + " has executable CLI examples");
  }
});
test("public alpha license metadata matches the canonical Apache text", async () => {
  const root = join(import.meta.dirname, "..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.private, true, "keep accidental npm publication blocked");
  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs");
  assert.equal(pkg.scripts["check:package"], "node scripts/check-package.mjs");
  const { createHash } = await import("node:crypto");
  const license = await readFile(join(root, "LICENSE"));
  assert.equal(createHash("sha256").update(license).digest("hex"),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    "canonical ASF Apache-2.0 text, including its illustrative appendix");
  assert.match(await readFile(join(root, "NOTICE"), "utf8"), /Copyright 2026/);
});

test("public alpha guides exist and relative documentation links resolve", async () => {
  const root = join(import.meta.dirname, "..");
  for (const file of ["CONTRIBUTING.md", "docs/README.md", "docs/GETTING-STARTED.md", "docs/LIVE.md",
    "docs/ONBOARDING.md", "docs/ARCHITECTURE.md", "docs/SKILL-SOURCES.md", "docs/RELEASING.md"]) {
    assert.ok(existsSync(join(root, file)), file);
  }
  const { readdir } = await import("node:fs/promises");
  const { dirname, resolve, relative, isAbsolute } = await import("node:path");
  async function markdown(dir) {
    const files = [];
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) files.push(...await markdown(path));
      else if (item.name.endsWith(".md")) files.push(path);
    }
    return files;
  }
  const files = [join(root, "README.md"), join(root, "CONTRIBUTING.md"),
    join(root, "SECURITY.md"), ...await markdown(join(root, "docs"))];
  for (const file of files) {
    const prose = (await readFile(file, "utf8")).replace(/```[\s\S]*?```/g, "");
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(href)) continue;
      const path = resolve(dirname(file), decodeURIComponent(href.split("#")[0]));
      const rel = relative(root, path);
      assert.ok(!rel.startsWith("..") && !isAbsolute(rel), "link stays in repository: " + href);
      assert.ok(existsSync(path), relative(root, file) + ": " + href);
    }
  }
});

test("public alpha diagram is accessible static SVG with no remote resources", async () => {
  const svg = await readFile(join(import.meta.dirname, "../docs/assets/architecture.svg"), "utf8");
  assert.match(svg, /role="img"/);
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  assert.match(svg, /marker-end="url\(#arrow\)"/);
  assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|\bon[a-z]+\s*=|(?:href|src)=["']https?:/i);
});
test("handoff docs describe private selected export and unexecuted commands", async () => {
  const doc = join(import.meta.dirname, "../docs/HANDOFF.md");
  assert.ok(existsSync(doc), "handoff documentation exists");
  const text = await readFile(doc, "utf8");
  for (const phrase of ["explicitly selected", "documented, not executed", "32,768", "exporting worktree only", "recorder-stated", "private proposal files", "invalid footer", "reviewer and user-reference identities", "leading-slash", "bodyBytes", "not approved for publication"]) assert.ok(text.includes(phrase), phrase);
  assert.ok((await readFile(join(import.meta.dirname, "../README.md"), "utf8")).includes("docs/HANDOFF.md"));
});
test("docs state the candidate's limits in pinned phrases", async () => {
  const read = (f) => readFile(join(import.meta.dirname, "..", f), "utf8");
  const want = {
    "README.md": ["local package candidate", "NOT currently installed", "no automatic private-to-public synchronization", "not a sandbox"],
    "docs/SECURITY-MODEL.md": ["residual race", "same-user"],
    "docs/LIMITATIONS.md": ["Linux support is not claimed", "Windows is unsupported", "migration is not implemented", "no backup or sync", "lost laptop", "multi-record onboarding", "no backup of the live store", "client repository text"],
    "docs/LIVE.md": ["mkdir -m 700 ~/.devctx", "--setting-sources user", "--sandbox read-only", "rollback-check", "live set-kit", "agents recover", "legacy", "Cursor", "same-user tampering", "If the store is lost", "No backup"],
  };
  for (const [file, phrases] of Object.entries(want)) {
    const text = await read(file);
    for (const p of phrases) assert.ok(text.includes(p), `${file}: ${p}`);
  }
  // The fresh-session allowlist must name exact commands; prefix rules would let a session write to the repository.
  const live = await read("docs/LIVE.md");
  for (const broad of ["Bash(node:*)", "Bash(git -C:*)", "Bash(git:*)", "Bash(printenv:*)"]) assert.ok(!live.includes(broad), `docs/LIVE.md allows ${broad}`);
  assert.ok(!live.includes("rolls back an interrupted update"), "docs/LIVE.md claims update rollback");
});

const BUNDLED_SKILLS = ["devctx-onboard", "devctx-resume", "devctx-record"];
const readBundledSkill = (name) => readFile(join(import.meta.dirname, "..", "skills", name, "SKILL.md"), "utf8");
test("bundled skills invoke only implemented CLI routes through DEVCTX_KIT", async () => {
  const { COMMANDS } = await import("../src/cli.mjs");
  for (const name of BUNDLED_SKILLS) {
    const text = await readBundledSkill(name);
    assert.doesNotMatch(text, /node bin\/devctx\.mjs/, name + ": checkout-relative command");
    let count = 0;
    for (const match of text.matchAll(/devctx\.mjs"?[ \t]+([a-z-]+)(?:[ \t]+([a-z-]+))?/g)) {
      const first = match[1], second = match[2];
      assert.ok(COMMANDS[first] || COMMANDS[first + " " + second], name + ": " + match[0]);
      count++;
    }
    assert.ok(count > 0, name + " invokes the CLI");
    for (const match of text.matchAll(/node[^\n]*devctx\.mjs[^\n]*/g)) {
      assert.match(match[0], /node "\$DEVCTX_KIT\/bin\/devctx\.mjs" /, name + ": " + match[0]);
      assert.doesNotMatch(match[0], /record publish/, name + " never invokes record publish");
    }
  }
});
test("bundled skill frontmatter passes skill-builder rules with a one-line description", async () => {
  const { validatePackage, parseFrontmatter } = await import("../src/skill-builder/validate.mjs");
  for (const name of BUNDLED_SKILLS) {
    const text = await readBundledSkill(name);
    const result = validatePackage({ "SKILL.md": text }, name);
    assert.equal(result.valid, true, name);
    assert.equal(result.unchecked.length, 0, name);
    const { meta, body } = parseFrontmatter(text);
    assert.deepEqual(Object.keys(meta).sort(), ["description", "name"]);
    assert.match(meta.description, /^Use when /, name);
    assert.ok(meta.description.length <= 1024, name);
    assert.match(text, /^description:\s*(.+)$/m, name + " is discoverable");
    assert.match(body, /^# /m, name + " has a title");
  }
});
test("bundled skills state the DEVCTX_KIT validation and pilot-path rules", async () => {
  const phrases = ["DEVCTX_KIT", "absolute path", "real path", "bin/devctx.mjs", "package.json", "developer-context-kit",
    "inside the current repository", "confirm", "pilot path", "kit checkout", "repos", "--scope",
    "GATE_REQUIRED", "GIT_QUERY_FAILED", "PROJECT_UNBOUND", "record publish --apply", "untrusted", "Never send or share"];
  for (const name of BUNDLED_SKILLS) {
    const text = await readBundledSkill(name);
    for (const phrase of phrases) assert.ok(text.includes(phrase), name + ": " + phrase);
  }
  for (const name of BUNDLED_SKILLS) {
    const text = await readBundledSkill(name);
    for (const phrase of ["live config", "~/.devctx/live.json", "confirm the pilot path once per session", "kit commit", ".devctx-owned.json", 'rev-parse HEAD', "warn the user"]) assert.ok(text.includes(phrase), name + ": " + phrase);
  }
  assert.match(await readBundledSkill("devctx-record"), /attributed to "human"/);
  assert.match(await readBundledSkill("devctx-resume"), /freshness/);
});
