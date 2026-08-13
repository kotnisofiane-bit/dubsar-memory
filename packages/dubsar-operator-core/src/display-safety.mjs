export * from "../../dubsar-project-continuity/runtime/display-safety.mjs";

const STRUCTURAL_CREDENTIAL =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const STRUCTURAL_CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:(?:aws|github|gitlab|openai|anthropic|gemini|google|scw|scaleway|azure|db|database)[_-]?)?(?:password|secret|secret[_-]?access[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string|token|bearer)\b["']?\s*(?::|=|\b(?:is|equals?)\b)\s*["']?([^\s"',}]{4,})/iu;
const STRUCTURAL_CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const STRUCTURAL_ENV_CREDENTIAL_ASSIGNMENT =
  /["']?\b[A-Z][A-Z0-9_]{1,63}(?:_TOKEN|_PASSWORD|_SECRET|_SECRET_ACCESS_KEY|_ACCESS_KEY|_API_KEY|_PRIVATE_KEY)\b["']?\s*(?:=|:|\b(?:is|equals?)\b)\s*["']?[^\s"',}]{4,}/iu;
const STRUCTURAL_WINDOWS_PATH =
  /(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]*/u;
const STRUCTURAL_UNC_PATH =
  /\\\\[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)*/u;
const STRUCTURAL_FORWARD_UNC_PATH =
  /(?:^|[^\p{L}\p{N}:])\/\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*/u;
const STRUCTURAL_POSIX_PATH =
  /(?:^|[^\p{L}\p{N}:+.\/-])\/(?!\/)(?:[^/\s]+\/)*[^/\s]+/u;
const STRUCTURAL_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const STRUCTURAL_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
const STRUCTURAL_CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const STRUCTURAL_ACTIVE_INSTRUCTION =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|(?:^|\n)\s*(?:system|assistant|developer|user)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;
const STRUCTURAL_ROLE_MARKER =
  /(?:^|[^\p{L}\p{N}])(?:system|assistant|developer|user)\s*:/iu;

// Renderer-only structural safety: retain every display-safety rejection
// except the phone heuristic, which misclassifies valid UUID-like identifiers.
export function safeStructuralText(value, maxChars) {
  if (typeof value !== "string") {
    return Object.freeze({ text: "", redacted: false, truncated: false });
  }
  const normalized = value.normalize("NFKC");
  const instructionText = normalized.replace(/[-_.]+/gu, " ");
  if (
    STRUCTURAL_CONTROL.test(value) ||
    STRUCTURAL_CREDENTIAL.test(normalized) ||
    STRUCTURAL_CREDENTIAL_ASSIGNMENT.test(normalized) ||
    STRUCTURAL_CREDENTIAL_URL.test(normalized) ||
    STRUCTURAL_ENV_CREDENTIAL_ASSIGNMENT.test(normalized) ||
    STRUCTURAL_WINDOWS_PATH.test(normalized) ||
    STRUCTURAL_UNC_PATH.test(normalized) ||
    STRUCTURAL_FORWARD_UNC_PATH.test(normalized) ||
    STRUCTURAL_POSIX_PATH.test(normalized) ||
    STRUCTURAL_EMAIL.test(normalized) ||
    STRUCTURAL_IPV4.test(normalized) ||
    STRUCTURAL_ACTIVE_INSTRUCTION.test(instructionText) ||
    STRUCTURAL_ROLE_MARKER.test(instructionText)
  ) {
    return Object.freeze({ text: "[content redacted]", redacted: true, truncated: false });
  }
  if (normalized.length > maxChars) {
    return Object.freeze({ text: "[content truncated]", redacted: false, truncated: true });
  }
  return Object.freeze({ text: normalized, redacted: false, truncated: false });
}
