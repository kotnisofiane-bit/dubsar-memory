const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export function isProjectId(value) {
  return typeof value === "string" && PROJECT_ID.test(value);
}
