#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

const code = await runCli(process.argv.slice(2), process);
if (typeof code === "number" && code !== 0) process.exitCode = code;
