// The acceptance harness: the offline demo (src/demo/run.mjs, also `devtwin demo`) with a caller-chosen pilot root,
// report path and extra forbidden paths.
import { runDemo } from "../src/demo/run.mjs";
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const forbidden = args.flatMap((name, i) => name === "--forbidden" ? [args[i + 1]] : []);
const out = await runDemo({ pilotRoot: arg("--pilot-root"), reportPath: arg("--report"), forbidden });
process.stdout.write(JSON.stringify(out) + "\n");
process.exitCode = out.ok ? 0 : 1;
