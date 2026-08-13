const CREDENTIAL_PATTERN =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/iu;
const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:(?:aws|github|gitlab|openai|anthropic|gemini|google|scw|scaleway|azure|db|database)[_-]?)?(?:password|secret|secret[_-]?access[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key|connection[_-]?string|token|bearer)\b["']?\s*(?::|=|\b(?:is|equals?)\b)\s*["']?([^\s"',}]{4,})/iu;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const ENV_CREDENTIAL_ASSIGNMENT =
  /["']?\b[A-Z][A-Z0-9_]{1,63}(?:_TOKEN|_PASSWORD|_SECRET|_SECRET_ACCESS_KEY|_ACCESS_KEY|_API_KEY|_PRIVATE_KEY)\b["']?\s*(?:=|:|\b(?:is|equals?)\b)\s*["']?[^\s"',}]{4,}/iu;
const WINDOWS_ABSOLUTE_PATH =
  /(?:^|[^\p{L}\p{N}])[A-Za-z]:[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]*/u;
const UNC_PATH =
  /\\\\[^\\/\s]+[\\/][^\\/\s]+(?:[\\/][^\\/\s]+)*/u;
const FORWARD_UNC_PATH =
  /(?:^|[^\p{L}\p{N}:])\/\/[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*/u;
const POSIX_ABSOLUTE_PATH =
  /(?:^|[^\p{L}\p{N}:+.\/-])\/(?!\/)(?:[^/\s]+\/)*[^/\s]+/u;
const BIDI_OR_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:^|[^\p{L}\p{N}])(?!\d{4}-\d{2}-\d{2}(?:$|[^\p{L}\p{N}]))\+?\d(?:[ ./()-]*\d){7,}(?=$|[^\p{L}\p{N}])/u;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
const ACTIVE_INSTRUCTION =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instruction|prompt|policy|rule)s?\b|<\|(?:system|assistant|user|im_end)\|>|```|(?:^|\n)\s*(?:system|assistant|developer|user)\s*:|\b(?:when|once)\b.{0,60}\b(?:resum(?:e|ed)|loaded|opened)\b.{0,60}\b(?:run|execute|deploy|publish|merge|delete|send)\b|\b(?:run|execute|deploy|publish|merge|delete|send)\b.{0,40}\bautomatically\b/iu;
const ROLE_MARKER = /(?:^|[^\p{L}\p{N}])(?:system|assistant|developer|user)\s*:/iu;

export function safeDisplayText(value, maxChars) {
  if (typeof value !== "string") {
    return Object.freeze({ text: "", redacted: false, truncated: false });
  }
  const policyValue = value.normalize("NFKC");
  if (
    BIDI_OR_CONTROL.test(value) ||
    ACTIVE_INSTRUCTION.test(policyValue) ||
    ROLE_MARKER.test(policyValue)
  ) {
    return Object.freeze({
      text: "[content redacted]",
      redacted: true,
      truncated: false,
    });
  }
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedPolicyValue = normalized.normalize("NFKC");
  if (
    CREDENTIAL_PATTERN.test(normalizedPolicyValue) ||
    CREDENTIAL_ASSIGNMENT.test(normalizedPolicyValue) ||
    CREDENTIAL_URL.test(normalizedPolicyValue) ||
    ENV_CREDENTIAL_ASSIGNMENT.test(normalizedPolicyValue) ||
    WINDOWS_ABSOLUTE_PATH.test(normalizedPolicyValue) ||
    UNC_PATH.test(normalizedPolicyValue) ||
    FORWARD_UNC_PATH.test(normalizedPolicyValue) ||
    POSIX_ABSOLUTE_PATH.test(normalizedPolicyValue) ||
    EMAIL.test(normalizedPolicyValue) ||
    PHONE.test(normalizedPolicyValue) ||
    IPV4.test(normalizedPolicyValue) ||
    ACTIVE_INSTRUCTION.test(normalizedPolicyValue) ||
    ROLE_MARKER.test(normalizedPolicyValue)
  ) {
    return Object.freeze({
      text: "[content redacted]",
      redacted: true,
      truncated: false,
    });
  }
  if (normalized.length > maxChars) {
    return Object.freeze({
      text: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`,
      redacted: false,
      truncated: true,
    });
  }
  return Object.freeze({ text: normalized, redacted: false, truncated: false });
}
