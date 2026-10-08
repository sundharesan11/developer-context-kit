import { exportHandoff } from "./export.mjs";

export const handoffExportCommand = {
  options: {
    pilot: { type: "string" }, scope: { type: "string" }, cwd: { type: "string" },
    record: { type: "string", multiple: true }, "as-of": { type: "string" }, out: { type: "string" }
  },
  run(values, ctx) {
    return exportHandoff(ctx.roots, ctx.pilot, { scope: values.scope, cwd: values.cwd,
      recordIds: values.record, asOf: values["as-of"], out: values.out });
  }
};
