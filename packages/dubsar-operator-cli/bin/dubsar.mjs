#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

const result = await runCli(process.argv.slice(2));
let exitCode = result.exitCode;

if (result.session) {
  let signalExitCode = 0;
  const onSigint = () => {
    signalExitCode = 130;
    void result.session.close("sigint");
  };
  const onSigterm = () => {
    signalExitCode = 143;
    void result.session.close("sigterm");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const closure = await result.session.closed;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  if (signalExitCode !== 0) {
    exitCode = signalExitCode;
  } else if (closure.reason === "server-error") {
    exitCode = 1;
  }
}

process.exitCode = exitCode;
