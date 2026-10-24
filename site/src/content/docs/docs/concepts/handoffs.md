---
title: Handoffs
description: Leave a handoff note for your next session, or export selected records as a private Markdown packet for someone who doesn't use devctx.
---

A handoff carries work from one session to the next. `devctx` supports two kinds:

- A **handoff record** is a note for the next session, yours or an agent's, that shows up in the project brief.
- A **handoff export** is a Markdown file built from records you select, readable by someone who doesn't have `devctx`.

## Leave a note for the next session

Before you stop, record where you are as a `handoff` record. A useful handoff says what you last verified, what changed, what to do next and what is blocking you:

```sh
devctx record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind handoff --title "Handoff: search paging" \
  --body-file "$DEMO/inputs/handoff-search.md" \
  --source commit:1791ed0 \
  --request-id req_atlas_handoff_01 --apply
```

```markdown title="handoff-search.md"
Last verified: server-side filter returns correct results for 3 sample queries.
Changed: src/search/filter.ts, src/search/filter.test.ts
Next: add paging at 50 items; update the list component.
Blockers: none.
```

The next brief includes it like any other record. When the work moves on, supersede the old handoff with a new one, so the brief only ever shows the latest. See [Records](/docs/concepts/records/#records-are-immutable).

With the bundled skills installed, you can ask your agent to leave the handoff for you. It drafts a proposal and you publish it; see [Capture decisions](/docs/guides/capture-decisions/).

## Export a handoff packet

`handoff export` writes a self-contained Markdown file from the records you name. The recipient needs nothing installed to read it.

```sh
devctx handoff export --pilot "$PILOT" --scope example --cwd "$REPO" \
  --record rec_42cda2baa21c74516c2d593c \
  --record rec_9fdf36bf44a7336f4c65eab5 \
  --as-of 2026-10-25T00:00:00.000Z \
  --out "$DEMO/data/exports/handoffs/example/example.atlas/search.handoff.md"
```

```json
{"ok":true,"command":"handoff export","result":{"scope":"example","project":"example.atlas","asOf":"2026-10-25T00:00:00.000Z","records":[...],"packetHash":"sha256:834c1f0b...","fileHash":"sha256:3e1d05bb...","bytes":4658,"output":"exports/handoffs/example/example.atlas/search.handoff.md","publication":"not-approved"}}
```

### The options

| Option | Rule |
| --- | --- |
| `--record` | A record ID to include. Repeat it for each record, up to 12. There is no "export everything" option. |
| `--as-of` | Required. A UTC timestamp with milliseconds, such as `2026-10-25T00:00:00.000Z`. It is the date used to judge review dates, not a snapshot of the past. |
| `--out` | A new file directly inside `<dataRoot>/exports/handoffs/<scope>/<project>/`. The name is 1 to 64 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit, and ends in `.handoff.md`. An existing file is never overwritten; the export fails with `DEVCTX_CONFLICT`. |
| `--cwd` | The worktree to export from. It finds the project, and freshness is checked against this worktree. |

The whole packet, including its header and footer, must fit in 32,768 bytes. A larger packet fails with `DEVCTX_LIMIT` and nothing is written; nothing is truncated.

### What's in the packet

- A header with the scope, project, and the exporting worktree's commit, branch and dirty state.
- For each record: its ID, hashes, kind, status, title, freshness, creation date, sources and the full body.
- A list of selected unknowns and disputes.
- Counts of what was left out, such as unselected and superseded records.
- Checks the recipient should do before relying on it.
- A footer line with the SHA-256 of everything above it.

Some things never go into a packet: your preferences and personal profile, scope policies, the worktree paths and remotes, and anything from records you didn't select. Reviewer identities are withheld.

### What holds an export

`devctx` would rather refuse than rewrite your text. An export fails, and writes nothing, when a selected record:

| Problem | Error |
| --- | --- |
| Is missing, proposed, superseded, or belongs to another project | `DEVCTX_RECORD_NOT_EXPORTABLE` |
| Contains text that looks like a credential | `DEVCTX_SENSITIVE_CONTENT` |
| Contains a URL, an absolute or home path, a token starting with `/`, an email address or an account reference | `DEVCTX_HANDOFF_UNSAFE` |

To export such a record, supersede it with a version that leaves out the problem text, then select the new record. Nothing selects the successor automatically.

:::caution[An export is not approval to share]
`"publication": "not-approved"` means exactly that. The pattern checks catch obvious leaks; they can't judge confidential prose. Read the packet yourself and decide whether it's fit to share before you send it anywhere.
:::

### Verify a packet

The last line of the packet is `Packet SHA-256 (all preceding bytes): sha256:...`. To check it, remove that line and the blank line before it, then hash the rest:

```sh
node -e '
const fs = require("fs"), crypto = require("crypto");
const text = fs.readFileSync(process.argv[1], "utf8");
const m = text.match(/\nPacket SHA-256 \(all preceding bytes\): (sha256:[0-9a-f]{64})\n$/);
const rest = text.slice(0, text.length - m[0].length);
const actual = "sha256:" + crypto.createHash("sha256").update(rest, "utf8").digest("hex");
console.log(m[1] === actual ? "packet hash OK" : "packet hash MISMATCH");
' search.handoff.md
```

A packet whose footer is missing or doesn't match may be incomplete. Don't use or share it. A hash is a checksum, not a signature: it shows the file wasn't changed, not who made it.
