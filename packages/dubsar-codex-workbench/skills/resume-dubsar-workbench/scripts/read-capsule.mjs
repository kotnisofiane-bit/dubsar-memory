#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMemoryResumeCapsule,
  assertProjectResumeCapsule,
  stableJson,
} from "../../../../dubsar-project-continuity/runtime/index.mjs";
import { CODEX_CAPSULE_ERROR_FORMAT } from "../../../src/index.mjs";

const cliPath = fileURLToPath(
  new URL("../../../../dubsar-operator-cli/bin/dubsar.mjs", import.meta.url),
);

function fail(code) {
  process.stderr.write(`${JSON.stringify({
    format: CODEX_CAPSULE_ERROR_FORMAT,
    status: "error",
    code,
  })}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv.at(0) !== "--project" ||
    typeof argv.at(1) !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(argv.at(1))
  ) {
    throw new Error("ADAPTER_ARGUMENT_INVALID");
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0) {
    throw new Error("ADAPTER_REGISTRY_UNAVAILABLE");
  }
  return {
    project: argv.at(1),
    registry: path.join(localAppData, "DUBSAR", "Workbench", "projects.json"),
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "capsule",
      "--registry",
      options.registry,
      "--project",
      options.project,
      "--json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    fail("ADAPTER_CAPSULE_READ_FAILED");
  } else {
    let capsule;
    try {
      const candidate = JSON.parse(result.stdout);
      capsule = candidate?.format === "dubsar.resume-capsule/2"
        ? assertProjectResumeCapsule(candidate)
        : candidate?.format === "dubsar.resume-capsule/3"
          ? assertMemoryResumeCapsule(candidate)
          : undefined;
      if (capsule === undefined) throw new Error("CAPSULE_FORMAT_UNSUPPORTED");
    } catch {
      fail("ADAPTER_CAPSULE_INVALID");
    }
    if (capsule !== undefined) process.stdout.write(stableJson(capsule));
  }
} catch (error) {
  fail(typeof error?.message === "string" && /^ADAPTER_[A-Z_]+$/u.test(error.message)
    ? error.message
    : "ADAPTER_UNEXPECTED_FAILURE");
}
