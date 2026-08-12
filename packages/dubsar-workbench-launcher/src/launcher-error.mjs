export class WorkbenchLauncherError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkbenchLauncherError";
    this.code = code;
  }
}
