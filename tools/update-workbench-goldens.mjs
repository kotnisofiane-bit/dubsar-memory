import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/dubsar-operator-cli/src/cli.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const goldenRoot = path.join(repositoryRoot, "tests", "golden", "workbench");
const root = await mkdtemp(path.join(tmpdir(), "dubsar-golden-update-"));

try {
  await mkdir(path.join(root, ".git"));
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(root, ".dubsar-project"),
    { recursive: true },
  );
  for (const [command, filename] of [
    ["status", "project-status.json"],
    ["validate", "project-validate.json"],
    ["report", "project-report.json"],
  ]) {
    let stdout = "";
    let stderr = "";
    const result = await runCli([
      command,
      "--domain",
      "project",
      "--start",
      root,
      "--json",
    ], {
      writeOut(value) { stdout += value; },
      writeErr(value) { stderr += value; },
    });
    if (result.exitCode !== 0 || stderr !== "" || stdout.includes(root)) {
      throw new Error(`GOLDEN_GENERATION_FAILED:${command}`);
    }
    await writeFile(path.join(goldenRoot, filename), stdout, {
      encoding: "utf8",
      flag: "w",
    });
  }
  process.stdout.write('{"status":"updated","goldens":3}\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
