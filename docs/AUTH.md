# Auth boundary

The auth code is a library contract with fake-provider tests. It is not a live integration. There is no CLI route for accounts, connectors or approvals. No live token retrieval, OAuth flow, connected account, send operation or outbound approval consumer exists. Live connectors are roadmap priority 5.

The code lives in `src/auth/`. Tests and the acceptance harness call it directly.

## Secret references

A secret reference names where a credential lives. It never holds the credential. `parseSecretRef` accepts exactly three forms and refuses anything else with `INVALID_INPUT`:

| Form | Meaning |
| --- | --- |
| `keychain:<service>/<account>` | A keychain-style reference (format only; nothing resolves it). The service is letters, digits, `.`, `_` or `-`; the account may also contain `@`. |
| `bitwarden:<uuid>` | A Bitwarden item ID in standard UUID form. |
| `fake:<name>` | A test-only secret. |

Parsing a keychain or Bitwarden reference does not read the keychain or Bitwarden. Nothing in the kit resolves those forms.

## Account configuration

`validateAccountConfig` checks one account object. The allowed keys are `id`, `provider`, `accountId`, `workspaceId`, `actorRef`, `secretRef` and `policy`. Any other key fails with `INVALID_INPUT`. So does any key, at any depth, named like a secret. Those names are `password`, `token`, `secret`, `api_key`, `private_key`, `access_key` or `credential` (case-insensitive, with `-` or `_`), and names ending in `_token`, `_secret` or `_password` (also with `-`) or in camelCase `Token`, `Secret` or `Password`, such as `refreshToken`.

- `id`, `provider`, `accountId`, `workspaceId`, `actorRef` and `secretRef` must be non-empty strings.
- `actorRef` must match the actor form `email:`, `github:`, `slack:`, `linear:` or `handle:` followed by up to 128 safe characters.
- `secretRef` must parse as one of the forms above.
- `policy` must be an object whose only keys are `read`, `draft` and `outbound`, each a boolean.

New scope configuration files are written with `accounts: []`. No command adds an account, and no code reads or validates that list.

## Connector gate

`createConnector({ account, provider, resolveSecret })` validates the account and returns exactly three functions: `verify`, `read` and `draft`. There is no send function.

Each `read` or `draft` call runs these checks in order:

1. If `policy.read` (or `policy.draft`) is not `true`, it fails with `GATE_REQUIRED`. The provider is not called.
2. It calls `provider.whoami()`. This happens on every call; a result is never cached.
3. It fails with `AUTH_UNVERIFIED` when `whoami` throws or returns nothing, when `verified` is not `true` or when `actorRef`, `accountId` or `workspaceId` is missing.
4. If `accountId`, `workspaceId` or `actorRef` is not exactly equal to the configured value, it fails with `AUTH_MISMATCH`.
5. Only then does it call the provider's `read` or `draft` with the caller's arguments.

`verify()` runs steps 2 to 4 alone and returns the verified identity.

Known gaps:

- `policy.outbound` is validated but nothing uses it.
- `resolveSecret` is accepted but never called. The connector does not fetch any credential.
- Error codes carry the `DEVCTX_` prefix when serialized, for example `DEVCTX_AUTH_MISMATCH`.

## Fake provider

`createFakeProvider(initial)` returns an identity from `accountId`, `workspaceId`, `actorRef` and `verified` (default `true`). `setIdentity(patch)` changes it, so tests can simulate a wrong actor or an unverified session. `read` returns an empty item list and `draft` returns a fixed draft ID. Every call is appended to `calls`, which lets tests prove the provider was or was not reached.

`fakeSecretResolver(map)` returns the mapped value for a `fake:<name>` reference. Any other reference fails with `GATE_REQUIRED`: real providers need a separately authorized milestone.

## Approval contract

An approval binds one outbound action to one exact request. The fields are `scope`, `project`, `provider`, `accountId`, `actorRef`, `workspaceId`, `operation`, `recipient`, `payloadHash` and `expiresAt`. Each must be a non-empty string. `expiresAt` must be a canonical UTC timestamp with milliseconds, such as `2026-10-14T12:00:00.000Z`.

- `createApproval(fields)` keeps only those ten fields and adds `approvalId`: `approval_` followed by the first 24 hex characters of the SHA-256 digest of their canonical JSON.
- `verifyApproval(approval, request, now)` passes only when both objects are valid, all ten fields are equal, `now` is not after `expiresAt` and `approvalId` matches the recomputed value.
- Any failure throws `APPROVAL_INVALID`.

Nothing consumes an approval. It is not stored, not marked used and not required by the connector. It is a pure contract for a later authorized milestone, not a working send permission.

See [Security model](SECURITY-MODEL.md) for the same-user trust boundary and [Roadmap](ROADMAP.md) for when live connectors are planned.
