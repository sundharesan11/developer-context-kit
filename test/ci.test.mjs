import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowPath = join(import.meta.dirname, "../.github/workflows/ci.yml");

test("CI uses read-only pinned actions without privileged triggers or persistent credentials", async () => {
  const text = await readFile(workflowPath, "utf8");
  assert.match(text, /\n  push:\n  pull_request:\n  workflow_dispatch:/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.equal([...text.matchAll(/^\s*permissions:/gm)].length, 1, "no job-level permission override");
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /package-manager-cache: false/);
  assert.match(text, /timeout-minutes: 20/);
  assert.match(text, /cancel-in-progress: true/);
  const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  assert.equal(uses.length, 2);
  for (const action of uses) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
  assert.doesNotMatch(text, /pull_request_target|workflow_run|self-hosted|continue-on-error|secrets\.|upload-artifact|npm (?:publish|install|ci)|write-all/);
});

test("CI evaluates both Node versions without claiming Linux support and checks private acceptance results", async () => {
  const text = await readFile(workflowPath, "utf8");
  for (const value of ["macos-15", "ubuntu-24.04", "'22.13.0'", "'26.4.0'",
    "Linux evaluation (unsupported)", "Linux minimum evaluation (unsupported)",
    "npm test", "npm run check:package", "scripts/acceptance.mjs",
    "$RUNNER_TEMP/devctx-ci.XXXXXX", "pwd -P", "fresh-agent-smoke", "deferred",
    "git status --porcelain --untracked-files=all",
    "git diff --check 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD"]) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(text.indexOf("run: npm run check:package") < text.indexOf("run: npm test"));
  assert.match(text, /report\.checks\.length, 25/);
  assert.match(text, /status === 'passed'\)\.length, 24/);
});
