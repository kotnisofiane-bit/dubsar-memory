import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INVENTORY_NAME = "FILES.sha256.json";

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`SYMLINK_NOT_ALLOWED:${absolute}`);
    }
    if (info.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`UNSUPPORTED_ENTRY:${absolute}`);
    }
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (relative !== INVENTORY_NAME) {
      files.push({ absolute, relative });
    }
  }

  return files;
}

export async function generateReleaseInventory(rootInput) {
  const root = path.resolve(rootInput);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`INVALID_PACKAGE_ROOT:${root}`);
  }

  const files = (await collectFiles(root)).sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file.relative,
      sha256: createHash("sha256")
        .update(await readFile(file.absolute))
        .digest("hex"),
    });
  }

  const rootLines = entries
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join("");
  const inventory = {
    format: "dubsar.public-file-inventory/1",
    root_sha256: createHash("sha256")
      .update(rootLines, "utf8")
      .digest("hex"),
    files: entries,
  };
  const output = path.join(root, INVENTORY_NAME);
  await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  return { root, output, files: entries.length, root_sha256: inventory.root_sha256 };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.argv.length < 3) {
    throw new Error(
      "USAGE: node tools/generate-release-inventory.mjs <package>...",
    );
  }

  const results = [];
  for (const packageRoot of process.argv.slice(2)) {
    results.push(await generateReleaseInventory(packageRoot));
  }
  process.stdout.write(
    `${JSON.stringify({ status: "pass", results }, null, 2)}\n`,
  );
}
