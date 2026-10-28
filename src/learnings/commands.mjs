// U30 (KTD39): `learning send --branch devtwin/learning-<id>` queues the push of a learning branch that was written
// before its repository had a repo-push consent. It is consented (src/policy/tiers.mjs): it runs only while the
// consent is valid, and the push still waits the consent's hold time in the held queue. It previews, then applies
// with --apply and the plan fingerprint.
import { DevtwinError } from "../errors.mjs";

export const learningSendCommand = { options: { branch: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const push = await import("./push.mjs");
  const input = { branch: values.branch };
  if (!values.apply) return push.planSend(ctx.roots, input);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return push.applySend(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
