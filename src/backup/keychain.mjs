// U24 (KTD33): the backup key in the macOS Keychain, as a generic password (service devtwin-backup, account the user
// name) holding 64 hex characters. The key is never in argv or a file: a write sends one add-generic-password line to
// the stdin of `/usr/bin/security -i`, and a read gets the key on stdout of find-generic-password -w. Any process that
// runs as this user can read the item; the backup protects copies kept off the machine, not data on it.
// ctx.keychain = { read(): Promise<Buffer|null>, write(key: Buffer): Promise<void> } is the seam; spawn is the seam of
// the default implementation.
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { DevtwinError } from "../errors.mjs";

export const SERVICE = "devtwin-backup";
export const KEY_BYTES = 32;
const SECURITY = "/usr/bin/security", NOT_FOUND = 44, HEX = /^[0-9a-f]{64}$/, ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;
const options = { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 4096 };
const failed = (step, status) => { throw new DevtwinError("STORAGE_ERROR", "Keychain " + step + " failed", { field: "keychain", status: status ?? null }); };
// The argv of each call. Neither holds the key.
export const readArgs = (account) => ["find-generic-password", "-s", SERVICE, "-a", account, "-w"];
export const WRITE_ARGS = Object.freeze(["-i"]);
// The one line a write sends on stdin.
export const writeLine = (account, key) => "add-generic-password -U -s " + SERVICE + " -a " + account + " -w " + key.toString("hex") + "\n";

export function securityKeychain({ spawn = spawnSync, platform = process.platform, account = userInfo().username } = {}) {
  const ready = () => {
    if (platform !== "darwin") throw new DevtwinError("GATE_REQUIRED", "The backup key needs the macOS Keychain", { field: "keychain", reason: "not-macos" });
    if (!ACCOUNT.test(account)) throw new DevtwinError("INVALID_INPUT", "User name cannot name a Keychain item", { field: "keychain" });
  };
  return {
    async read() {
      ready();
      const result = spawn(SECURITY, readArgs(account), options);
      if (result?.status === NOT_FOUND) return null;
      if (result?.error || result?.status !== 0) failed("read", result?.status);
      const hex = String(result.stdout ?? "").trim();
      if (!HEX.test(hex)) throw new DevtwinError("INTEGRITY", "Keychain backup key is not 32 bytes of hex", { field: "keychain" });
      return Buffer.from(hex, "hex");
    },
    async write(key) {
      ready();
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new DevtwinError("INVALID_INPUT", "Backup key must be 32 bytes", { field: "keychain" });
      const result = spawn(SECURITY, [...WRITE_ARGS], { ...options, input: writeLine(account, key) });
      if (result?.error || result?.status !== 0) failed("write", result?.status);
    }
  };
}
export const keychainOf = (ctx) => ctx?.keychain && typeof ctx.keychain.read === "function" && typeof ctx.keychain.write === "function" ? ctx.keychain : securityKeychain();
