export class DevctxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DevctxError";
    this.code = "DEVCTX_" + code.replace(/^DEVCTX_/, "");
    this.details = details;
  }
}
export function toJson(error) {
  if (error instanceof DevctxError) return { code: error.code, message: error.message, details: error.details };
  return { code: "DEVCTX_INTERNAL", message: String(error?.message ?? error).slice(0, 500), details: {} };
}
