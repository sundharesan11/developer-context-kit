// U9: `devtwin setup`, the terminal loop over the same steps as `setup plan|apply` (KTD13). For each step it shows the
// what, why and undo text and the preview, then asks y/N. Only "y" or "yes" applies. Without a terminal it refuses and
// points to the devtwin-setup skill. The streams are ctx.stdin and ctx.stdout, so tests inject both.
import { createInterface } from "node:readline";
import { DevtwinError, toJson } from "../errors.mjs";
import { loadPilot, rootsFromPilot } from "../config/pilot.mjs";
import { STEPS } from "./steps.mjs";
import { setupOptions, stepContext, describe, planStep, applyStep } from "./commands.mjs";

const REMEDY = "devtwin setup needs a terminal. In an agent session, ask the agent to use the devtwin-setup skill. It runs setup status, setup plan --step <id> and setup apply --step <id> with the same steps.";
const indent = (text) => text.split("\n").map((line) => "    " + line).join("\n");
// The live config can change during the loop (the write class step), so each step reads it again.
async function reload(ctx) {
  const pilot = await loadPilot(ctx.values.pilot, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot });
  return { ...ctx, pilot, roots: rootsFromPilot(pilot) };
}
export const setupLoopCommand = { options: setupOptions, interactive: true, async run(values, ctx) {
  const { stdin, stdout } = ctx;
  if (!stdin?.isTTY || !stdout?.isTTY) throw new DevtwinError("GATE_REQUIRED", "Setup needs a terminal", { remedy: REMEDY });
  const say = (text = "") => stdout.write(text + "\n");
  const lines = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
  const next = lines[Symbol.asyncIterator]();
  const ask = async (question) => {
    stdout.write(question);
    const answer = await next.next();
    return answer.done ? "" : answer.value.trim().toLowerCase();
  };
  let c = stepContext(values, ctx), failed = 0, applied = 0;
  say("devtwin setup: " + STEPS.length + " steps. Each step shows what it changes, why, and how to undo it, then asks. Only y applies.");
  try {
    for (const [index, step] of STEPS.entries()) {
      c = await reload(c);
      say();
      say("Step " + (index + 1) + "/" + STEPS.length + " [" + step.id + "] " + step.title);
      const header = await describe(step, c);
      if (step.available !== true) { say("  " + step.available + ". Skipped."); continue; }
      if (header.skipped) { say("  Skipped: " + header.skipped + "."); continue; }
      if (header.done) { say("  done"); continue; }
      say("  What: " + header.what);
      say("  Why: " + header.why);
      say("  Undo: " + header.undo);
      const plan = await planStep(step, c);
      if (plan.problem) { say("  Cannot preview: " + plan.problem.code + " " + plan.problem.message + " " + JSON.stringify(plan.problem.details)); continue; }
      say("  Preview:");
      say(indent(JSON.stringify(plan.preview, null, 2)));
      if (!plan.fingerprint) { say("  Nothing to apply in this step."); continue; }
      const answer = await ask("Apply step " + step.id + "? [y/N] ");
      if (answer !== "y" && answer !== "yes") { say("  Not applied."); continue; }
      try {
        const result = await applyStep(step, c, plan.fingerprint);
        applied++;
        say("  Applied.");
        say(indent(JSON.stringify(result.result, null, 2)));
      } catch (error) {
        failed++;
        const e = toJson(error);
        say("  Apply failed: " + e.code + " " + e.message);
      }
    }
  } finally { lines.close(); }
  say();
  say("Setup finished: " + applied + " step(s) applied, " + failed + " failed. Run setup status to see each step.");
  return failed ? 1 : 0;
} };
