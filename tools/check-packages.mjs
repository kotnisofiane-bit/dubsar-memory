import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundary } from "./check-public-boundary.mjs";
import { generateReleaseInventory } from "./generate-release-inventory.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const registryPath = fileURLToPath(
  new URL("./package-registry.json", import.meta.url),
);

function parseMode(argv) {
  if (argv.length !== 2 || argv[0] !== "--mode") {
    throw new Error("INVALID_ARGUMENTS");
  }
  const mode = argv[1];
  if (!new Set(["development", "inventory", "release"]).has(mode)) {
    throw new Error("INVALID_MODE");
  }
  return mode;
}

function insideRepository(candidate) {
  const relative = path.relative(repositoryRoot, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function loadRegistry() {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  if (
    registry?.format !== "dubsar.package-registry/1" ||
    !Array.isArray(registry.packages) ||
    registry.packages.length === 0
  ) {
    throw new Error("INVALID_PACKAGE_REGISTRY");
  }
  const names = new Set();
  const paths = new Set();
  const packages = [];
  for (const entry of registry.packages) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(entry.name) ||
      typeof entry.path !== "string" ||
      typeof entry.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(entry.version) ||
      !["approved", "pending"].includes(entry.release_review) ||
      names.has(entry.name) ||
      paths.has(entry.path)
    ) {
      throw new Error("INVALID_PACKAGE_REGISTRY_ENTRY");
    }
    const absolute = path.resolve(repositoryRoot, entry.path);
    if (!insideRepository(absolute)) {
      throw new Error("PACKAGE_PATH_OUTSIDE_REPOSITORY");
    }
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("PACKAGE_PATH_UNSAFE");
    }
    names.add(entry.name);
    paths.add(entry.path);
    packages.push({ ...entry, absolute });
  }
  return packages;
}

export function validateRegistryProvenance(entry, provenance) {
  if (
    provenance?.format !== "dubsar.public-provenance/1" ||
    provenance?.package !== entry.name ||
    provenance?.version !== entry.version
  ) {
    throw new Error(`PACKAGE_REGISTRY_PROVENANCE_IDENTITY_MISMATCH:${entry.name}`);
  }

  const approved =
    provenance.status === "approved" &&
    provenance.release_review === "approved" &&
    typeof provenance.reviewed_at === "string" &&
    provenance.reviewed_at.trim() !== "" &&
    typeof provenance.reviewed_by === "string" &&
    provenance.reviewed_by.trim() !== "";
  const pending =
    provenance.status === "draft" &&
    provenance.release_review === "pending" &&
    provenance.reviewed_at === null &&
    provenance.reviewed_by === null;

  if (!approved && !pending) {
    throw new Error(`PACKAGE_PROVENANCE_STATE_INVALID:${entry.name}`);
  }
  const derivedReleaseReview = approved ? "approved" : "pending";
  if (entry.release_review !== derivedReleaseReview) {
    throw new Error(`PACKAGE_REGISTRY_PROVENANCE_STATE_MISMATCH:${entry.name}`);
  }
}

async function validateRegistryProvenanceFiles(packages) {
  for (const entry of packages) {
    let provenance;
    try {
      provenance = JSON.parse(
        await readFile(path.join(entry.absolute, "PROVENANCE.json"), "utf8"),
      );
    } catch {
      throw new Error(`PACKAGE_PROVENANCE_UNREADABLE:${entry.name}`);
    }
    validateRegistryProvenance(entry, provenance);
  }
}

async function validateCatalogs(packages) {
  const catalogDefinitions = [
    {
      path: ".claude-plugin/marketplace.json",
      sourceOf(entry) {
        return entry?.source;
      },
      versioned: true,
    },
    {
      path: ".agents/plugins/marketplace.json",
      sourceOf(entry) {
        return entry?.source?.path;
      },
      versioned: false,
    },
    {
      path: ".cursor-plugin/marketplace.json",
      sourceOf(entry) {
        return entry?.source;
      },
      versioned: false,
    },
  ];
  for (const definition of catalogDefinitions) {
    const catalog = JSON.parse(
      await readFile(path.join(repositoryRoot, definition.path), "utf8"),
    );
    if (!Array.isArray(catalog?.plugins)) {
      throw new Error(`INVALID_PACKAGE_CATALOG:${definition.path}`);
    }
    for (const item of packages) {
      const matches = catalog.plugins.filter(
        (entry) => entry?.name === item.name,
      );
      const expectedSource = `./${item.path.replaceAll("\\", "/")}`;
      if (
        matches.length !== 1 ||
        definition.sourceOf(matches[0]) !== expectedSource ||
        (definition.versioned && matches[0]?.version !== item.version)
      ) {
        throw new Error(
          `PACKAGE_CATALOG_IDENTITY_MISMATCH:${definition.path}:${item.name}`,
        );
      }
    }
    if (catalog.plugins.length !== packages.length) {
      throw new Error(`PACKAGE_CATALOG_SET_MISMATCH:${definition.path}`);
    }
  }
}

export async function runPackageChecks(mode) {
  if (!new Set(["development", "inventory", "release"]).has(mode)) {
    throw new Error("INVALID_MODE");
  }
  const packages = await loadRegistry();
  await validateCatalogs(packages);
  await validateRegistryProvenanceFiles(packages);

  if (mode === "inventory") {
    const results = [];
    for (const entry of packages) {
      results.push(await generateReleaseInventory(entry.absolute));
    }
    process.stdout.write(
      `${JSON.stringify({ status: "pass", mode, results }, null, 2)}\n`,
    );
  } else {
    const results = [];
    for (const entry of packages) {
      results.push({
        package: entry.name,
        release_review: entry.release_review,
        result: await checkBoundary(entry.absolute, mode),
      });
    }
    const status = results.every((entry) => entry.result.status === "pass")
      ? "pass"
      : "fail";
    process.stdout.write(
      `${JSON.stringify({ status, mode, results }, null, 2)}\n`,
    );
    if (status !== "pass") {
      process.exitCode = 1;
    }
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runPackageChecks(parseMode(process.argv.slice(2)));
}
