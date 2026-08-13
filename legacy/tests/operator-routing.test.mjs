import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const operatorRoot = path.join(
  repositoryRoot,
  "packages",
  "dubsar-local-operator",
);
const operatorSkillRoot = path.join(
  operatorRoot,
  "skills",
  "dubsar-local-operator",
);
const routedSkills = [
  "checkpoint-project-context",
  "decompose-project-lots",
  "draft-execution-contract",
  "dubsar-audit-readiness",
  "dubsar-project-continuity",
  "export-audit-bundle",
  "frame-audit-scope",
  "frame-project-mission",
  "inventory-automations",
  "map-sensitive-actions",
  "record-project-evidence",
  "resume-project-context",
  "review-evidence-gaps",
];

test("every Operator route resolves to one bundled skill", async () => {
  const routing = await readFile(
    path.join(operatorSkillRoot, "references", "routing-contract.md"),
    "utf8",
  );
  const bundled = new Set(
    (await readdir(path.join(operatorRoot, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  assert.equal(bundled.size, 14);
  for (const skill of routedSkills) {
    assert.equal(bundled.has(skill), true, skill);
    assert.match(routing, new RegExp(`\\b${skill}\\b`, "u"), skill);
  }
});

test("the Operator remains explicit and outside legacy runtime boundaries", async () => {
  const skill = await readFile(path.join(operatorSkillRoot, "SKILL.md"), "utf8");
  const metadata = await readFile(
    path.join(operatorSkillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(metadata, /allow_implicit_invocation:\s*false/u);
  assert.match(
    skill,
    /^---\r?\nname: dubsar-local-operator\r?\ndescription: .+\r?\n---/u,
  );
  assert.equal(skill.includes("[TODO"), false);
  assert.match(skill, /Do not require or call DUBSAR Core/u);
  assert.match(skill, /Do not access the network/u);
  assert.match(skill, /Do not import state from the historical DUBSAR Operator/u);
  assert.match(skill, /personal memory/u);
});
