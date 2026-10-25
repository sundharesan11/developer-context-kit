import { DevtwinError } from "../errors.mjs";
import { loadBundledCatalog, listSources, getSource } from "./catalog.mjs";
import { checkSource, validatePriorLock } from "./github.mjs";

export const catalogCommand = {
  options: {},
  run: () => listSources(loadBundledCatalog())
};

export const checkCommand = {
  options: { source: { type: "string" }, "prior-lock-json": { type: "string" } },
  async run(values, context) {
    if (!values.source) throw new DevtwinError("USAGE", "--source is required");
    const source = getSource(loadBundledCatalog(), values.source);
    let priorLock;
    if (values["prior-lock-json"] !== undefined) {
      const inline = values["prior-lock-json"];
      if (Buffer.byteLength(inline, "utf8") > 1024) throw new DevtwinError("USAGE", "Prior lock JSON is too large");
      try { priorLock = JSON.parse(inline); }
      catch { throw new DevtwinError("USAGE", "Malformed prior lock JSON"); }
      priorLock = validatePriorLock(priorLock, source.id);
    }
    return checkSource(source, { priorLock, request: context.request });
  }
};
