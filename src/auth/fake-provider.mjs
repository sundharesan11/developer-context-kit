import { DevtwinError } from "../errors.mjs";
export function createFakeProvider(initial) {
  const calls = [];
  let identity = { accountId: initial.accountId, workspaceId: initial.workspaceId, actorRef: initial.actorRef, verified: initial.verified ?? true };
  return { calls, setIdentity(patch) { identity = { ...identity, ...patch }; }, async whoami() { calls.push(["whoami"]); return { ...identity }; }, async read(args) { calls.push(["read"]); return { ok: true, items: [] }; }, async draft(args) { calls.push(["draft"]); return { ok: true, draftId: "fake-draft" }; } };
}
export function fakeSecretResolver(map) {
  return (ref) => {
    if (!ref.startsWith("fake:")) throw new DevtwinError("GATE_REQUIRED", "Real providers are a future authorized milestone");
    return map[ref.slice(5)];
  };
}
