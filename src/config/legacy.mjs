// Compatibility with installs made while the product was called devctx. Every legacy name lives here, so the
// transition can be removed in one place once existing setups have run `live migrate`. See docs/MIGRATING.md.
export const LEGACY_SKILL_PREFIX = "devctx-";
export const LEGACY_RECEIPT = ".devctx-owned.json";
export const LEGACY_SKILL_NAMES = ["devctx-onboard", "devctx-resume", "devctx-record"];
export const LEGACY_KIT_ENV = "DEVCTX_KIT";
export const LEGACY_ROOT_NAME = ".devctx";
export const LEGACY_DEFAULT_ROOTS = [".config/devctx", ".local/share/devctx", ".local/state/devctx"];
export const KIT_ENV = "DEVTWIN_KIT";
export const isLegacySkill = (name) => LEGACY_SKILL_NAMES.includes(name);
// The devtwin skill that replaces a legacy one, such as devtwin-resume for devctx-resume.
export const successorOf = (name) => "devtwin-" + name.slice(LEGACY_SKILL_PREFIX.length);
// DEVTWIN_KIT wins. DEVCTX_KIT is read for one transition only and is reported as deprecated.
export function kitEnv(env = process.env) {
  const value = (name) => typeof env[name] === "string" && env[name] !== "" ? env[name] : null;
  if (value(KIT_ENV)) return { name: KIT_ENV, value: value(KIT_ENV), deprecated: false, legacyAlsoSet: value(LEGACY_KIT_ENV) !== null };
  if (value(LEGACY_KIT_ENV)) return { name: LEGACY_KIT_ENV, value: value(LEGACY_KIT_ENV), deprecated: true, legacyAlsoSet: true };
  return { name: null, value: null, deprecated: false, legacyAlsoSet: false };
}
// Notes for command output. Nothing here changes behavior; the owner updates the shell profile by hand.
export function envNotes(env = process.env) {
  const kit = kitEnv(env);
  if (kit.deprecated) return [{ code: "LEGACY_KIT_ENV", message: LEGACY_KIT_ENV + " is deprecated; export " + KIT_ENV + " instead and remove " + LEGACY_KIT_ENV + " from the shell profile", using: LEGACY_KIT_ENV }];
  if (kit.legacyAlsoSet) return [{ code: "LEGACY_KIT_ENV", message: LEGACY_KIT_ENV + " is still set and is ignored because " + KIT_ENV + " is set; remove it from the shell profile", using: KIT_ENV }];
  return [];
}
