import { createHash } from "node:crypto";
import { DevctxError } from "../errors.mjs";
function normalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DevctxError("INVALID_INPUT", "Non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item) ?? null);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = normalize(value[key]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  throw new DevctxError("INVALID_INPUT", "Unsupported JSON value");
}
export const canonicalJson = (value) => JSON.stringify(normalize(value));
export const sha256 = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
export const digest = (value) => sha256(canonicalJson(value));
