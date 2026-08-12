import { createInterface } from "node:readline/promises";
import {
  PersonalMemoryError,
  preparePersonalMemoryAppend,
  preparePersonalMemoryInitialization,
  validatePersonalMemoryText,
} from "./personal-memory.mjs";
import { WorkbenchError } from "./contracts.mjs";

export const MEMORY_COMMAND_RESULT_FORMAT = "dubsar.personal-memory-command-result/1";

function readerFor(io) {
  if (typeof io.readLine === "function") {
    return {
      async readLine(prompt) {
        try {
          return await io.readLine(prompt);
        } catch (error) {
          if (error?.code === "ABORT_ERR") throw new WorkbenchError("MEMORY_CANCELLED");
          throw error;
        }
      },
      close() {},
    };
  }
  const terminal = createInterface({ input: io.input, output: io.output, terminal: true });
  let interrupted = false;
  terminal.once("SIGINT", () => {
    interrupted = true;
    terminal.close();
  });
  return {
    async readLine(prompt) {
      try {
        const answer = await terminal.question(prompt);
        if (interrupted) throw new WorkbenchError("MEMORY_CANCELLED");
        return answer;
      } catch (error) {
        if (interrupted || error?.code === "ABORT_ERR") {
          throw new WorkbenchError("MEMORY_CANCELLED");
        }
        throw error;
      }
    },
    close() { terminal.close(); },
  };
}

function today(io) {
  if (typeof io.today === "string") return io.today;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function runInteractiveMemory({ action, category, io }) {
  if (!io.isInputTTY || !io.isOutputTTY) {
    throw new WorkbenchError("MEMORY_INTERACTIVE_REQUIRED");
  }
  const reader = readerFor(io);
  try {
    if (action === "init") {
      const prepared = await preparePersonalMemoryInitialization();
      try {
        io.writeOut("DUBSAR personal memory will create exactly five private advisory Markdown files in %LOCALAPPDATA%\\DUBSAR\\Memory.\n");
        for (const file of prepared.preview.files) io.writeOut(`- ${file}\n`);
        io.writeOut(`Content SHA-256: ${prepared.preview.content_sha256}\n`);
        io.writeOut(`Location binding SHA-256: ${prepared.preview.root_sha256}\n`);
        const confirmation = await reader.readLine("Type CREATE to publish the memory directory: ");
        if (confirmation !== "CREATE") throw new WorkbenchError("MEMORY_CANCELLED");
        const receipt = await prepared.apply(confirmation);
        return {
          format: MEMORY_COMMAND_RESULT_FORMAT,
          status: "created",
          receipt,
        };
      } finally {
        await prepared.cancel();
      }
    }
    if (action !== "add") throw new WorkbenchError("MEMORY_ACTION_INVALID");
    const text = validatePersonalMemoryText(
      await reader.readLine("Personal advisory note: "),
    );
    const prepared = await preparePersonalMemoryAppend({
      category,
      text,
      date: today(io),
    });
    io.writeOut("Exact Markdown preview:\n");
    io.writeOut(`${prepared.preview.markdown}\n`);
    io.writeOut(`Change SHA-256: ${prepared.preview.change_sha256}\n`);
    io.writeOut(`Location binding SHA-256: ${prepared.preview.root_sha256}\n`);
    const confirmation = await reader.readLine("Type APPLY MEMORY to append this one entry: ");
    if (confirmation !== "APPLY MEMORY") throw new WorkbenchError("MEMORY_CANCELLED");
    const receipt = await prepared.apply(prepared.preview.change_sha256);
    return {
      format: MEMORY_COMMAND_RESULT_FORMAT,
      status: "applied",
      receipt,
    };
  } finally {
    reader.close();
  }
}

export function memoryErrorCode(error) {
  return error instanceof PersonalMemoryError ? error.code : null;
}
