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
  for (const file of ["CONTRIBUTING.md", "docs/README.md", "docs/GETTING-STARTED.md",
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
    "docs/LIMITATIONS.md": ["Linux support is not claimed", "Windows is unsupported", "migration is not implemented", "no backup or sync", "lost laptop", "multi-record onboarding"],
  };
  for (const [file, phrases] of Object.entries(want)) {
    const text = await read(file);
    for (const p of phrases) assert.ok(text.includes(p), `${file}: ${p}`);
  }
});
