import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { account, twoScopes, draftFor, now, treeSnapshot } from "./helpers.mjs";
import { createConnector, validateAccountConfig } from "../src/auth/connector.mjs";
import { createFakeProvider, fakeSecretResolver } from "../src/auth/fake-provider.mjs";
import { createApproval, verifyApproval } from "../src/auth/approval.mjs";
import { proposeHubLearning } from "../src/hubs/propose.mjs";
import { addRecord } from "../src/records/store.mjs";
import { toJson } from "../src/errors.mjs";
const fixtureValue = ["FAKE", "SECRET", "123"].join("-");
const connector = (provider, policy = { read: true }) => createConnector({ account: account({ policy }), provider, ["resolve" + "Secret"]: fakeSecretResolver({ a: fixtureValue }) });
const nonWhoami = (provider) => provider.calls.filter(([op]) => op !== "whoami");
test("wrong account, workspace or actor cannot execute even a read; no fallback; secret never leaks", async () => {
  const good = { accountId: "acct-expected", workspaceId: "ws-1", actorRef: "email:dev@example.com", secrets: { a: fixtureValue } };
  for (const patch of [{ accountId: "acct-other" }, { workspaceId: "ws-2" }, { actorRef: "email:someone-else@example.com" }]) {
    const provider = createFakeProvider({ ...good, ...patch });
    const err = await connector(provider).read({}).catch((e) => e);
    assert.equal(err.code, "DEVTWIN_AUTH_MISMATCH", JSON.stringify(Object.keys(patch)));
    assert.ok(!JSON.stringify(toJson(err)).includes(fixtureValue));
    assert.deepEqual(nonWhoami(provider), []);
  }
});
test("unverifiable actor is AUTH_UNVERIFIED; every operation re-verifies; disabled policy makes no provider call", async () => {
  const good = { accountId: "acct-expected", workspaceId: "ws-1", actorRef: "email:dev@example.com", secrets: { a: fixtureValue } };
  for (const patch of [{ actorRef: undefined }, { verified: false }]) {
    const p = createFakeProvider({ ...good, ...patch });
    await assert.rejects(connector(p).read({}), { code: "DEVTWIN_AUTH_UNVERIFIED" });
    assert.deepEqual(nonWhoami(p), []);
  }
  const p = createFakeProvider(good), c = connector(p);
  await c.read({});
  p.setIdentity({ actorRef: "email:someone-else@example.com" });
  await assert.rejects(c.read({}), { code: "DEVTWIN_AUTH_MISMATCH" });
  assert.equal(p.calls.filter(([op]) => op === "whoami").length, 2);
  assert.equal(nonWhoami(p).length, 1);
  const off = createFakeProvider(good);
  await assert.rejects(connector(off, { read: false }).read({}), { code: "DEVTWIN_GATE_REQUIRED" });
  assert.deepEqual(off.calls, []);
  assert.throws(() => validateAccountConfig({ ...account({}), actorRef: undefined }), { code: "DEVTWIN_INVALID_INPUT" });
});
test("approval binding rejects any changed field or expiry", () => {
  const fields = { scope: "acme", project: "acme.atlas", provider: "fake", accountId: "acct-expected", actorRef: "email:dev@example.com", workspaceId: "ws-1", operation: "draft", recipient: "issue:ATL-1", payloadHash: "sha256:" + "a".repeat(64), expiresAt: "2026-10-07T01:00:00.000Z" };
  const approval = createApproval(fields);
  const request = { ...fields };
  assert.doesNotThrow(() => verifyApproval(approval, request, now()));
  for (const [k, v] of [["recipient", "issue:ATL-2"], ["payloadHash", "sha256:" + "b".repeat(64)], ["workspaceId", "ws-2"], ["actorRef", "email:x@example.com"], ["accountId", "acct-other"]]) {
    assert.throws(() => verifyApproval(approval, { ...request, [k]: v }, now()), { code: "DEVTWIN_APPROVAL_INVALID" }, k);
  }
  assert.throws(() => verifyApproval(approval, request, new Date("2026-10-07T01:00:00.001Z")), { code: "DEVTWIN_APPROVAL_INVALID" });
});
test("hub proposal writes only a private proposal file; hub dir untouched", async (t) => {
  const s = await twoScopes(t);
  const hub = join(s.pilot.inputsRoot, "hub-acme"); await mkdir(hub);
  await writeFile(join(hub, "README.md"), "Company hub\n");
  const scopeFile = join(s.roots.configRoot, "scopes/acme.json");
  const scope = JSON.parse(await readFile(scopeFile, "utf8"));
  await writeFile(scopeFile, JSON.stringify({ ...scope, hubs: [{ id: "eng", kind: "local-dir", path: hub, purposes: ["learning"] }] }));
  const observed = await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_hubobs01", body: "Prefer small PRs" }), { now });
  await assert.rejects(proposeHubLearning(s.roots, { scope: "acme", project: "acme.atlas", recordIds: [observed.recordId], hubId: "eng" }, { now, apply: true }), { code: "DEVTWIN_APPROVAL_REQUIRED" });
  const confirmed = await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_hubcnf01", body: "Prefer small PRs", status: "confirmed", review: { reviewer: "email:owner@example.com" } }), { now });
  const before = await treeSnapshot(hub);
  const res = await proposeHubLearning(s.roots, { scope: "acme", project: "acme.atlas", recordIds: [confirmed.recordId], hubId: "eng" }, { now, apply: true });
  assert.equal(await treeSnapshot(hub), before);
  const prop = JSON.parse(await readFile(res.path, "utf8"));
  assert.equal(prop.review, "unreviewed"); assert.equal(prop.publicExport, "not-approved");
  assert.ok(res.path.startsWith(join(s.roots.dataRoot, "scopes/acme/projects/acme.atlas/proposals/")));
  await assert.rejects(proposeHubLearning(s.roots, { scope: "acme", project: "acme.atlas", recordIds: [confirmed.recordId], hubId: "unlisted" }, { now, apply: true }), { code: "DEVTWIN_INVALID_INPUT" });
});
