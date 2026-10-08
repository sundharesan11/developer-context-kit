import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
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
