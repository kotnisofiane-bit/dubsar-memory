#!/usr/bin/env node
import { runContinuityCli } from "../runtime/cli.mjs";

const result = await runContinuityCli(process.argv.slice(2));
process.exitCode = result.exitCode;
