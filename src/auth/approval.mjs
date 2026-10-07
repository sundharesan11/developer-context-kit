import { digest } from "../storage/canonical.mjs";
import { DevctxError } from "../errors.mjs";
const FIELDS = ["scope", "project", "provider", "accountId", "actorRef", "workspaceId", "operation", "recipient", "payloadHash", "expiresAt"];
export function createApproval(fields) {
  const value = Object.fromEntries(FIELDS.map((key) => [key, fields[key]]));
  return { ...value, approvalId: "approval_" + digest(value).slice(7, 31) };
}
export function verifyApproval(approval, request, now = new Date()) {
  if (FIELDS.some((key) => approval[key] !== request[key]) || now.getTime() > Date.parse(approval.expiresAt) || approval.approvalId !== createApproval(approval).approvalId) throw new DevctxError("APPROVAL_INVALID", "Approval does not match request");
  return true;
}
