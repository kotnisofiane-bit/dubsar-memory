/**
 * Build the DUBSAR Memory extension artifact for Spec Kit.
 *
 * The extension source under integrations/spec-kit/dubsar-memory/ holds no copy
 * of the DUBSAR runtime. This step copies the sealed package into the artifact,
 * verifying every file against FILES.sha256.json as it goes, so the runtime has
 * exactly one source of truth in the repository.
 *
 * Output is deterministic: files are emitted in sorted order with fixed
 * timestamps and permissions, so the same inputs always produce the same ZIP.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_SOURCE = path.join(REPOSITORY_ROOT, "integrations", "spec-kit", "dubsar-memory");
const RUNTIME_SOURCE = path.join(REPOSITORY_ROOT, "packages", "dubsar-project-continuity");
const OUTPUT_NAME = "dubsar-memory-extension.zip";

// Only these paths of the sealed package travel into the artifact. Tests,
// plugin manifests for other hosts, and provenance metadata stay behind.
const RUNTIME_INCLUDE = Object.freeze(["bin/", "runtime/", "LICENSE", "README.md"]);
const SOURCE_EXCLUDE = Object.freeze([".gitignore", "node_modules", "runtime"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(root, current = root, out = []) {
  for (const entry of (await readdir(current, { withFileTypes: true })).sort(
    (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`SYMLINK_NOT_ALLOWED:${relative}`);
    if (entry.isDirectory()) {
      await collect(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) throw new Error(`UNSUPPORTED_ENTRY:${relative}`);
    out.push(relative);
  }
  return out;
}

/** Minimal deterministic ZIP writer: stored order, fixed DOS timestamp. */
function buildZip(entries) {
  const DOS_TIME = 0x0000;
  const DOS_DATE = 0x2821; // 2000-01-01, constant so the archive is reproducible.
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

let CRC_TABLE = null;
function crc32(buffer) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
      CRC_TABLE[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

export async function buildExtensionArtifact({ outputDirectory } = {}) {
  const target = outputDirectory ?? path.join(REPOSITORY_ROOT, "dist");
  const entries = [];

  // 1. Extension source, minus anything that must never ship.
  for (const relative of await collect(EXTENSION_SOURCE)) {
    if (SOURCE_EXCLUDE.some((skip) => relative === skip || relative.startsWith(`${skip}/`))) continue;
    entries.push({
      name: relative,
      bytes: await readFile(path.join(EXTENSION_SOURCE, relative)),
    });
  }

  // 2. Sealed runtime, verified against the package inventory on the way in.
  const inventory = JSON.parse(
    await readFile(path.join(RUNTIME_SOURCE, "FILES.sha256.json"), "utf8"),
  );
  const declared = new Map(inventory.files.map((item) => [item.path, item.sha256]));
  let copied = 0;
  for (const [relative, expected] of [...declared.entries()].sort()) {
    if (!RUNTIME_INCLUDE.some((keep) => relative === keep || relative.startsWith(keep))) continue;
    const bytes = await readFile(path.join(RUNTIME_SOURCE, relative));
    const observed = sha256(bytes);
    if (observed !== expected) {
      throw new Error(`RUNTIME_DIGEST_MISMATCH:${relative}`);
    }
    entries.push({ name: `runtime/${relative}`, bytes });
    copied += 1;
  }
  if (copied === 0) throw new Error("RUNTIME_EMPTY");

  // 2b. Canonical write contracts have exactly one source: the sealed package.
  // They are copied beside the extension's own write reference so the documents
  // can never drift apart.
  for (const [canonical, destination] of [
    [
      "skills/checkpoint-project-context/references/checkpoint-append.md",
      "docs/contracts/checkpoint-append.md",
    ],
    [
      "skills/checkpoint-project-context/references/bootstrap.md",
      "docs/contracts/bootstrap.md",
    ],
  ]) {
    const canonicalDigest = declared.get(canonical);
    if (canonicalDigest === undefined) throw new Error(`CANONICAL_REFERENCE_MISSING:${canonical}`);
    const canonicalBytes = await readFile(path.join(RUNTIME_SOURCE, canonical));
    if (sha256(canonicalBytes) !== canonicalDigest) {
      throw new Error(`RUNTIME_DIGEST_MISMATCH:${canonical}`);
    }
    entries.push({ name: destination, bytes: canonicalBytes });
  }

  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  // 3. No absolute path, user name, or development path may travel with it.
  const forbidden = /[A-Za-z]:\\{1,2}Users|\/home\/[a-z]|\/Users\/[A-Za-z]/u;
  for (const entry of entries) {
    if (!/\.(mjs|md|yml|json|txt)$/u.test(entry.name) && entry.name !== "LICENSE") continue;
    const text = entry.bytes.toString("utf8");
    if (forbidden.test(text)) throw new Error(`LOCAL_PATH_LEAK:${entry.name}`);
  }

  const archive = buildZip(entries);
  await mkdir(target, { recursive: true });
  const output = path.join(target, OUTPUT_NAME);
  await writeFile(output, archive);
  return {
    format: "dubsar.extension-artifact/1",
    output: path.relative(REPOSITORY_ROOT, output).replaceAll("\\", "/"),
    file_count: entries.length,
    runtime_files: copied,
    bytes: archive.length,
    artifact_sha256: sha256(archive),
  };
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const clean = process.argv.includes("--clean");
  const target = path.join(REPOSITORY_ROOT, "dist");
  if (clean) await rm(target, { recursive: true, force: true });
  const result = await buildExtensionArtifact();
  await stat(path.join(REPOSITORY_ROOT, result.output));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
