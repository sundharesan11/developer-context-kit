import { DevctxError } from "../errors.mjs";
import { getSource, loadBundledCatalog } from "./catalog.mjs";
import { previewAcquisition } from "./github-package.mjs";
import { stageAcquisition, inspectAcquisition } from "./staging.mjs";

const selectionOptions = {source: {type: "string"}, "pin-json": {type: "string"}, "files-json": {type: "string"}};
const usage = () => { throw new DevctxError("USAGE", "Missing or malformed acquisition option"); };
function json(value, limit) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) usage();
  try { return JSON.parse(value); } catch { usage(); }
}
function selection(values) {
  if (!values.source) usage();
  const source = getSource(loadBundledCatalog(), values.source);
  return {source, input: {pin: json(values["pin-json"], 1024), files: json(values["files-json"], 8192)}};
}
export const previewCommand = {
  options: selectionOptions,
  async run(values, context) {
    const {source, input} = selection(values);
    return previewAcquisition(source, input, {request: context.request});
  }
};
export const stageCommand = {
  options: {...selectionOptions, pilot: {type: "string"}, "preview-hash": {type: "string"}},
  async run(values, context) {
    const {source, input} = selection(values);
    if (!values["preview-hash"]) usage();
    return stageAcquisition(context.roots, source, {...input, fingerprint: values["preview-hash"]}, {request: context.request, now: context.now});
  }
};
export const inspectCommand = {
  options: {pilot: {type: "string"}, run: {type: "string"}},
  async run(values, context) {
    if (!values.run) usage();
    return inspectAcquisition(context.roots, values.run);
  }
};
