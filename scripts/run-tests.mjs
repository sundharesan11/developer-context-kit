import { run } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const files = readdirSync(join(dir, "test"), { recursive: true }).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join(dir, "test", f));
const required = JSON.parse(readFileSync(join(dir, "test/required-tests.json"), "utf8"));
const problems = files.length ? [] : ["no test files discovered"];
// Empty or comment-only arrow bodies anywhere in a test file, and skip/todo/only in any form.
const PLACEHOLDER = /=>\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}/;
const BANNED = /\b(?:test|it|describe|suite)\.(?:skip|todo|only)\b|[{,]\s*(?:skip|todo|only)\s*:/;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (PLACEHOLDER.test(src)) problems.push(`placeholder or empty callback: ${f}`);
  if (BANNED.test(src)) problems.push(`skip/todo/only: ${f}`);
}
const passed = new Map(); let failed = 0;
for await (const ev of run({ files, concurrency: 1 })) {
  if (ev.type === "test:pass") {
    if (ev.data.skip || ev.data.todo) problems.push(`skipped or todo: ${ev.data.name}`);
    else passed.set(ev.data.name, (passed.get(ev.data.name) ?? 0) + 1);
  } else if (ev.type === "test:fail") { failed++; problems.push(`failed: ${ev.data.name}`); }
}
for (const name of required) if (!passed.has(name)) problems.push(`required test did not pass: ${name}`);
console.log(JSON.stringify({ ok: problems.length === 0, files: files.length, passed: [...passed.values()].reduce((x, y) => x + y, 0), failed, problems }));
process.exitCode = problems.length ? 1 : 0;
