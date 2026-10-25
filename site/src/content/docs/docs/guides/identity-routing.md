---
title: Identity routing
description: The planned design for binding each scope to its own GitHub and Slack accounts, so the project decides which account an agent uses.
sidebar:
  label: Identity routing
  badge:
    text: Planned
    variant: caution
---

:::note[Coming soon]
Identity routing is designed but **not shipped**. None of the `account` or `connect` commands on this page exist in the CLI today; `devtwin help` does not list them. This page describes the intended design and workflow so you can see where devtwin is going. Names and details may change before release. Track progress on the [roadmap](/docs/project/roadmap/).
:::

## The problem

If you work for more than one organization, each has its own GitHub organization and Slack workspace. Today an agent uses whichever account a tool happens to be logged into. One wrong pick posts as the wrong person, or into the wrong company.

Identity routing lets the **project decide the account**. You bind each [scope](/docs/concepts/scopes-and-projects/) to its own GitHub and Slack accounts once. Inside a bound project, devtwin picks that scope's account, loads its credential from outside the store, checks the live identity on every call, and refuses any mismatch.

## What it will do

The first release covers reading and drafting. Sending comes in a second release behind a per-message approval.

**Reads**

- GitHub: a pull request with its comments, an issue with its comments, and the open pull requests of the project's repository.
- Slack: recent messages of a channel, and a thread's replies.

Read output is capped, printed once as inert text, and never written to the store.

**Drafts**

A draft is a private file bound to scope, project, provider, account, target and the hash of its body. Saving and removing drafts are previewed writes. Drafts are never posted in the first release.

**Sends (second release)**

Sending a saved draft will need a fresh preview, a single-use approval that expires, and a confirmation you type at your own terminal.

## How it is meant to work

### One account per provider per scope

A scope gets at most one GitHub account and one Slack account. A binding records:

| Field | GitHub | Slack |
| --- | --- | --- |
| Account ID | numeric user ID | user ID (`U…` or `W…`) |
| Workspace ID | numeric ID of the owning organization, or your own ID for personal repositories | team ID (`T…`) |
| Actor | `github:<login>` | `slack:<user ID>` |
| Secret reference | `keychain:<service>/<account>` | same |
| Allowed operations | `read`, `draft` | `read`, `draft` |

Numeric IDs survive renames, so the binding stores no display names. A binding never contains a credential.

### Credentials stay outside devtwin's files

At call time devtwin will look for the credential in exactly two places, in order:

1. An environment variable named for that one binding: `DEVTWIN_SECRET_<SCOPE>__<ID>` (scope, double underscore, binding ID, upper-cased, `-` as `_`).
2. The macOS keychain item named by the binding's secret reference.

It will never read `GH_TOKEN`, `GITHUB_TOKEN`, `SLACK_TOKEN`, the `gh` CLI or Git credential stores. A global token applies to every scope, which is exactly the cross-organization leak routing prevents. A credential never reaches a record, receipt, draft, plan, error, log or standard output.

The design recommends the keychain for agent sessions and the variable only for one-off commands you run yourself, because an environment variable is visible to everything the agent launches.

### Every call is checked

```text
connect read|draft --scope S --cwd W --provider P
  → resolve the project for S and W          (else PROJECT_UNBOUND)
  → take scope S's approved account for P    (else ACCOUNT_UNBOUND)
  → check the operation is allowed           (else GATE_REQUIRED)
  → load the credential                      (else CREDENTIAL_UNAVAILABLE)
  → ask the provider who this token is;
    account, workspace and actor must match  (else AUTH_MISMATCH)
  → check the target belongs to the workspace
    and the project                          (else TARGET_MISMATCH)
  → read, or preview/save the draft
```

- The scope is always explicit, as for every devtwin call. There is no `--account` flag to get wrong.
- The identity check runs with the same credential the operation uses, on every call. Results are never cached.
- A GitHub target must be one of the bound project's own remotes, owned by the bound organization. A Slack channel must belong to the bound workspace.

### You approve bindings at your own terminal

Adding or removing an account will be a previewed plan applied with its fingerprint **and** a short code you type at an interactive terminal. When standard input is not a terminal, as in an agent's shell, the apply refuses with `CONFIRMATION_REQUIRED` before writing anything. A fingerprint an agent can read is not your consent.

## Intended workflow

These commands are the planned shape. They do not run today.

1. **Create one token per organization** with each provider, preferring fine-grained GitHub tokens limited to one organization. Store each in the macOS keychain.
2. **Look up the identity** a token belongs to, without writing anything:

   ```sh
   # Planned, not available yet
   devtwin account discover --scope alpha --id alpha-github --provider github --secret keychain:devtwin/alpha-github
   ```

3. **Bind it**, in your own terminal, with preview, fingerprint and typed confirmation:

   ```sh
   # Planned, not available yet
   devtwin account add --scope alpha --provider github --id alpha-github \
     --account-id <id> --workspace <org id> --actor github:<login> \
     --secret keychain:devtwin/alpha-github --allow read,draft
   ```

4. **Check it**: `account whoami --scope alpha --id alpha-github` runs the identity gate for a bound account. `account list --scope alpha` shows bindings and approval state.
5. **Use it** from a bound project, usually through a bundled skill:

   ```sh
   # Planned, not available yet
   devtwin connect read --scope alpha --cwd "$REPO" --provider github --open-prs
   devtwin connect draft --scope alpha --cwd "$REPO" --provider slack --target <channel> --body-file <file>
   ```

A new bundled skill, `devtwin-connect`, will tell agents to use these routes for bound projects, never to run `account add` or `account remove` with `--apply`, and to stop on `AUTH_MISMATCH` or `TARGET_MISMATCH`.

### Public-read GitHub token for the stack watch

One optional, scope-free GitHub binding is planned only to raise rate limits for the [stack watch](/docs/guides/stack-watch/)'s public reads. It must be a token that can see no private repository (otherwise `TOKEN_TOO_BROAD`), it is never selected by a scope or a `connect` call, and if it is unavailable the watch falls back to unauthenticated requests.

## What it will not do

- Only GitHub and Slack in the first release. Other providers come later.
- No OAuth flow, app install or token creation. You create tokens yourself.
- No Slack Enterprise Grid, bot or rotating tokens, and no GitHub App installation tokens at first.
- No 1Password or Bitwarden resolution yet.
- No change to tools devtwin does not run. A GitHub or Slack MCP server, `gh` or Git the agent also has still uses whatever account it is logged into. A routed launcher (`devtwin exec … -- gh …`) is the planned follow-up.
- Routing protects against mistakes, not against a misbehaving agent with a shell: that agent can read the same keychain items and variables.

## What exists today

The current kit contains only the groundwork, as an internal library with no CLI route: secret-reference parsing (`keychain:`, `bitwarden:` and `fake:` forms, format only), account-shape validation, an identity gate tested against a fake provider, and an approval contract nothing consumes yet. Scope files are written with an empty `accounts` list that nothing reads. There are no live connectors and no send operation.
