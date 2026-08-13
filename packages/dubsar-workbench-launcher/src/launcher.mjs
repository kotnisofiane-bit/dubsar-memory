import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { captureRegularFile } from "../../dubsar-operator-core/src/safe-capture.mjs";
import {
  assertNoSymbolicComponents,
  entryInfo,
  openDirectory,
} from "../../dubsar-operator-core/src/path-safety.mjs";
import {
  createProjectRegistry,
  inspectProjectCatalog,
  inspectProjectContinuityCatalog,
  inspectWorkspace,
  inspectWorkspaceWithReviews,
} from "../../dubsar-operator-core/src/index.mjs";
import { locateProjectWorkspace } from "../../dubsar-project-continuity/runtime/index.mjs";
import {
  WORKBENCH_CONTINUITY_INTERACTIVE_REPORT_FORMAT,
  renderWorkbenchContinuityInteractiveReport,
  renderWorkbenchInteractiveReport,
} from "../../dubsar-workbench-report/src/index.mjs";
import {
  startLiveInteractiveWorkbenchServer,
  startOneShotInteractiveWorkbenchServer,
} from "../../dubsar-workbench-server/src/index.mjs";
import { capturePersonalMemory } from "./personal-memory.mjs";
import { selectProjectFolder } from "./folder-picker.mjs";
import { WorkbenchLauncherError } from "./launcher-error.mjs";
import {
  addLocalProject,
  loadLocalProjectRegistry,
  removeLocalProject,
} from "./registry-store.mjs";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const OUTPUT_NAME = "DUBSAR-Workbench.html";
const TRANSPORTS = new Set(["file", "loopback"]);
const DIRECT_PROJECT_ID = "direct-project";

export const WORKBENCH_LAUNCH_FORMAT = "dubsar.workbench-launch/1";
export const WORKBENCH_CATALOG_LAUNCH_FORMAT = "dubsar.workbench-catalog-launch/1";
export const WORKBENCH_LAUNCH_CHECK_FORMAT = "dubsar.workbench-launch-check/1";
export const WORKBENCH_LAUNCH_ERROR_FORMAT = "dubsar.workbench-launch-error/1";
export const WORKBENCH_PROJECT_MANAGEMENT_FORMAT = "dubsar.workbench-project-management/1";

export const WORKBENCH_LAUNCHER_IDENTITY = Object.freeze({
  name: "@dubsar/workbench-launcher",
  version: "0.1.0-dev",
});

export { WorkbenchLauncherError } from "./launcher-error.mjs";

function supportedAbsolute(input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new WorkbenchLauncherError("LAUNCHER_PATH_INVALID");
  }
  const resolved = path.resolve(input);
  if (
    resolved.startsWith("\\\\") ||
    resolved.startsWith("//") ||
    resolved.startsWith("\\\\?\\") ||
    resolved.startsWith("\\\\.\\")
  ) {
    throw new WorkbenchLauncherError("LAUNCHER_PATH_UNSUPPORTED");
  }
  return resolved;
}

async function resolveOutputRoot(environment, override) {
  const base = override ?? environment.localAppData;
  const resolvedBase = supportedAbsolute(base);
  const candidate = path.join(resolvedBase, "DUBSAR", "Workbench");
  try {
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    return await openDirectory(candidate);
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("LAUNCHER_OUTPUT_DIRECTORY_UNSAFE");
  }
}

async function resolveChrome(environment, override) {
  const candidates = override
    ? [override]
    : [
        environment.programFiles && path.join(environment.programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        environment.programFilesX86 && path.join(environment.programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        environment.localAppData && path.join(environment.localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = supportedAbsolute(candidate);
      await assertNoSymbolicComponents(resolved);
      const info = await entryInfo(resolved);
      if (info?.isFile() && !info.isSymbolicLink() && info.nlink <= 1n) {
        return resolved;
      }
    } catch {
      // Continue through the fixed trusted installation candidates.
    }
  }
  throw new WorkbenchLauncherError("CHROME_NOT_FOUND");
}

async function generateReport(start, includeReviews, memoryRoot) {
  let inspection;
  let memory;
  try {
    inspection = await (includeReviews
      ? inspectWorkspaceWithReviews({
          start,
          domain: "project",
          producer: WORKBENCH_LAUNCHER_IDENTITY,
        })
      : inspectWorkspace({
          start,
          domain: "project",
          producer: WORKBENCH_LAUNCHER_IDENTITY,
        }));
    memory = memoryRoot === undefined
      ? undefined
      : await capturePersonalMemory(supportedAbsolute(memoryRoot));
  } catch {
    throw new WorkbenchLauncherError("REPORT_GENERATION_FAILED");
  }
  let result;
  try {
    result = renderWorkbenchInteractiveReport(inspection.view, {
      graph: inspection.graph,
      ...(includeReviews ? { reviewLedger: inspection.review_ledger } : {}),
      ...(memory === undefined ? {} : { memory }),
    });
  } catch {
    throw new WorkbenchLauncherError("REPORT_GENERATION_FAILED");
  }
  const html = Buffer.from(result.html, "utf8");
  if (
    html.length === 0 ||
    html.length > MAX_HTML_BYTES ||
    !html.subarray(0, 16).toString("utf8").startsWith("<!doctype html>") ||
    result.manifest?.format !== "dubsar.workbench-interactive-report/2"
  ) {
    throw new WorkbenchLauncherError("REPORT_OUTPUT_INVALID");
  }
  return { html, manifest: result.manifest };
}

function renderCatalogSnapshot(catalog, live = false) {
  let result;
  try {
    result = renderWorkbenchContinuityInteractiveReport(catalog, {
      live,
      maxBytes: MAX_HTML_BYTES,
    });
  } catch (error) {
    if (error?.code === "REPORT_SIZE_LIMIT_EXCEEDED") {
      throw new WorkbenchLauncherError("CATALOG_REPORT_TOO_LARGE");
    }
    throw new WorkbenchLauncherError("CATALOG_GENERATION_FAILED");
  }
  const html = Buffer.from(result.html, "utf8");
  if (
    html.length === 0 ||
    html.length > MAX_HTML_BYTES ||
    !html.subarray(0, 16).toString("utf8").startsWith("<!doctype html>") ||
    result.manifest?.format !== WORKBENCH_CONTINUITY_INTERACTIVE_REPORT_FORMAT
  ) {
    throw new WorkbenchLauncherError("REPORT_OUTPUT_INVALID");
  }
  return { html, manifest: result.manifest, catalog };
}

async function generateCatalogReport(registry, includeReviews) {
  let catalog;
  try {
    catalog = await inspectProjectContinuityCatalog({
      entries: registry.projects,
      includeReviews,
      limits: { maxParents: 1 },
      producer: WORKBENCH_LAUNCHER_IDENTITY,
    });
  } catch {
    throw new WorkbenchLauncherError("CATALOG_GENERATION_FAILED");
  }
  return renderCatalogSnapshot(catalog);
}

async function publishReport(outputRoot, report) {
  const target = path.join(outputRoot, OUTPUT_NAME);
  const temporaryName = `.dubsar-workbench-${randomBytes(12).toString("hex")}.tmp`;
  const temporary = path.join(outputRoot, temporaryName);
  let handle;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(report.html);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const captured = await captureRegularFile(outputRoot, temporaryName, MAX_HTML_BYTES);
    if (captured.sha256 !== report.manifest.sha256) {
      throw new WorkbenchLauncherError("REPORT_STAGING_MISMATCH");
    }
    const current = await entryInfo(target);
    if (current !== null) {
      await assertNoSymbolicComponents(target);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink > 1n) {
        throw new WorkbenchLauncherError("REPORT_TARGET_UNSAFE");
      }
    }
    await rename(temporary, target);
    published = true;
    const finalCapture = await captureRegularFile(outputRoot, OUTPUT_NAME, MAX_HTML_BYTES);
    if (finalCapture.sha256 !== report.manifest.sha256) {
      throw new WorkbenchLauncherError("REPORT_PUBLICATION_MISMATCH");
    }
    return target;
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("REPORT_PUBLICATION_FAILED");
  } finally {
    await handle?.close();
    if (!published) {
      await unlink(temporary).catch(() => {});
    }
  }
}

async function openChrome(chrome, target, spawnProcess, isolated = false) {
  const args = isolated
    ? [
        "--guest",
        "--no-default-browser-check",
        "--no-first-run",
        `--app=${target}`,
      ]
    : [target];
  await new Promise((resolve, reject) => {
    const child = spawnProcess(chrome, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new WorkbenchLauncherError("CHROME_LAUNCH_FAILED")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function interactiveServerPayload(report) {
  const { manifest } = report;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.sha256 !== "string" ||
    typeof manifest.script_sha256 !== "string" ||
    typeof manifest.style_sha256 !== "string"
  ) {
    throw new WorkbenchLauncherError("REPORT_OUTPUT_INVALID");
  }
  return Object.freeze({
    html: report.html,
    htmlSha256: manifest.sha256,
    scriptSha256: manifest.script_sha256,
    styleSha256: manifest.style_sha256,
  });
}

function liveInteractiveServerPayload(report) {
  const base = interactiveServerPayload(report);
  if (typeof report.manifest?.data_sha256 !== "string") {
    throw new WorkbenchLauncherError("REPORT_OUTPUT_INVALID");
  }
  return Object.freeze({
    ...base,
    dataSha256: report.manifest.data_sha256,
  });
}

async function serveReportOnce(chrome, report, runtime, isolated = true) {
  let session;
  try {
    session = await runtime.startOneShotServer(interactiveServerPayload(report));
    await openChrome(chrome, session.url, runtime.spawnProcess, isolated);
    const closed = await session.closed;
    if (closed.reason !== "served-once") {
      throw new WorkbenchLauncherError("CHROME_DELIVERY_FAILED");
    }
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("CHROME_DELIVERY_FAILED");
  } finally {
    await session?.close("launcher-finalize");
  }
}

async function refreshCatalogProject(registry, includeReviews, projectId) {
  const entry = registry.projects.find((project) => project.project_id === projectId);
  if (!entry) throw new WorkbenchLauncherError("PROJECT_NOT_FOUND");
  let catalog;
  try {
    catalog = await inspectProjectContinuityCatalog({
      entries: [entry],
      includeReviews,
      limits: { maxParents: 1 },
      producer: WORKBENCH_LAUNCHER_IDENTITY,
    });
  } catch {
    throw new WorkbenchLauncherError("CATALOG_GENERATION_FAILED");
  }
  return liveInteractiveServerPayload(renderCatalogSnapshot(catalog, true));
}

async function serveReportLive(
  chrome,
  report,
  registry,
  includeReviews,
  runtime,
  isolated = true,
) {
  let session;
  try {
    session = await runtime.startLiveServer(
      liveInteractiveServerPayload(report),
      (projectId) => refreshCatalogProject(registry, includeReviews, projectId),
    );
    await openChrome(chrome, session.url, runtime.spawnProcess, isolated);
    await session.closed;
  } catch (error) {
    if (error instanceof WorkbenchLauncherError) throw error;
    throw new WorkbenchLauncherError("CHROME_DELIVERY_FAILED");
  } finally {
    await session?.close("launcher-finalize");
  }
}

function validatedTransport(value) {
  if (!TRANSPORTS.has(value)) {
    throw new WorkbenchLauncherError("LAUNCHER_TRANSPORT_INVALID");
  }
  return value;
}

async function executeLaunch(options, runtime) {
  const {
    start,
    includeReviews = true,
    checkOnly = false,
    memoryRoot,
    transport: requestedTransport,
  } = options;
  const chrome = await resolveChrome(runtime.environment, runtime.chromePath);
  const startPath = supportedAbsolute(start);
  const location = await locateProjectWorkspace({ start: startPath });
  const transport = validatedTransport(requestedTransport);
  if (checkOnly) {
    return Object.freeze({
      format: WORKBENCH_LAUNCH_CHECK_FORMAT,
      status: "ready",
    });
  }

  let registry;
  let report;
  let sourceSnapshotSha256;
  if (memoryRoot !== undefined) {
    report = await generateReport(startPath, includeReviews, memoryRoot);
    sourceSnapshotSha256 = report.manifest.source_snapshot_sha256;
  } else {
    registry = createProjectRegistry([{
      project_id: DIRECT_PROJECT_ID,
      root: location.project_root,
    }]);
    try {
      report = await generateCatalogReport(registry, includeReviews);
    } catch (error) {
      if (
        error instanceof WorkbenchLauncherError &&
        error.code === "REPORT_OUTPUT_INVALID"
      ) {
        throw error;
      }
      throw new WorkbenchLauncherError("REPORT_GENERATION_FAILED");
    }
    sourceSnapshotSha256 = report.catalog.projects.at(0).snapshot_sha256;
  }

  const safeOutputRoot = await resolveOutputRoot(runtime.environment, runtime.outputRoot);
  const reportPath = await publishReport(safeOutputRoot, report);
  if (transport === "loopback") {
    if (registry === undefined) {
      await serveReportOnce(chrome, report, runtime, false);
    } else {
      const liveReport = renderCatalogSnapshot(report.catalog, true);
      await serveReportLive(
        chrome,
        liveReport,
        registry,
        includeReviews,
        runtime,
        false,
      );
    }
  } else {
    await openChrome(chrome, reportPath, runtime.spawnProcess);
  }
  return Object.freeze({
      format: WORKBENCH_LAUNCH_FORMAT,
      status: "opened",
      report_sha256: report.manifest.sha256,
      source_snapshot_sha256: sourceSnapshotSha256,
  });
}

async function ensureCatalogRegistry(outputRoot, runtime, checkOnly) {
  let registry = await loadLocalProjectRegistry(outputRoot);
  if (registry.projects.length > 0) return registry;
  if (checkOnly) {
    throw new WorkbenchLauncherError("PROJECT_REGISTRY_EMPTY");
  }
  const selected = await runtime.selectFolder({
    systemRoot: runtime.environment.systemRoot,
    spawnProcess: runtime.spawnProcess,
  });
  if (selected === null) {
    throw new WorkbenchLauncherError("PROJECT_SELECTION_CANCELLED");
  }
  registry = await addLocalProject(outputRoot, selected);
  return registry;
}

async function executeCatalogLaunch(options, runtime) {
  if (options.memoryRoot !== undefined) {
    throw new WorkbenchLauncherError("CATALOG_MEMORY_UNSUPPORTED");
  }
  const chrome = await resolveChrome(runtime.environment, runtime.chromePath);
  const safeOutputRoot = await resolveOutputRoot(runtime.environment, runtime.outputRoot);
  const registry = await ensureCatalogRegistry(safeOutputRoot, runtime, options.checkOnly);
  const report = await generateCatalogReport(registry, options.includeReviews);
  if (options.checkOnly) {
    return Object.freeze({
      format: WORKBENCH_LAUNCH_CHECK_FORMAT,
      status: "ready",
      project_count: report.catalog.summary.total,
      available_count: report.catalog.summary.available,
    });
  }
  const reportPath = await publishReport(safeOutputRoot, report);
  const transport = validatedTransport(options.transport);
  if (transport === "loopback") {
    const liveReport = renderCatalogSnapshot(report.catalog, true);
    await serveReportLive(
      chrome,
      liveReport,
      registry,
      options.includeReviews,
      runtime,
    );
  } else {
    await openChrome(chrome, reportPath, runtime.spawnProcess);
  }
  return Object.freeze({
    format: WORKBENCH_CATALOG_LAUNCH_FORMAT,
    status: "opened",
    report_sha256: report.manifest.sha256,
    project_count: report.catalog.summary.total,
    available_count: report.catalog.summary.available,
    transport,
  });
}

export async function launchWorkbench({
  start,
  includeReviews = true,
  checkOnly = false,
  memoryRoot,
  transport = "loopback",
} = {}) {
  const runtime = {
    environment: {
      localAppData: process.env.LOCALAPPDATA,
      programFiles: process.env.ProgramFiles,
      programFilesX86: process.env["ProgramFiles(x86)"],
      systemRoot: process.env.SystemRoot,
    },
    spawnProcess: spawn,
    selectFolder: selectProjectFolder,
    startLiveServer: startLiveInteractiveWorkbenchServer,
    startOneShotServer: startOneShotInteractiveWorkbenchServer,
  };
  return start === undefined
    ? executeCatalogLaunch(
        { includeReviews, checkOnly, memoryRoot, transport },
        runtime,
      )
    : executeLaunch(
        { start, includeReviews, checkOnly, memoryRoot, transport },
        runtime,
      );
}

function safeProjectList(catalog) {
  return Object.freeze(catalog.projects.map((project) => Object.freeze({
    project_id: project.project_id,
    title: project.title,
    capture_status: project.capture_status,
    integrity: project.integrity.status,
    readiness: project.readiness.status,
    next_action: project.next_action.label,
  })));
}

export async function manageWorkbenchProjects({
  action,
  selectedRoot,
  projectId,
} = {}) {
  if (!new Set(["add", "list", "remove", "verify"]).has(action)) {
    throw new WorkbenchLauncherError("PROJECT_MANAGEMENT_ACTION_INVALID");
  }
  const runtime = {
    environment: {
      localAppData: process.env.LOCALAPPDATA,
      systemRoot: process.env.SystemRoot,
    },
    spawnProcess: spawn,
  };
  const outputRoot = await resolveOutputRoot(runtime.environment);
  if (action === "add") {
    const root = selectedRoot ?? await selectProjectFolder({
      systemRoot: runtime.environment.systemRoot,
      spawnProcess: runtime.spawnProcess,
    });
    if (root === null) throw new WorkbenchLauncherError("PROJECT_SELECTION_CANCELLED");
    await addLocalProject(outputRoot, root);
  } else if (action === "remove") {
    await removeLocalProject(outputRoot, projectId);
  }
  const registry = await loadLocalProjectRegistry(outputRoot);
  if (registry.projects.length === 0) {
    return Object.freeze({
      format: WORKBENCH_PROJECT_MANAGEMENT_FORMAT,
      status: "ready",
      projects: Object.freeze([]),
    });
  }
  const catalog = await inspectProjectCatalog({
    entries: registry.projects,
    includeReviews: false,
    producer: WORKBENCH_LAUNCHER_IDENTITY,
  });
  return Object.freeze({
    format: WORKBENCH_PROJECT_MANAGEMENT_FORMAT,
    status: "ready",
    projects: safeProjectList(catalog),
  });
}

// Direct module import for hermetic tests only; intentionally absent from index.mjs.
export async function launchWorkbenchForTest({
  start,
  includeReviews = true,
  checkOnly = false,
  memoryRoot,
  outputRoot,
  chromePath,
  spawnProcess,
  selectFolder = selectProjectFolder,
  systemRoot,
  transport = "file",
  startLiveServer = startLiveInteractiveWorkbenchServer,
  startOneShotServer = startOneShotInteractiveWorkbenchServer,
}) {
  const runtime = {
    environment: { localAppData: outputRoot, systemRoot },
    outputRoot,
    chromePath,
    spawnProcess,
    selectFolder,
    startLiveServer,
    startOneShotServer,
  };
  return start === undefined
    ? executeCatalogLaunch(
        { includeReviews, checkOnly, memoryRoot, transport },
        runtime,
      )
    : executeLaunch(
        { start, includeReviews, checkOnly, memoryRoot, transport },
        runtime,
      );
}
