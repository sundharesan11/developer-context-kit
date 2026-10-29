#!/usr/bin/env node
// U46 (KTD6): a human's live command runs in the kit the live config pins (src/kit/forward.mjs).
import { runDevtwin } from "../src/kit/forward.mjs";
process.exitCode = await runDevtwin(process.argv.slice(2));
