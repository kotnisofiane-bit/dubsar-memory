import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoots = [
  "dubsar-project-continuity",
  "dubsar-audit-readiness",
].map((name) => path.join(repositoryRoot, "packages", name));

async function sourceSkills() {
  const skills = [];
  for (const packageRoot of packageRoots) {
    const root = path.join(packageRoot, "skills");
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skills.push(path.join(root, entry.name, "SKILL.md"));
      }
    }
  }
  return skills.sort((left, right) => left.localeCompare(right, "en"));
}

test("both packs ship one byte-identical anti-loop review protocol", async () => {
  const projectProtocol = await readFile(
    path.join(
      packageRoots[0],
      "skills",
      "dubsar-project-continuity",
      "references",
      "review-protocol.md",
    ),
  );
  const auditProtocol = await readFile(
    path.join(
      packageRoots[1],
      "skills",
      "dubsar-audit-readiness",
      "references",
      "review-protocol.md",
    ),
  );
  assert.deepEqual(auditProtocol, projectProtocol);

  const protocol = projectProtocol.toString("utf8");
  for (const required of [
    /## Goal lock/u,
    /## Proportionality and finding disposition/u,
    /goal-lock\s+defect/u,
    /A severity label alone never blocks the current goal/u,
    /Never initialize another mission, case, lot, contract/u,
    /## Review budget and terminal states/u,
    /one review wave/u,
    /Budget exhaustion never implies acceptance/u,
      /whether\s+anything becomes usable immediately \(`yes` or `no`\)/u,
    /favorable or adverse/u,
      /Never waive revalidation by calling\s+a change cosmetic/u,
  ]) {
    assert.match(protocol, required);
  }
});

test("all thirteen source skills route material review through the common protocol", async () => {
  const skills = await sourceSkills();
  assert.equal(skills.length, 13);
  for (const skillPath of skills) {
    const skill = await readFile(skillPath, "utf8");
    assert.match(skill, /review-protocol\.md/u, path.relative(repositoryRoot, skillPath));
  }
});

test("approval-producing phases disclose usability and never auto-advance", async () => {
  const expected = new Map([
    ["frame-project-mission", /whether anything becomes usable immediately/u],
    ["decompose-project-lots", /no\s+contract or lot starts automatically/u],
    ["draft-execution-contract", /execution\s+will not begin automatically/u],
    ["frame-audit-scope", /evidence collection will\s+not start automatically/u],
  ]);
  for (const packageRoot of packageRoots) {
    for (const [skillName, pattern] of expected) {
      const skillPath = path.join(packageRoot, "skills", skillName, "SKILL.md");
      try {
        const skill = await readFile(skillPath, "utf8");
        assert.match(skill, pattern, skillName);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
});
