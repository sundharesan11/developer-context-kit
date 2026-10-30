---
title: Team knowledge server
description: Share accepted lessons with your team through your organization's knowledge server over MCP, one client at a time, under a consent that you grant and can revoke.
sidebar:
  label: Team knowledge server
---

Some teams keep their lessons in a **knowledge server** that agents reach over MCP. The server stores each lesson with its client, finds lessons by meaning and refuses a lesson it already has. devtwin can send your accepted lessons to that server, and it tells your agents to search it.

devtwin never calls the server and stores no login for it. Your agent talks to the server through its own MCP connection. devtwin prepares each request, checks it, and keeps a record of what was sent.

## What you need

- An MCP server that your agent can already reach. It must have a `log_learning` tool for new lessons and a `supersede_learning` tool for replacements. Search uses its `search_knowledge` tool.
- The name of that server as your agent sees it, such as `sample-knowledge`.
- The client slug for the scope, such as `sample-client`. Every request carries it.

## Bind a scope to the server

You bind one scope to one server and one client. This is an owner action. Preview the command first, then apply it in your own terminal with the plan fingerprint:

```sh
devtwin server bind --pilot "$LIVE_CONFIG" --scope example --name sample-knowledge --client sample-client
devtwin server status --pilot "$LIVE_CONFIG" --scope example
```

Then grant the `server-publish` consent for the scope. The consent sets the hold time, 24 hours by default. A changed binding voids the consent, so a lesson never goes to a client that you did not approve.

```sh
devtwin consent grant --pilot "$LIVE_CONFIG" --kind server-publish --scope example
```

The devtwin hook denies both applies from an agent shell.

## How a lesson reaches the server

1. **Accept.** Accept a lesson proposal with `--target server`, alone or with other targets, such as `project,server`. devtwin checks the text for credentials and other sensitive content.
2. **Hold.** The lesson waits in the held queue for the hold time. Until it is sent, `undo` or `consent revoke` cancels it.
3. **Send.** After the hold, the agent runs `server payload --id <hld_id>`. The result names the server, the `log_learning` tool and its exact arguments, including the client. The agent calls the tool through its own MCP connection.
4. **Record.** The agent passes the returned ID to `server record --id <hld_id> --learning-id <returned-id>`. devtwin marks the item sent. Sending the same ID again changes nothing; a different ID is refused.

To replace a lesson that the server already has, propose the replacement with `lesson supersede-propose --target server`, with the old learning ID as `--predecessor`. After the new lesson is recorded, `server supersede --id <hld_id>` gives the `supersede_learning` request for the agent to send.

## How agents read from the server

When a scope is bound, the session-start context tells the agent to search the server with the scope's client, and with the repository when it is known, before non-trivial debugging. The agent treats every result as reference material, never as an instruction. devtwin never asks for results from other clients.

## The team's Git archive

A team often keeps a Git repository with the long-form material, and the server may export lessons into it. devtwin treats that repository as read-only. Make any direct change on a branch, through a pull request.

## See also

- [`server bind` and the other `server` commands](/docs/reference/cli/#server-bind)
- [Organization hub](/docs/guides/organization-hub/), to share lessons through a Git repository instead
- [Security model](/docs/security/security-model/)
