import {DevctxError} from "../errors.mjs";
import {reviewSourcePackage} from "./package.mjs";
import {approveSourceContent, planSourceInstall, approveSourceAction, applySourceInstall, sourceInstallStatus} from "./installation.mjs";

const string = {type: "string"};
const packageOptions = {pilot: string, run: string, "mapping-json": string};
const planOptions = {pilot: string, "content-decision": string, home: string, "agent-json": string, mode: string};
const approvalOptions = {decision: string, "interaction-ref": string, response: string};
const usage = () => { throw new DevctxError("USAGE", "Missing or malformed source installation option"); };
function required(values, keys) { for (const key of keys) if (typeof values[key] !== "string" || !values[key]) usage(); }
function json(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768) usage();
  try { return JSON.parse(value); } catch { usage(); }
}
function packageInput(values) { required(values, ["run", "mapping-json"]); return {stageRunId: values.run, mapping: json(values["mapping-json"])}; }
function planInput(values) {
  required(values, ["content-decision", "home", "agent-json", "mode"]);
  return {contentDecisionId: values["content-decision"], targetHome: values.home, agents: json(values["agent-json"]), mode: values.mode};
}
function approval(values, {interaction = true} = {}) {
  required(values, ["decision", ...(interaction ? ["interaction-ref", "response"] : [])]);
  return {decisionId: values.decision, interactionRef: values["interaction-ref"], responseText: values.response};
}
export const packageReviewCommand = {options: packageOptions, run: (v, c) => reviewSourcePackage(c.roots, packageInput(v))};
export const contentApproveCommand = {
  options: {...packageOptions, ...approvalOptions, "package-digest": string},
  run(v, c) { required(v, ["package-digest"]); return approveSourceContent(c.roots, {...packageInput(v), packageDigest: v["package-digest"]}, approval(v)); }
};
export const localPlanCommand = {options: planOptions, run: (v, c) => planSourceInstall(c.roots, planInput(v))};
export const localApproveCommand = {
  options: {...planOptions, ...approvalOptions, "plan-fingerprint": string},
  run(v, c) { required(v, ["plan-fingerprint"]); return approveSourceAction(c.roots, planInput(v), {...approval(v), fingerprint: v["plan-fingerprint"]}); }
};
export const localApplyCommand = {
  options: {...planOptions, decision: string, "plan-fingerprint": string, "run-id": string},
  run(v, c) { required(v, ["plan-fingerprint"]); return applySourceInstall(c.roots, planInput(v), {...approval(v, {interaction: false}), fingerprint: v["plan-fingerprint"], runId: v["run-id"]}); }
};
export const localStatusCommand = {options: planOptions, run: (v, c) => sourceInstallStatus(c.roots, planInput(v))};
