import test from "node:test";
import assert from "node:assert/strict";
import { commandWords, payloadCommands, splitCommands, startsWithWords } from "../src/hooks/shell-words.mjs";

const PUSH = ["git", "push"];
const runsPush = (text) => commandWords(text).some((words) => startsWithWords(words, PUSH));

test("shell words match git push through wrappers, variables, -C, sh -c and a path executable", () => {
  for (const text of ["git push origin main", "git -C app push", "FOO=1 env git push", "cd x && git push", 'bash -c "git push"', "/usr/bin/git push",
    "sudo -u root git --no-pager --git-dir=.git -c user.name=x push", "time -p nohup xargs -n1 git push", "command git push", "git status; git push", "git status | git push",
    "false || git push", "(git push)", "bash -lc 'cd x && git -C y push'", "git --git-dir .git push"]) assert.ok(runsPush(text), text);
  assert.deepEqual(commandWords("FOO=1 env BAR=2 /usr/local/bin/git -C app push origin main"), [["git", "push", "origin", "main"]]);
  assert.deepEqual(commandWords("cd x && git push"), [["cd", "x"], ["git", "push"]]);
});

test("shell words do not match git pushd, echoed text, quoted operators or another subcommand", () => {
  for (const text of ["git pushd", "echo git push", 'git commit -m "a; git push"', "git commit -m 'a && git push'", "git status", "gitpush", "git", "", "printf 'git push\\n'",
    'bash -c "bash -c \'git push\'"']) assert.equal(runsPush(text), false, text);
  assert.deepEqual(splitCommands('git commit -m "a; git push"'), [["git", "commit", "-m", "a; git push"]]);
  assert.deepEqual(commandWords("x".repeat(70000)), []);
});

test("shell words read Claude Code Bash text and Codex argv arrays and ignore other tools", () => {
  assert.deepEqual(payloadCommands({ tool_name: "Bash", tool_input: { command: "git -C app push" } }), [PUSH]);
  assert.deepEqual(payloadCommands({ tool_name: "exec_command", tool_input: { command: ["bash", "-lc", "git push origin main"] } }), [["git", "push", "origin", "main"]]);
  assert.deepEqual(payloadCommands({ tool_name: "shell", tool_input: { command: ["git", "commit", "-m", "a; git push"] } }), [["git", "commit", "-m", "a; git push"]]);
  assert.deepEqual(payloadCommands({ tool_name: "Edit", tool_input: { command: "git push" } }), []);
  assert.deepEqual(payloadCommands({ tool_name: "Bash", tool_input: { command: 42 } }), []);
  assert.equal(startsWithWords(["git", "push"], ["git", "push", "origin"]), false);
});

test("shell words split a background &, drop leading shell keywords and unwrap timeout, exec, nice and shell -o values", () => {
  for (const text of ["sleep 1 & git push", "git push &", "make & git push 2>&1", "if true; then git push; fi", "for x in a; do git push; done", "if false; then :; else git push; fi",
    "if false; then :; elif git push; then :; fi", "{ git push; }", "! git push", "while git push; do :; done", "bash -o pipefail -c 'git push'", "bash -O extglob -lc 'git push'",
    "timeout 30 git push", "timeout -s KILL -k 5 30s git push", "timeout --signal=TERM 30 git push", "exec git push", "exec -a name git push", "nice -n 10 git push", "nice -5 git push",
    "echo $(git push)", 'echo "pushed: $(git push origin main)"', "x=$(cd y && (git push))", "sudo timeout 5 nice git push"]) assert.ok(runsPush(text), text);
  // Redirections keep their "&": they neither split the command nor make a new one.
  assert.deepEqual(commandWords("git status 2>&1 | cat"), [["git", "status", "2>&1"], ["cat"]]);
  assert.deepEqual(commandWords("git status &>/dev/null; git log >&2"), [["git", "status", "&>/dev/null"], ["git", "log", ">&2"]]);
  assert.deepEqual(commandWords("make & git status"), [["make"], ["git", "status"]]);
  assert.deepEqual(commandWords("timeout -k 5 30 git status"), [["git", "status"]]);
  // A substitution gives its own command and adds nothing to the word it sits in.
  assert.deepEqual(splitCommands('git commit -m "$(cat msg) done"'), [["cat", "msg"], ["git", "commit", "-m", " done"]]);
  for (const text of ["echo 'a & git push'", 'echo "a & git push"', "echo '$(git push)'", 'echo "\\$(git push)"', "echo then git push", "timeout 30 git pushd"]) assert.equal(runsPush(text), false, text);
  // Deep nesting stays linear: at most eight substitutions are open at once, and the command list stays capped.
  assert.ok(runsPush("$(".repeat(12) + "git push" + ")".repeat(12)));
  assert.ok(commandWords("$(".repeat(20000) + "git push" + ")".repeat(20000)).length <= 64);
});
