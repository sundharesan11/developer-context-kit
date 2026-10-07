import { digest } from "../storage/canonical.mjs";
import { DevctxError } from "../errors.mjs";
const FIELDS = ["scope", "project", "provider", "accountId", "actorRef", "workspaceId", "operation", "recipient", "payloadHash", "expiresAt"];
function valid(fields) {
  if (!fields || FIELDS.some((key) => typeof fields[key] !== "string" || !fields[key].trim())) return false;
  const expires = fields.expiresAt;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expires) && Number.isFinite(Date.parse(expires)) && new Date(expires).toISOString() === expires;
}
export function createApproval(fields) {
  if (!valid(fields)) throw new DevctxError("APPROVAL_INVALID", "Approval fields invalid");
  const value = Object.fromEntries(FIELDS.map((key) => [key, fields[key]]));
  return { ...value, approvalId: "approval_" + digest(value).slice(7, 31) };
}
export function verifyApproval(approval, request, now = new Date()) {
  if (!valid(approval) || !valid(request) || !Number.isFinite(now?.getTime?.()) || FIELDS.some((key) => approval[key] !== request[key]) || now.getTime() > Date.parse(approval.expiresAt) || approval.approvalId !== createApproval(approval).approvalId) throw new DevctxError("APPROVAL_INVALID", "Approval does not match request");
  return true;
}
