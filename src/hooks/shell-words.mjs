// U32 (KTD31): the simple commands a shell call runs, for action-matched lessons. Each command is its lower-case words
// after the wrappers and Git global options are removed, so `FOO=1 sudo /usr/bin/git -C app push` gives
// ["git", "push"]. This is guidance matching, not a security check: it is not a full shell parser, and the
// owner-action block keeps its own conservative word list (src/hooks/owner-block.mjs). Nothing here reads a file.
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const MAX_COMMAND_BYTES = 65536, MAX_COMMANDS = 64, MAX_WORDS = 256;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["env", "command", "sudo", "xargs", "time", "nohup", "timeout", "exec", "nice"]);
// Wrapper options that take the next word as their value, and words a wrapper takes after its options (the duration).
const WRAPPER_VALUES = { sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"], xargs: ["-n", "-I", "-L", "-P", "-s", "-d", "-E"], env: ["-u", "-C", "-S"],
  timeout: ["-s", "-k", "--signal", "--kill-after"], exec: ["-a"], nice: ["-n", "--adjustment"] };
const WRAPPER_ARGS = { timeout: 1 };
// Shell words that may start a command and are not the command: `then git push`, `! git push`, `{ git push; }`.
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "{", "!"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// Shell options that take the next word as their value (`bash -o pipefail -c ...`).
const SHELL_VALUES = new Set(["-o", "-O", "+o", "+O"]);
const SHELL_C = /^-[A-Za-z]*c[A-Za-z]*$/, MAX_SUBST = 8;
// Git and GitHub CLI global options before the subcommand. Those in VALUE_OPTIONS take the next word.
const GIT_TOOLS = new Set(["git", "gh"]);
const VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const FLAG_OPTIONS = new Set(["--no-pager", "-p", "-P", "--paginate", "--bare", "--no-replace-objects"]);

// Splits text into simple commands, each a list of words. ";", "&&", "||", "|", "&", "(", ")" and a line break end a
// command outside quotes; "&" in a redirection (2>&1, &>file) does not. Quotes are removed and a backslash keeps the
// next character, so "a; git push" stays one word. A $(...) substitution, bare or inside double quotes, gives its
// commands as more commands and adds nothing to the word it sits in; at most MAX_SUBST are open at once. Backtick
// substitution is not read: its text stays in the word.
export function splitCommands(text) {
  const commands = [], outer = [];
  let words = [], word = "", quoted = false, quote = null;
  const endWord = () => { if (word || quoted) { if (words.length < MAX_WORDS) words.push(word); } word = ""; quoted = false; };
  const endCommand = () => { endWord(); if (words.length && commands.length < MAX_COMMANDS) commands.push(words); words = []; };
  // Leaves a substitution: its last command ends and the command it sits in resumes where it was.
  const close = () => { endCommand(); ({ words, word, quoted, quote } = outer.pop()); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (ch === "$" && text[i + 1] === "(" && outer.length < MAX_SUBST) {
      outer.push({ words, word, quoted, quote, depth: 0 });
      words = []; word = ""; quoted = false; quote = null; i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && /["\\$`]/.test(text[i + 1] ?? "")) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; quoted = true; continue; }
    if (ch === "\\") { if (text[i + 1] === "\n") i++; else if (i + 1 < text.length) word += text[++i]; continue; }
    if (ch === ")" && outer.length) { if (outer.at(-1).depth-- === 0) close(); else endCommand(); continue; }
    if (ch === "(" && outer.length) outer.at(-1).depth++;
    if (ch === ";" || ch === "\n" || ch === "(" || ch === ")") { endCommand(); continue; }
    if (ch === "|") { if (text[i + 1] === "|") i++; endCommand(); continue; }
    if (ch === "&" && text[i + 1] === "&") { i++; endCommand(); continue; }
    // A redirection keeps its "&" in the word: 2>&1, <&3, &>file and &>>file.
    if (ch === "&" && (text[i + 1] === ">" || ((text[i - 1] === ">" || text[i - 1] === "<") && word))) { word += ch; continue; }
    if (ch === "&") { endCommand(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    word += ch;
  }
  while (outer.length) close();
  endCommand();
  return commands;
}
const base = (word) => word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word;
// One command's words with leading VAR=value words, wrappers and their options, the executable's folder and Git global
// options removed, and leading shell keywords (then, do, !, {) dropped. A shell run with -c (or a flag group holding c,
// such as -lc) gives the commands in its script, once; -o and -O values before the -c are skipped.
function normalize(words, depth) {
  let i = 0;
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i]) || KEYWORDS.has(words[i]))) i++;
    const name = base(words[i] ?? "");
    if (!WRAPPERS.has(name)) break;
    i++;
    while (i < words.length && (words[i].startsWith("-") || (name === "env" && ASSIGNMENT.test(words[i])))) i += WRAPPER_VALUES[name]?.includes(words[i]) ? 2 : 1;
    i += WRAPPER_ARGS[name] ?? 0;
  }
  if (i >= words.length) return [];
  const exe = base(words[i]).toLowerCase(), rest = words.slice(i + 1);
  if (SHELLS.has(exe)) {
    let flag = 0;
    while (flag < rest.length && !SHELL_C.test(rest[flag]) && /^[-+]./.test(rest[flag])) flag += SHELL_VALUES.has(rest[flag]) ? 2 : 1;
    if (depth === 0 && SHELL_C.test(rest[flag] ?? "") && typeof rest[flag + 1] === "string") return splitCommands(rest[flag + 1]).flatMap((inner) => normalize(inner, 1));
    return [[exe, ...rest.map((w) => w.toLowerCase())]];
  }
  let j = 0;
  if (GIT_TOOLS.has(exe)) {
    while (j < rest.length && rest[j].startsWith("-")) {
      const option = rest[j], eq = option.indexOf("=");
      if (VALUE_OPTIONS.has(option)) j += 2;
      else if (FLAG_OPTIONS.has(option) || (eq > 0 && VALUE_OPTIONS.has(option.slice(0, eq)))) j++;
      else break;
    }
  }
  return [[exe, ...rest.slice(j).map((w) => w.toLowerCase())]];
}
// The simple commands in a shell text, normalized. An empty or oversized text gives none.
export function commandWords(text) {
  if (typeof text !== "string" || !text || Buffer.byteLength(text) > MAX_COMMAND_BYTES) return [];
  return splitCommands(text).flatMap((words) => normalize(words, 0)).slice(0, MAX_COMMANDS);
}
// The commands a shell tool call runs. Claude Code sends Bash input.command as text; Codex sends text or an argv array,
// and an argv array is one command whose words keep their own boundaries. Other tools give none.
export function payloadCommands(payload) {
  if (!SHELL_TOOLS.has(payload?.tool_name)) return [];
  const command = payload.tool_input?.command;
  if (Array.isArray(command)) {
    const words = command.filter((part) => typeof part === "string").slice(0, MAX_WORDS);
    return words.length && Buffer.byteLength(words.join(" ")) <= MAX_COMMAND_BYTES ? normalize(words, 0).slice(0, MAX_COMMANDS) : [];
  }
  return commandWords(command);
}
// Whole words: the command starts with every word of the prefix, so "git pushd" never matches "git push".
export const startsWithWords = (words, prefix) => prefix.length <= words.length && prefix.every((word, i) => words[i] === word);
