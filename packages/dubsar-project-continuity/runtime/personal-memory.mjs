import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const PERSONAL_MEMORY_AUTHORITY = "personal_advisory";
export const PERSONAL_MEMORY_IDENTITY = Object.freeze({
  name: "@dubsar/personal-memory",
  version: "0.1.0-dev",
});
export const PERSONAL_MEMORY_INIT_PREVIEW_FORMAT = "dubsar.personal-memory-init-preview/1";
export const PERSONAL_MEMORY_INIT_APPLY_FORMAT = "dubsar.personal-memory-init-apply/1";
export const PERSONAL_MEMORY_UPDATE_PREVIEW_FORMAT = "dubsar.personal-memory-update-preview/1";
export const PERSONAL_MEMORY_UPDATE_APPLY_FORMAT = "dubsar.personal-memory-update-apply/1";

export const PERSONAL_MEMORY_FILES = Object.freeze([
  "decisions.md",
  "learnings.md",
  "blockers.md",
  "journal.md",
  "evals.md",
]);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const CATEGORY = new Map([
  ["decisions", Object.freeze({ file: "decisions.md", prefix: "D", title: "Decisions" })],
  ["learnings", Object.freeze({ file: "learnings.md", prefix: "L", title: "Learnings" })],
  ["blockers", Object.freeze({ file: "blockers.md", prefix: "B", title: "Blockers" })],
  ["journal", Object.freeze({ file: "journal.md", prefix: "J", title: "Journal" })],
  ["evals", Object.freeze({ file: "evals.md", prefix: "E", title: "Evaluations" })],
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const ACTIVE_INSTRUCTION =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|^\s*(?:system|assistant|developer|user)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;
const ROLE_MARKER = /(?:^|[^\p{L}\p{N}])(?:system|assistant|developer|user)\s*:/iu;
const ACTIVE_HTML = /<(?:script|iframe|object|embed|img|link|style)\b|javascript\s*:|data\s*:\s*text\/html/iu;
const CREDENTIAL =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|token)\b\s*(?::|=|\bis\b)\s*\S{4,}/iu;
const WINDOWS_ABSOLUTE_PATH = /(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]*/u;
const UNC_PATH = /\\\\[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)*/u;
const FORWARD_UNC_PATH = /(?:^|[^\p{L}\p{N}:])\/\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*/u;
const POSIX_ABSOLUTE_PATH = /(?:^|[^\p{L}\p{N}:+.\/-])\/(?!\/)(?:[^/\s]+\/)*[^/\s]+/u;
const AUTHENTICATED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:^|[^\p{L}\p{N}])(?!\d{4}-\d{2}-\d{2}(?:$|[^\p{L}\p{N}]))\+?\d(?:[ ./()-]*\d){7,}(?=$|[^\p{L}\p{N}])/u;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;

export class PersonalMemoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "PersonalMemoryError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  const sort = (item) => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1).map(
          ([key, child]) => [key, sort(child)],
        ))
      : item;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function memoryPaths() {
  if (process.platform !== "win32") {
    throw new PersonalMemoryError("MEMORY_PLATFORM_UNSUPPORTED");
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (
    typeof localAppData !== "string" || localAppData.includes("\0") ||
    !path.win32.isAbsolute(localAppData) || localAppData.startsWith("\\\\") ||
    localAppData.startsWith("\\\\?\\") || localAppData.startsWith("\\\\.\\")
  ) throw new PersonalMemoryError("MEMORY_LOCALAPPDATA_INVALID");
  const base = path.resolve(localAppData);
  return {
    localAppData: base,
    parent: path.join(base, "DUBSAR"),
    root: path.join(base, "DUBSAR", "Memory"),
  };
}

function memoryRootDigest(paths) {
  return sha256(Buffer.from(paths.root.toLowerCase(), "utf8"));
}

function assertSameMemoryRoot(paths, expectedDigest) {
  const current = memoryPaths();
  if (memoryRootDigest(current) !== expectedDigest || current.root !== paths.root) {
    throw new PersonalMemoryError("MEMORY_ROOT_CHANGED");
  }
}

async function info(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new PersonalMemoryError("MEMORY_PATH_INSPECTION_FAILED");
  }
}

async function assertSafeExistingDirectory(target) {
  const parsed = path.parse(target);
  const parts = path.relative(parsed.root, target).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const currentInfo = await info(current);
    if (!currentInfo?.isDirectory() || currentInfo.isSymbolicLink()) {
      throw new PersonalMemoryError("MEMORY_DIRECTORY_UNSAFE");
    }
  }
}

async function captureFile(root, file) {
  const target = path.join(root, file);
  const fileInfo = await info(target);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink > 1n) {
    throw new PersonalMemoryError("MEMORY_FILE_UNSAFE");
  }
  if (fileInfo.size > BigInt(MAX_FILE_BYTES)) {
    throw new PersonalMemoryError("MEMORY_FILE_SIZE_LIMIT_EXCEEDED");
  }
  const handle = await open(target, "r");
  try {
    const afterOpen = await handle.stat({ bigint: true });
    if (
      !afterOpen.isFile() || afterOpen.nlink > 1n ||
      afterOpen.dev !== fileInfo.dev || afterOpen.ino !== fileInfo.ino
    ) throw new PersonalMemoryError("MEMORY_FILE_CHANGED");
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    if (
      afterRead.dev !== afterOpen.dev || afterRead.ino !== afterOpen.ino ||
      afterRead.size !== BigInt(bytes.length) || afterRead.mtimeNs !== afterOpen.mtimeNs
    ) throw new PersonalMemoryError("MEMORY_FILE_CHANGED");
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new PersonalMemoryError("MEMORY_UTF8_INVALID");
    }
    return { file, bytes, text, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

async function captureMemory(root) {
  await assertSafeExistingDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== PERSONAL_MEMORY_FILES.length ||
    names.some((name, index) => name !== [...PERSONAL_MEMORY_FILES].sort().at(index)) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) throw new PersonalMemoryError("MEMORY_FILE_SET_INVALID");
  const files = [];
  let total = 0;
  for (const file of PERSONAL_MEMORY_FILES) {
    const captured = await captureFile(root, file);
    total += captured.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new PersonalMemoryError("MEMORY_TOTAL_SIZE_LIMIT_EXCEEDED");
    files.push(captured);
  }
  return files;
}

function initialContent(file) {
  const category = [...CATEGORY.values()].find((item) => item.file === file);
  return `# ${category.title}\n\nPersonal advisory memory. Project authority is stored elsewhere.\n`;
}

async function writeExclusiveFile(target, bytes) {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function validatePersonalMemoryText(value) {
  const policyValue = typeof value === "string" ? value.normalize("NFKC") : value;
  if (
    typeof value !== "string" || value === "" || value !== value.trim() ||
    Array.from(value).length > 500 || FORBIDDEN_TEXT.test(value) ||
    ACTIVE_INSTRUCTION.test(policyValue) || ROLE_MARKER.test(policyValue) || ACTIVE_HTML.test(policyValue) ||
    CREDENTIAL.test(policyValue) || CREDENTIAL_ASSIGNMENT.test(policyValue) ||
    WINDOWS_ABSOLUTE_PATH.test(policyValue) || UNC_PATH.test(policyValue) ||
    FORWARD_UNC_PATH.test(policyValue) || POSIX_ABSOLUTE_PATH.test(policyValue) ||
    AUTHENTICATED_URL.test(policyValue) ||
    EMAIL.test(policyValue) || PHONE.test(policyValue) || IPV4.test(policyValue)
  ) throw new PersonalMemoryError("MEMORY_TEXT_INVALID");
  return value;
}

export async function preparePersonalMemoryInitialization() {
  const paths = memoryPaths();
  await assertSafeExistingDirectory(paths.localAppData);
  if (await info(paths.root)) throw new PersonalMemoryError("MEMORY_ALREADY_EXISTS");
  const staging = path.join(
    paths.localAppData,
    `.dubsar-memory-init-${randomBytes(12).toString("hex")}`,
  );
  await mkdir(staging, { mode: 0o700 });
  let published = false;
  try {
    for (const file of PERSONAL_MEMORY_FILES) {
      await writeExclusiveFile(path.join(staging, file), Buffer.from(initialContent(file), "utf8"));
    }
    const captured = await captureMemory(staging);
    const base = {
      operation: "initialize_personal_memory",
      files: [...PERSONAL_MEMORY_FILES],
      root_sha256: memoryRootDigest(paths),
      content_sha256: sha256(Buffer.from(
        captured.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
        "utf8",
      )),
    };
    const preview = Object.freeze({
      format: PERSONAL_MEMORY_INIT_PREVIEW_FORMAT,
      authority: PERSONAL_MEMORY_AUTHORITY,
      status: "preview",
      ...base,
      change_sha256: sha256(Buffer.from(stableJson(base), "utf8")),
    });
    return Object.freeze({
      preview,
      async apply(confirmation) {
        if (confirmation !== "CREATE") throw new PersonalMemoryError("MEMORY_CREATE_NOT_CONFIRMED");
        assertSameMemoryRoot(paths, preview.root_sha256);
        if (await info(paths.root)) throw new PersonalMemoryError("MEMORY_ALREADY_EXISTS");
        const stagedBeforePublish = await captureMemory(staging);
        const stagedDigest = sha256(Buffer.from(
          stagedBeforePublish.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
          "utf8",
        ));
        if (stagedDigest !== preview.content_sha256) {
          throw new PersonalMemoryError("MEMORY_STAGING_MISMATCH");
        }
        const parentInfo = await info(paths.parent);
        if (parentInfo === null) {
          await mkdir(paths.parent, { mode: 0o700 });
        } else if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
          throw new PersonalMemoryError("MEMORY_DIRECTORY_UNSAFE");
        }
        await assertSafeExistingDirectory(paths.parent);
        const revalidatedStaging = await captureMemory(staging);
        const revalidatedDigest = sha256(Buffer.from(
          revalidatedStaging.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
          "utf8",
        ));
        if (revalidatedDigest !== preview.content_sha256) {
          throw new PersonalMemoryError("MEMORY_STAGING_MISMATCH");
        }
        await rename(staging, paths.root);
        published = true;
        const final = await captureMemory(paths.root);
        const finalDigest = sha256(Buffer.from(
          final.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
          "utf8",
        ));
        if (finalDigest !== preview.content_sha256) {
          throw new PersonalMemoryError("MEMORY_PUBLICATION_MISMATCH");
        }
        return Object.freeze({
          format: PERSONAL_MEMORY_INIT_APPLY_FORMAT,
          authority: PERSONAL_MEMORY_AUTHORITY,
          status: "created",
          change_sha256: preview.change_sha256,
          content_sha256: finalDigest,
        });
      },
      async cancel() {
        if (!published) await rm(staging, { recursive: true, force: true });
      },
    });
  } catch (error) {
    if (!published) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function nextEntryId(text, category) {
  const pattern = new RegExp(`^## ${category.prefix}-(\\d{3}) — \\d{4}-\\d{2}-\\d{2}$`, "gmu");
  let highest = 0;
  for (const match of text.matchAll(pattern)) highest = Math.max(highest, Number(match[1]));
  if (highest >= 999) throw new PersonalMemoryError("MEMORY_ENTRY_LIMIT_EXCEEDED");
  return `${category.prefix}-${String(highest + 1).padStart(3, "0")}`;
}

function assertDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new PersonalMemoryError("MEMORY_DATE_INVALID");
  }
  const [year, month, day] = date.split("-").map(Number);
  const observed = new Date(Date.UTC(year, month - 1, day));
  if (
    observed.getUTCFullYear() !== year || observed.getUTCMonth() !== month - 1 ||
    observed.getUTCDate() !== day
  ) throw new PersonalMemoryError("MEMORY_DATE_INVALID");
  return date;
}

function memoryBlock({ category, id, date, text, checkpointDigest }) {
  const checkpoint = checkpointDigest === undefined
    ? ""
    : `- Checkpoint: ${checkpointDigest.slice(0, 12)}\n`;
  return `\n## ${id} — ${date}\n- Note: ${text}\n${checkpoint}`;
}

export async function preparePersonalMemoryAppend({
  category: categoryId,
  text,
  date,
  checkpointDigest,
}) {
  const category = CATEGORY.get(categoryId);
  if (!category) throw new PersonalMemoryError("MEMORY_CATEGORY_INVALID");
  if (categoryId === "journal") {
    if (typeof checkpointDigest !== "string" || !/^[0-9a-f]{64}$/u.test(checkpointDigest)) {
      throw new PersonalMemoryError("MEMORY_CHECKPOINT_DIGEST_INVALID");
    }
  } else if (checkpointDigest !== undefined) {
    throw new PersonalMemoryError("MEMORY_CHECKPOINT_DIGEST_INVALID");
  }
  const normalizedText = validatePersonalMemoryText(text);
  const normalizedDate = assertDate(date);
  const paths = memoryPaths();
  const files = await captureMemory(paths.root);
  const before = files.find((item) => item.file === category.file);
  const id = nextEntryId(before.text, category);
  const block = memoryBlock({
    category,
    id,
    date: normalizedDate,
    text: normalizedText,
    checkpointDigest,
  });
  const afterBytes = Buffer.from(`${before.text.replace(/\s*$/u, "\n")}${block}`, "utf8");
  if (afterBytes.length > MAX_FILE_BYTES) {
    throw new PersonalMemoryError("MEMORY_FILE_SIZE_LIMIT_EXCEEDED");
  }
  const base = {
    operation: "append_personal_memory",
    category: categoryId,
    entry_id: id,
    root_sha256: memoryRootDigest(paths),
    before_sha256: before.sha256,
    after_sha256: sha256(afterBytes),
  };
  const preview = Object.freeze({
    format: PERSONAL_MEMORY_UPDATE_PREVIEW_FORMAT,
    authority: PERSONAL_MEMORY_AUTHORITY,
    status: "preview",
    ...base,
    change_sha256: sha256(Buffer.from(stableJson(base), "utf8")),
    markdown: block.trimStart(),
  });
  return Object.freeze({
    preview,
    async apply(expectedChange) {
      if (expectedChange !== preview.change_sha256) {
        throw new PersonalMemoryError("MEMORY_CONFIRMATION_MISMATCH");
      }
      assertSameMemoryRoot(paths, preview.root_sha256);
      const lockPath = path.join(paths.parent, ".dubsar-memory.lock");
      const temporary = path.join(
        paths.parent,
        `.dubsar-memory-${randomBytes(12).toString("hex")}.tmp`,
      );
      const target = path.join(paths.root, category.file);
      let lockHandle;
      let temporaryHandle;
      let ownsLock = false;
      let published = false;
      try {
        try {
          lockHandle = await open(lockPath, "wx", 0o600);
          ownsLock = true;
        } catch {
          throw new PersonalMemoryError("MEMORY_LOCKED");
        }
        await assertSafeExistingDirectory(paths.parent);
        await assertSafeExistingDirectory(paths.root);
        const currentFiles = await captureMemory(paths.root);
        const current = currentFiles.find((item) => item.file === category.file);
        if (current.sha256 !== preview.before_sha256) {
          throw new PersonalMemoryError("MEMORY_CONCURRENT_CHANGE");
        }
        temporaryHandle = await open(temporary, "wx", 0o600);
        await temporaryHandle.writeFile(afterBytes);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        const staged = await captureFile(paths.parent, path.basename(temporary));
        if (staged.sha256 !== preview.after_sha256) {
          throw new PersonalMemoryError("MEMORY_STAGING_MISMATCH");
        }
        await assertSafeExistingDirectory(paths.parent);
        await assertSafeExistingDirectory(paths.root);
        const revalidatedFiles = await captureMemory(paths.root);
        const revalidated = revalidatedFiles.find((item) => item.file === category.file);
        if (revalidated.sha256 !== preview.before_sha256) {
          throw new PersonalMemoryError("MEMORY_CONCURRENT_CHANGE");
        }
        await rename(temporary, target);
        published = true;
        const finalFiles = await captureMemory(paths.root);
        const final = finalFiles.find((item) => item.file === category.file);
        if (final.sha256 !== preview.after_sha256) {
          throw new PersonalMemoryError("MEMORY_PUBLICATION_MISMATCH");
        }
        return Object.freeze({
          format: PERSONAL_MEMORY_UPDATE_APPLY_FORMAT,
          authority: PERSONAL_MEMORY_AUTHORITY,
          status: "applied",
          operation: preview.operation,
          category: preview.category,
          entry_id: preview.entry_id,
          change_sha256: preview.change_sha256,
          after_sha256: preview.after_sha256,
        });
      } finally {
        await temporaryHandle?.close();
        if (!published) await unlink(temporary).catch(() => {});
        await lockHandle?.close();
        if (ownsLock) await unlink(lockPath).catch(() => {});
      }
    },
  });
}
