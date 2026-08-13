import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WorkbenchLauncherError,
  launchWorkbenchForTest,
  manageWorkbenchProjects,
} from "../packages/dubsar-workbench-launcher/src/launcher.mjs";
import {
  addLocalProject,
  loadLocalProjectRegistry,
  publishLocalProjectRegistry,
  removeLocalProject,
} from "../packages/dubsar-workbench-launcher/src/registry-store.mjs";
import { createProjectRegistry } from "../packages/dubsar-operator-core/src/index.mjs";
import { selectProjectFolderForTest } from "../packages/dubsar-workbench-launcher/src/folder-picker.mjs";
import { startLiveInteractiveWorkbenchServer } from "../packages/dubsar-workbench-server/src/index.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const PHONE_LIKE_PROJECT_ID = "project-3d49ecd9-0294-4202-90c8-c2529005e143";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-launcher-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "project", ".git"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "examples", "project-continuity"),
    path.join(root, "project", ".dubsar-project"),
    { recursive: true },
  );
  const chrome = path.join(root, "chrome.exe");
  await writeFile(chrome, "synthetic chrome", "utf8");
  return {
    root,
    project: path.join(root, "project"),
    outputBase: path.join(root, "output"),
    chrome,
  };
}

async function memoryFixture(root) {
  const memory = path.join(root, "memory");
  await mkdir(memory);
  const files = ["decisions", "learnings", "blockers", "journal", "evals"];
  for (const name of files) {
    await writeFile(
      path.join(memory, `${name}.md`),
      `# ${name}\n\n## 2026-08-10 - ${name} recent\n\nApercu ${name} relie a [[decisions]].\n`,
      "utf8",
    );
  }
  return memory;
}

function spawnRecorder(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

function loopbackChromeRecorder(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      const target = args.at(-1).startsWith("--app=")
        ? args.at(-1).slice("--app=".length)
        : args.at(-1);
      const call = request(target, {
        headers: {
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
        },
      }, (response) => response.resume());
      call.end();
    });
    return child;
  };
}

function cancelledPickerRecorder(calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", 2));
    return child;
  };
}

test("the real Windows PowerShell hardlink is accepted by the folder picker", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows system PowerShell is required.");
    return;
  }
  const calls = [];
  const selected = await selectProjectFolderForTest({
    scriptPath: path.join(repositoryRoot, "packages", "dubsar-workbench-launcher", "scripts", "select-project-folder.ps1"),
    spawnProcess: cancelledPickerRecorder(calls),
    systemRoot: process.env.SystemRoot,
  });
  assert.equal(selected, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  assert.deepEqual(calls[0].args.slice(0, 7), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("a hardlinked local picker script remains rejected", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows hardlink behavior is required.");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "dubsar-picker-script-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "picker.ps1");
  await writeFile(script, "exit 2\n", "utf8");
  await link(script, path.join(root, "picker-alias.ps1"));
  await assert.rejects(
    selectProjectFolderForTest({
      scriptPath: script,
      spawnProcess: cancelledPickerRecorder([]),
      systemRoot: process.env.SystemRoot,
    }),
    (error) =>
      error instanceof WorkbenchLauncherError &&
      error.code === "FOLDER_PICKER_UNAVAILABLE",
  );
});

test("Windows shortcut bootstrap stays hidden, deterministic, and provides visible failure messages", async () => {
  const bootstrap = await readFile(
    path.join(repositoryRoot, "packages", "dubsar-workbench-launcher", "scripts", "open-workbench.ps1"),
    "utf8",
  );
  const installer = await readFile(
    path.join(repositoryRoot, "packages", "dubsar-workbench-launcher", "scripts", "install-shortcut.ps1"),
    "utf8",
  );
  const installerCmd = await readFile(
    path.join(repositoryRoot, "Installer-DUBSAR-Workbench.cmd"),
    "utf8",
  );
  assert.match(bootstrap, /packages\\dubsar-workbench-launcher\\bin\\dubsar-workbench-open\.mjs/u);
  assert.match(bootstrap, /& \$nodePath \$entryPath --reviews/u);
  assert.match(bootstrap, /System\.Windows\.MessageBox/u);
  assert.match(bootstrap, /NODE_VERSION_UNSUPPORTED/u);
  assert.match(bootstrap, /CHROME_NOT_FOUND/u);
  assert.equal(bootstrap.includes("Start-Process"), false);
  assert.match(installer, /-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File/u);
  assert.match(installer, /DUBSAR Workbench\.lnk/u);
  assert.match(installer, /\.WorkingDirectory = \$workbenchRoot/u);
  assert.match(installer, /Test-Path -LiteralPath \$shortcutPath -PathType Leaf/u);
  assert.match(installerCmd, /packages\\dubsar-workbench-launcher\\scripts\\install-shortcut\.ps1/u);
});

test("direct file fallback renders the Continuity Dashboard and opens Chrome without a shell", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const result = await launchWorkbenchForTest({
    start: item.project,
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
  });
  const reportPath = path.join(
    item.outputBase,
    "DUBSAR",
    "Workbench",
    "DUBSAR-Workbench.html",
  );
  const html = await readFile(reportPath, "utf8");
  assert.equal(result.status, "opened");
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /dubsar\.workbench-graph\/1/u);
  assert.match(html, /dubsar\.workbench-continuity-interactive-data\/3/u);
  assert.match(html, /dubsar\.resume-capsule\/2/u);
  assert.equal(html.includes(item.project), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, item.chrome);
  assert.deepEqual(calls[0].args, [reportPath]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true);
});

test("direct loopback launch opens the live Dashboard in normal Chrome", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const result = await launchWorkbenchForTest({
    start: item.project,
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: loopbackChromeRecorder(calls),
    startLiveServer: async (payload, refreshProject) => {
      const session = await startLiveInteractiveWorkbenchServer(payload, refreshProject);
      setTimeout(() => { void session.close("test-window-closed"); }, 1_000);
      return session;
    },
    transport: "loopback",
  });
  assert.equal(result.format, "dubsar.workbench-launch/1");
  assert.equal(result.status, "opened");
  assert.match(result.source_snapshot_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.length, 1);
  assert.match(
    calls[0].args.at(0),
    /^http:\/\/127\.0\.0\.1:\d+\/w\/[A-Za-z0-9_-]{43}\/$/u,
  );
  assert.equal(calls[0].args.includes("--guest"), false);
  assert.equal(calls[0].args.some((argument) => argument.startsWith("--app=")), false);
  assert.equal(calls[0].options.shell, false);
});

test("direct launch contains an invalid project in a recovery Dashboard", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const options = {
    start: item.project,
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
  };
  await launchWorkbenchForTest(options);
  const reportPath = path.join(
    item.outputBase,
    "DUBSAR",
    "Workbench",
    "DUBSAR-Workbench.html",
  );
  await writeFile(
    path.join(item.project, ".dubsar-project", "mission.json"),
    "{invalid",
    "utf8",
  );
  const result = await launchWorkbenchForTest(options);
  const html = await readFile(reportPath, "utf8");
  assert.equal(result.status, "opened");
  assert.match(html, /Project unavailable/u);
  assert.match(html, /Check the project folder/u);
  assert.equal(html.includes(item.project), false);
  assert.equal(calls.length, 2);
});

test("check mode validates prerequisites without generating or opening", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const result = await launchWorkbenchForTest({
    start: item.project,
    checkOnly: true,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
  });
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(path.join(item.outputBase, "DUBSAR", "Workbench", "DUBSAR-Workbench.html")));
});

test("explicit memory opt-in embeds only bounded previews and a separate digest", async (t) => {
  const item = await fixture(t);
  const memoryRoot = await memoryFixture(item.root);
  const calls = [];
  const result = await launchWorkbenchForTest({
    start: item.project,
    includeReviews: false,
    memoryRoot,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
  });
  const reportPath = path.join(
    item.outputBase,
    "DUBSAR",
    "Workbench",
    "DUBSAR-Workbench.html",
  );
  const html = await readFile(reportPath, "utf8");
  const data = html.match(/<script id="workbench-data" type="application\/json">([\s\S]*?)<\/script>/u)?.at(1);
  assert.equal(typeof data, "string");
  const parsed = JSON.parse(data);
  assert.equal(parsed.memory.status, "included");
  assert.match(parsed.memory.snapshot_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(parsed.memory.categories.length, 5);
  assert.equal(parsed.memory.categories[0].entries[0].title.includes("decisions recent"), true);
  assert.equal(html.includes(memoryRoot), false);
  assert.notEqual(parsed.memory.snapshot_sha256, result.source_snapshot_sha256);
  assert.equal(calls.length, 1);
});

test("catalog first launch remembers the selected project and opens one HTML", async (t) => {
  const item = await fixture(t);
  const calls = [];
  let selections = 0;
  const first = await launchWorkbenchForTest({
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
    selectFolder: async () => {
      selections += 1;
      return item.project;
    },
  });
  const workbenchRoot = path.join(item.outputBase, "DUBSAR", "Workbench");
  const registry = JSON.parse(await readFile(path.join(workbenchRoot, "projects.json"), "utf8"));
  const html = await readFile(path.join(workbenchRoot, "DUBSAR-Workbench.html"), "utf8");
  assert.equal(first.format, "dubsar.workbench-catalog-launch/1");
  assert.equal(first.project_count, 1);
  assert.equal(first.available_count, 1);
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].root, item.project);
  assert.match(html, /<section class="portfolio-strip" aria-labelledby="portfolio-title" hidden>/u);
  assert.match(html, /dubsar\.workbench-continuity-interactive-data\/2/u);
  assert.match(html, /dubsar\.resume-capsule\/2/u);
  assert.match(html, /data-view="memory"/u);
  assert.equal(html.includes(item.project), false);
  assert.equal(selections, 1);
  assert.equal(calls.length, 1);

  await launchWorkbenchForTest({
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
    selectFolder: async () => {
      selections += 1;
      return null;
    },
  });
  assert.equal(selections, 1);
  assert.equal(calls.length, 2);
});

test("catalog launch accepts a persisted project id that resembles a phone number", async (t) => {
  const item = await fixture(t);
  const workbenchRoot = path.join(item.outputBase, "DUBSAR", "Workbench");
  await mkdir(workbenchRoot, { recursive: true });
  await publishLocalProjectRegistry(
    workbenchRoot,
    createProjectRegistry([{ project_id: PHONE_LIKE_PROJECT_ID, root: item.project }]),
  );
  const calls = [];
  const result = await launchWorkbenchForTest({
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: spawnRecorder(calls),
  });
  const html = await readFile(path.join(workbenchRoot, "DUBSAR-Workbench.html"), "utf8");
  assert.equal(result.status, "opened");
  assert.equal(result.project_count, 1);
  assert.equal(html.includes(PHONE_LIKE_PROJECT_ID), true);
  assert.equal(html.includes(item.project), false);
  assert.equal(calls.length, 1);
});

test("catalog loopback launch opens guest Chrome and waits for one delivery", async (t) => {
  const item = await fixture(t);
  const calls = [];
  const result = await launchWorkbenchForTest({
    includeReviews: false,
    outputRoot: item.outputBase,
    chromePath: item.chrome,
    spawnProcess: loopbackChromeRecorder(calls),
    selectFolder: async () => item.project,
    startLiveServer: async (payload, refreshProject) => {
      const session = await startLiveInteractiveWorkbenchServer(payload, refreshProject);
      setTimeout(() => { void session.close("test-window-closed"); }, 1_000);
      return session;
    },
    transport: "loopback",
  });
  assert.equal(result.status, "opened");
  assert.equal(result.transport, "loopback");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), [
    "--guest",
    "--no-default-browser-check",
    "--no-first-run",
  ]);
  assert.match(
    calls[0].args.at(-1),
    /^--app=http:\/\/127\.0\.0\.1:\d+\/w\/[A-Za-z0-9_-]{43}\/$/u,
  );
  assert.equal(calls[0].options.shell, false);
});

test("catalog launch rejects personal memory", async (t) => {
  const item = await fixture(t);
  const memoryRoot = await memoryFixture(item.root);
  await assert.rejects(
    launchWorkbenchForTest({
      includeReviews: false,
      memoryRoot,
      outputRoot: item.outputBase,
      chromePath: item.chrome,
      spawnProcess: spawnRecorder([]),
      selectFolder: async () => item.project,
    }),
    (error) => error instanceof WorkbenchLauncherError && error.code === "CATALOG_MEMORY_UNSUPPORTED",
  );
});

test("local project registry adds and removes explicit roots atomically", async (t) => {
  const item = await fixture(t);
  const outputRoot = path.join(item.outputBase, "registry-only");
  await mkdir(outputRoot, { recursive: true });
  const added = await addLocalProject(outputRoot, item.project);
  assert.equal(added.projects.length, 1);
  assert.equal(added.projects[0].root, item.project);
  const loaded = await loadLocalProjectRegistry(outputRoot);
  assert.equal(loaded.projects[0].project_id, added.projects[0].project_id);
  const removed = await removeLocalProject(outputRoot, added.projects[0].project_id);
  assert.equal(removed.projects.length, 0);
});

test("interactive project management lists a registered project", async (t) => {
  const item = await fixture(t);
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = item.outputBase;
  try {
    const added = await manageWorkbenchProjects({
      action: "add",
      selectedRoot: item.project,
    });
    assert.equal(added.status, "ready");
    assert.equal(added.projects.length, 1);

    const listed = await manageWorkbenchProjects({ action: "list" });
    assert.equal(listed.status, "ready");
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0].capture_status, "available");
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});
