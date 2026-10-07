import { DevctxError } from "../errors.mjs";
export function renderProfile(templateText, values) {
  const keys = new Set(Object.keys(values));
  const matches = [...templateText.matchAll(/\{\{([^{}]+)\}\}/g)];
  for (const match of matches) {
    if (!keys.has(match[1]) || values[match[1]] === undefined) throw new DevctxError("INVALID_INPUT", "Profile value missing");
    keys.delete(match[1]);
  }
  if (keys.size) throw new DevctxError("INVALID_INPUT", "Unknown profile value");
  return templateText.replace(/\{\{([^{}]+)\}\}/g, (_, key) => String(values[key]));
}
