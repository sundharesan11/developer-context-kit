// U24 (KTD33, R13): backup create | restore | status | key export.
//   create      automatic: agents and the backup-daily job may run it. Preview, then --apply with the plan fingerprint.
//   restore     always ask: it writes decrypted files into a new folder inside an approved backupTargets folder, which a
//               cloud drive may sync, so the hook denies --apply from agent shells and the apply shows the owner dialog.
//               It never writes the live store and refuses an existing, outside or unapproved folder before it writes.
//   status      read-only: the archives in each approved folder and whether the key was exported.
//   key export  always ask: the hook denies --apply from agent shells (src/hooks/owner-block.mjs) and the apply shows the
//               owner dialog. It prints the key once and writes a receipt that holds the time only.
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { atomicReplace, ensurePrivatePath, info } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { keychainOf, SERVICE } from "./keychain.mjs";
import { applyBackupCreate, applyBackupRestore, archiveTime, backupKey, exportReceiptPath, listArchives, planBackupCreate, planBackupRestore } from "./archive.mjs";

const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const applyOptions = { apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
export const KEY_NOTE = "Run backup key export in your own terminal, outside any agent session. Store the key in a password manager. Anyone with the key and an archive can read your store.";
export const NOT_EXPORTED = "Backups cannot be restored on another machine until you run backup key export.";
export const NO_TARGET = "No backup folder is approved, so devtwin makes no backup. Approve one with live write-classes --backup-target <folder>.";

export const backupCreateCommand = { options: { to: { type: "string" }, ...applyOptions }, async run(values, ctx) {
  if (!values.apply) return { preview: true, ...planBackupCreate(ctx.roots, { to: values.to }) };
  needPlan(values);
  return applyBackupCreate(ctx.roots, { to: values.to, fingerprint: values["plan-fingerprint"] }, { now: ctx.now, keychain: keychainOf(ctx) });
} };
export const backupRestoreCommand = { options: { from: { type: "string" }, to: { type: "string" }, ...applyOptions }, async run(values, ctx) {
  const input = { from: values.from, to: values.to }, keychain = keychainOf(ctx);
  if (!values.apply) return { preview: true, ...(await planBackupRestore(ctx.roots, input, { keychain })) };
  needPlan(values);
  // The fingerprint and folder checks run in the preview; the dialog comes before the decrypted files are written.
  await planBackupRestore(ctx.roots, input, { keychain });
  await requireOwnerApproval(ctx, restoreDialog(input));
  return applyBackupRestore(ctx.roots, { ...input, fingerprint: values["plan-fingerprint"] }, { keychain });
} };

const exported = (roots) => info(exportReceiptPath(roots))?.isFile() === true;
export async function backupStatus(roots) {
  const folders = (roots.pilot?.writeClasses?.backupTargets ?? []).map((folder) => {
    const names = listArchives(folder);
    return { folder, archives: names.length, newest: names.at(-1) ?? null, newestAt: names.length ? archiveTime(names.at(-1)) : null };
  });
  return { folders, keyExported: exported(roots), receipt: exportReceiptPath(roots) };
}
export const backupStatusCommand = { options: {}, run: (values, ctx) => backupStatus(ctx.roots) };
// The activity digest's warnings (src/audit/digest.mjs).
export async function backupWarnings(roots) {
  const warnings = [];
  if (!(roots.pilot?.writeClasses?.backupTargets ?? []).length) warnings.push({ code: "BACKUP_NO_TARGET", message: NO_TARGET });
  if (!exported(roots)) warnings.push({ code: "BACKUP_KEY_NOT_EXPORTED", message: NOT_EXPORTED });
  return warnings;
}

export function planKeyExport(roots) {
  return finalizePlan({ kind: "backup-key-export", service: SERVICE, receipt: exportReceiptPath(roots), exportedBefore: exported(roots), warning: KEY_NOTE });
}
const restoreDialog = ({ from, to }) => ({ title: "Restore a backup", body: [
  "Archive: " + from, "Into a new folder: " + to,
  "", "devtwin writes the decrypted store into that folder. Your live store does not change.",
  "If a cloud drive syncs the backup folder, the decrypted files leave this machine. Delete the folder when you are done."
].join("\n") });
const exportDialog = { title: "Show the backup key", body: [
  "devtwin prints the backup key once, as 64 hex characters. With the key, anyone who has one of your backup archives can read your whole store.",
  "", "Continue only in your own terminal, outside any agent session. Store the key in a password manager, then clear the terminal."
].join("\n") };
export async function applyKeyExport(roots, { fingerprint }, ctx) {
  const plan = planKeyExport(roots);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, exportDialog);
  const { key } = await backupKey(keychainOf(ctx), { create: false });
  const path = exportReceiptPath(roots);
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["backup"]);
  await atomicReplace(path, canonicalJson({ schemaVersion: 1, exportedAt: (ctx.now ?? (() => new Date()))().toISOString() }) + "\n");
  return { exported: true, key: key.toString("hex"), note: KEY_NOTE, receipt: path, restoreElsewhere: "On the other machine, run security add-generic-password -s " + SERVICE + " -a <user name> -w, and paste the key when it asks for the password." };
}
export const backupKeyExportCommand = { options: applyOptions, async run(values, ctx) {
  if (!values.apply) return { preview: true, ...planKeyExport(ctx.roots) };
  needPlan(values);
  return applyKeyExport(ctx.roots, { fingerprint: values["plan-fingerprint"] }, ctx);
} };
