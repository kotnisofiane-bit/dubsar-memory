import path from "node:path";

const FORBIDDEN_ARTIFACT_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".node",
  ".zip",
  ".tar",
  ".7z",
  ".pem",
  ".key",
  ".kdbx",
  ".p12",
  ".pfx",
]);
const FORBIDDEN_ARTIFACT_BASENAMES = new Set([
  ".dockerconfigjson",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets",
  "secrets.json",
]);

const CREDENTIAL_PATTERN =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string|token|bearer)\b["']?\s*[:=]\s*["']?([^\s"',}]{6,})/iu;
const CREDENTIAL_ASSIGNMENTS =
  /["']?\b(?:password|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string|token|bearer)\b["']?\s*[:=]\s*["']?([^\s"',}]{6,})/giu;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;

export function artifactPolicyFinding(relativePath, content) {
  const portable = relativePath.replaceAll("\\", "/");
  const basename = path.posix.basename(portable).toLowerCase();
  const extension = path.posix.extname(basename);
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.startsWith("credentials.") ||
    basename.startsWith("secrets.") ||
    FORBIDDEN_ARTIFACT_BASENAMES.has(basename) ||
    FORBIDDEN_ARTIFACT_EXTENSIONS.has(extension)
  ) {
    return "ARTIFACT_FILE_TYPE_FORBIDDEN";
  }
  const text = content.toString("utf8");
  if (CREDENTIAL_PATTERN.test(text)) {
    return "ARTIFACT_CREDENTIAL_PATTERN";
  }
  for (const assignment of text.matchAll(CREDENTIAL_ASSIGNMENTS)) {
    const value = assignment[1].replace(/[<>]/gu, "").toLowerCase();
    if (!new Set(["redacted", "example", "dummy", "null", "none"]).has(value)) {
      return "ARTIFACT_CREDENTIAL_ASSIGNMENT";
    }
  }
  if (CREDENTIAL_URL.test(text)) {
    return "ARTIFACT_CREDENTIAL_URL";
  }
  return null;
}

export { safeDisplayText } from "./display-safety.mjs";
