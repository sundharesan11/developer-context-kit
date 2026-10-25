import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
function normalize(value, seen = new Set()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DevtwinError("INVALID_INPUT", "Non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new DevtwinError("INVALID_INPUT", "Cyclic JSON value");
    seen.add(value);
    const result = value.map((item) => normalize(item, seen) ?? null);
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new DevtwinError("INVALID_INPUT", "Non-JSON object");
    if (seen.has(value)) throw new DevtwinError("INVALID_INPUT", "Cyclic JSON value");
    seen.add(value);
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = normalize(value[key], seen);
      if (item !== undefined) result[key] = item;
    }
    seen.delete(value);
    return result;
  }
  throw new DevtwinError("INVALID_INPUT", "Unsupported JSON value");
}
export const canonicalJson = (value) => JSON.stringify(normalize(value));
export const sha256 = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
export const digest = (value) => sha256(canonicalJson(value));
