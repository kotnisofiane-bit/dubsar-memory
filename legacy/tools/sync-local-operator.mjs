import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const destinationRoot = path.join(
  repositoryRoot,
  "packages",
  "dubsar-local-operator",
  "skills",
);
const sourceRoots = [
  path.join(repositoryRoot, "packages", "dubsar-project-continuity", "skills"),
  path.join(repositoryRoot, "packages", "dubsar-audit-readiness", "skills"),
];

async function relativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`SYMLINK_NOT_ALLOWED:${absolute}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    } else {
      throw new Error(`UNSUPPORTED_ENTRY:${absolute}`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function copySkill(sourceRoot, skillName) {
  const source = path.join(sourceRoot, skillName);
  const destination = path.join(destinationRoot, skillName);
  await cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  const sourceFiles = await relativeFiles(source);
  const destinationFiles = await relativeFiles(destination);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw new Error(`BUNDLE_FILE_SET_MISMATCH:${skillName}`);
  }
  for (const relative of sourceFiles) {
    const sourceBytes = await readFile(path.join(source, relative));
    const destinationBytes = await readFile(path.join(destination, relative));
    if (!sourceBytes.equals(destinationBytes)) {
      throw new Error(`BUNDLE_CONTENT_MISMATCH:${skillName}:${relative}`);
    }
  }
  return { skill: skillName, files: sourceFiles.length };
}

await mkdir(destinationRoot, { recursive: true });
const results = [];
for (const sourceRoot of sourceRoots) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.name === "dubsar-local-operator") {
      throw new Error("RESERVED_SKILL_NAME_COLLISION");
    }
    results.push(await copySkill(sourceRoot, entry.name));
  }
}

process.stdout.write(
  `${JSON.stringify({ status: "pass", bundled: results }, null, 2)}\n`,
);
