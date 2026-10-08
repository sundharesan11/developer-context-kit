import { DevctxError } from "../errors.mjs";
import { randomBytes } from "node:crypto";
import { planInstall, applyInstall, installStatus } from "./install.mjs";
const options = { home: { type: "string" }, agent: { type: "string", multiple: true }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" }, "run-id": { type: "string" } };
const agents = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const command = (mode) => ({ options, async run(values, ctx) {
  const input = { targetHome: values.home, agents: agents(values.agent), mode };
  if (!values.apply) return planInstall(ctx.pilot, input);
  if (!values["plan-fingerprint"]) throw new DevctxError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyInstall(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], runId: values["run-id"] ?? "run_" + randomBytes(12).toString("hex") });
} });
export const agentsInstallCommand = command("install");
export const agentsUninstallCommand = command("uninstall");
export const agentsStatusCommand = { options: { home: { type: "string" } }, run: (values, ctx) => installStatus(ctx.roots, ctx.pilot, { targetHome: values.home }) };
