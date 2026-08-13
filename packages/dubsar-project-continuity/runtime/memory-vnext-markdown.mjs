import { WorkbenchError, deepFreeze, stableJson } from "./contracts.mjs";

const OPEN = "---\n";
const CLOSE = "---\n";
const MAX_MARKDOWN_CHARS = 65_536;

function fail() {
  throw new WorkbenchError("MEMORY_MARKDOWN_INVALID");
}

export function parseMemoryMarkdown(source) {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_MARKDOWN_CHARS ||
    !source.startsWith(OPEN) || /\r/u.test(source)) fail();
  const closeAt = source.indexOf(`\n${CLOSE}`, OPEN.length);
  if (closeAt < 0) fail();
  const jsonSource = source.slice(OPEN.length, closeAt + 1);
  const body = source.slice(closeAt + 1 + CLOSE.length);
  if (/(?:^|\n)---(?:\n|$)/u.test(body)) fail();
  let frontmatter;
  try {
    frontmatter = JSON.parse(jsonSource);
  } catch {
    fail();
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter) ||
    stableJson(frontmatter) !== jsonSource) fail();
  return deepFreeze({ frontmatter, body });
}

export function serializeMemoryMarkdown({ frontmatter, body } = {}) {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter) ||
    typeof body !== "string" || /\r/u.test(body) || /(?:^|\n)---(?:\n|$)/u.test(body)) fail();
  const output = `${OPEN}${stableJson(frontmatter)}${CLOSE}${body}`;
  if (output.length > MAX_MARKDOWN_CHARS) fail();
  parseMemoryMarkdown(output);
  return output;
}
