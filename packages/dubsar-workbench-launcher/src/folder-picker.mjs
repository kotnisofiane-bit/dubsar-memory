import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoSymbolicComponents,
  entryInfo,
} from "../../dubsar-operator-core/src/path-safety.mjs";
import { WorkbenchLauncherError } from "./launcher-error.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/select-project-folder.ps1", import.meta.url),
);

async function trustedExecutable(systemRoot, scriptPath) {
  if (typeof systemRoot !== "string" || systemRoot.length === 0) {
    throw new WorkbenchLauncherError("POWERSHELL_NOT_FOUND");
  }
  const executable = path.join(
    path.resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  await assertNoSymbolicComponents(executable);
  const info = await entryInfo(executable);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new WorkbenchLauncherError("POWERSHELL_NOT_FOUND");
  }
  await assertNoSymbolicComponents(scriptPath);
  const scriptInfo = await entryInfo(scriptPath);
  if (!scriptInfo?.isFile() || scriptInfo.isSymbolicLink() || scriptInfo.nlink > 1n) {
    throw new WorkbenchLauncherError("FOLDER_PICKER_UNAVAILABLE");
  }
  return executable;
}

export async function selectProjectFolder({
  systemRoot,
  spawnProcess = spawn,
} = {}) {
  return selectProjectFolderWithScript({
    scriptPath: SCRIPT_PATH,
    spawnProcess,
    systemRoot,
  });
}

async function selectProjectFolderWithScript({
  scriptPath,
  spawnProcess,
  systemRoot,
}) {
  const executable = await trustedExecutable(systemRoot, scriptPath);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let output = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new WorkbenchLauncherError("FOLDER_PICKER_TIMEOUT")));
    }, 5 * 60 * 1000);
    child.once("error", () =>
      finish(() => reject(new WorkbenchLauncherError("FOLDER_PICKER_FAILED"))),
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 2048) {
        child.kill();
        finish(() => reject(new WorkbenchLauncherError("FOLDER_PICKER_OUTPUT_INVALID")));
      }
    });
    child.once("close", (code) => {
      finish(() => {
        if (code === 2) return resolve(null);
        if (code !== 0) return reject(new WorkbenchLauncherError("FOLDER_PICKER_FAILED"));
        const selected = output.trim();
        if (selected.length === 0 || selected.includes("\0")) {
          return reject(new WorkbenchLauncherError("FOLDER_PICKER_OUTPUT_INVALID"));
        }
        resolve(selected);
      });
    });
  });
}

// Direct module import for hermetic tests only; intentionally absent from index.mjs.
export function selectProjectFolderForTest(options) {
  return selectProjectFolderWithScript(options);
}
