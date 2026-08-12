import { TextDecoder } from "node:util";
import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  deepFreeze,
  rootDigest,
} from "../../dubsar-operator-core/src/contracts.mjs";
import { safeDisplayText } from "../../dubsar-operator-core/src/display-safety.mjs";
import { openDirectory } from "../../dubsar-operator-core/src/path-safety.mjs";
import { captureRegularFile } from "../../dubsar-operator-core/src/safe-capture.mjs";

export const PERSONAL_MEMORY_FORMAT = "dubsar.personal-memory-snapshot/1";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10;
const decoder = new TextDecoder("utf-8", { fatal: true });
const categories = Object.freeze([
  Object.freeze({ id: "decisions", label: "D\u00e9cisions", file: "decisions.md" }),
  Object.freeze({ id: "learnings", label: "Apprentissages", file: "learnings.md" }),
  Object.freeze({ id: "blockers", label: "Blocages", file: "blockers.md" }),
  Object.freeze({ id: "journal", label: "Journal", file: "journal.md" }),
  Object.freeze({ id: "evals", label: "\u00c9valuations", file: "evals.md" }),
]);

function cleanMarkdown(value, maxChars) {
  const simplified = value
    .replace(/^[-*]\s+/u, "")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu, "$1");
  return safeDisplayText(simplified, maxChars).text;
}

function linksFrom(value) {
  const links = [];
  for (const match of value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) {
    const link = safeDisplayText(match[1], 160).text;
    if (link.length > 0 && link !== "[content redacted]" && !links.includes(link)) {
      links.push(link);
    }
    if (links.length >= 16) break;
  }
  return links;
}

function parseEntries(text, categoryId) {
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { heading: line.slice(3), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections
    .slice(-MAX_ENTRIES)
    .reverse()
    .map((section, index) => {
      const rawBody = section.body.filter((line) => line.trim().length > 0).join(" ");
      const date = section.heading.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.at(0) ?? "date non indiquee";
      return Object.freeze({
        id: `memory-${categoryId}-${String(index).padStart(3, "0")}`,
        date,
        title: cleanMarkdown(section.heading, 180) || "Entree sans titre",
        preview: cleanMarkdown(rawBody, 320) || "Aucun apercu disponible.",
        links: Object.freeze(linksFrom(`${section.heading}\n${rawBody}`)),
      });
    });
}

export async function capturePersonalMemory(root) {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new WorkbenchError("MEMORY_ROOT_INVALID");
  }
  const safeRoot = await openDirectory(root);
  const captured = [];
  let totalBytes = 0;
  for (const category of categories) {
    const file = await captureRegularFile(safeRoot, category.file, MAX_FILE_BYTES);
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new WorkbenchError("MEMORY_SIZE_LIMIT_EXCEEDED");
    }
    let text;
    try {
      text = decoder.decode(file.content);
    } catch {
      throw new WorkbenchError("MEMORY_UTF8_INVALID");
    }
    captured.push({ category, file, entries: parseEntries(text, category.id) });
  }
  const snapshotSha256 = rootDigest(
    captured.map(({ category, file }) => ({
      path: category.file,
      sha256: file.sha256,
    })),
  );
  return deepFreeze({
    format: PERSONAL_MEMORY_FORMAT,
    authority: "private_advisory_snapshot",
    status: "included",
    canonical_authority: WORKBENCH_AUTHORITY,
    snapshot_sha256: snapshotSha256,
    categories: captured.map(({ category, entries }) => ({
      id: category.id,
      label: category.label,
      count: entries.length,
      entries,
    })),
  });
}
