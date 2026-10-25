export class DevtwinError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DevtwinError";
    this.code = "DEVTWIN_" + code.replace(/^DEVTWIN_/, "");
    this.details = details;
  }
}
export function toJson(error) {
  if (error instanceof DevtwinError) return { code: error.code, message: error.message, details: error.details };
  return { code: "DEVTWIN_INTERNAL", message: String(error?.message ?? error).slice(0, 500), details: {} };
}
