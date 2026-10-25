import { DevtwinError } from "../errors.mjs";
import { randomBytes } from "node:crypto";
import { planInstall, applyInstall, installStatus, planRecovery, applyRecovery } from "./install.mjs";
import { rollbackCheck } from "./inventory.mjs";
const options = { home: { type: "string" }, agent: { type: "string", multiple: true }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" }, "run-id": { type: "string" } };
const agents = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const command = (mode) => ({ options, async run(values, ctx) {
  const input = { targetHome: values.home, agents: agents(values.agent), mode };
  if (!values.apply) return planInstall(ctx.pilot, input);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyInstall(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], runId: values["run-id"] ?? "run_" + randomBytes(12).toString("hex") });
} });
export const agentsInstallCommand = command("install");
export const agentsUninstallCommand = command("uninstall");
export const agentsStatusCommand = { options: { home: { type: "string" } }, run: (values, ctx) => installStatus(ctx.roots, ctx.pilot, { targetHome: values.home }) };
// Previews recovery of interrupted bundled installs; --apply with the previewed fingerprint is the approval.
// --release also closes runs whose entries are held or whose journal is unreadable, leaving their files in place.
export const agentsRecoverCommand = { options: { apply: { type: "boolean" }, release: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const release = values.release === true;
  if (!values.apply) return planRecovery(ctx.roots, ctx.pilot, { release });
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyRecovery(ctx.roots, ctx.pilot, { fingerprint: values["plan-fingerprint"], release });
} };
// Read-only: compares the skill folders now with an install run's pre-apply inventory.
export const agentsRollbackCheckCommand = { options: { "run-id": { type: "string" } }, run: (values, ctx) => rollbackCheck(ctx.roots, ctx.pilot, { runId: values["run-id"] }) };
