const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "authorization",
  "client_secret",
  "code_verifier",
  "code",
]);

const REDACTED = "[redacted]";

export function redactValue(key, value) {
  if (SECRET_KEYS.has(String(key).toLowerCase())) return REDACTED;
  return value;
}

export function redactObject(value) {
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redactObject(entry);
    }
    return next;
  }
  return value;
}

export function assertNoSecretLeak(text) {
  if (typeof text !== "string") return;
  if (/(?:access_token|refresh_token|authorization)\s*[:=]\s*(?!\[redacted\])\S+/iu.test(text)) {
    throw new Error("MY_WORK_SECRET_LEAK");
  }
}
