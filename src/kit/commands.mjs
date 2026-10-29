// U44: kit install plans by default and copies with --apply (no owner dialog, KTD5); kit list only reads.
const install = () => import("./install.mjs");
export const kitInstallCommand = {
  options: { apply: { type: "boolean" } },
  run: async (values, ctx) => values.apply ? (await install()).applyKitInstall(ctx) : (await install()).planKitInstall(ctx)
};
// --pilot names the live config whose pinned kit is marked; without it, <home>/.devtwin/live.json when present.
export const kitListCommand = { options: { pilot: { type: "string" } }, run: async (values, ctx) => (await install()).listKits({ home: ctx.home, pilot: values.pilot }) };
