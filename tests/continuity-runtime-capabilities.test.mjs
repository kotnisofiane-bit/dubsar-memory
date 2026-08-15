import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_CAPABILITIES,
  ownsContinuityInvocation,
  runContinuityCli,
} from "../packages/dubsar-project-continuity/runtime/cli.mjs";

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const result = await runContinuityCli(argv, {
    writeOut(value) { stdout += value; },
    writeErr(value) { stderr += value; },
  });
  return { ...result, stdout, stderr };
}

test("runtime capabilities are workspace-free, closed, stable, and delegated by hosts", async () => {
  assert.equal(ownsContinuityInvocation(["capabilities", "--json"]), true);

  const first = await invoke(["capabilities", "--json"]);
  const second = await invoke(["capabilities", "--json"]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);

  const value = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(value).sort(), [
    "authority",
    "capabilities",
    "format",
    "producer",
    "runtime",
  ]);
  assert.deepEqual(Object.keys(value.producer).sort(), ["name", "version"]);
  assert.deepEqual(Object.keys(value.runtime).sort(), ["minimum_node_major", "node"]);
  assert.equal(value.format, "dubsar.runtime-capabilities/1");
  assert.equal(value.authority, "local_preparation_record");
  assert.equal(value.producer.name, "@dubsar/project-continuity");
  assert.equal(value.producer.version, "0.3.0-dev");
  assert.equal(value.runtime.node, process.version);
  assert.equal(value.runtime.minimum_node_major, 20);
  assert.deepEqual(value.capabilities, [...RUNTIME_CAPABILITIES]);
  assert.deepEqual(
    value.capabilities,
    [...new Set(value.capabilities)].sort((left, right) => left.localeCompare(right, "en")),
  );
  for (const capability of value.capabilities) {
    assert.match(capability, /^[a-z][a-z0-9.-]{2,127}\.v[1-9][0-9]*$/u);
  }
  assert.equal(first.stdout.includes(process.cwd()), false);
});

test("runtime capabilities reject workspace and write options", async () => {
  for (const args of [
    ["capabilities", "--start", ".", "--json"],
    ["capabilities", "--apply", "--json"],
    ["capabilities", "--expected-change", "0".repeat(64), "--json"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "CLI_ARGUMENT_INVALID");
  }
});
