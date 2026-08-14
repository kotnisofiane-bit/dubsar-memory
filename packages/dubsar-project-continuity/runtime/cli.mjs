import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  buildProjectHistory,
  buildProjectLotsView,
  buildProjectPrecedents,
  buildProjectResumeCapsule,
  buildMemoryRoute,
  buildMemoryContext,
  buildMemoryInboxView,
  buildMemoryKnowledgeView,
  buildMemoryWorkView,
  inspectWorkspace,
  renderMemoryContextMarkdown,
  stableJson,
} from "./index.mjs";
import {
  applyCheckpoint,
  applyLotTransition,
  previewCheckpoint,
  previewLotTransition,
} from "./checkpoint-writer.mjs";
import { runInteractiveClose } from "./close-session.mjs";
import {
  applyLiteInitialization,
  previewLiteInitialization,
} from "./lite-initializer.mjs";
import {
  applyMemoryInitialization,
  previewMemoryInitialization,
} from "./memory-vnext-initializer.mjs";
import {
  applyMemoryChange,
  previewMemoryChange,
} from "./memory-vnext-writer.mjs";
import {
  applyMemoryMigration,
  previewMemoryMigration,
} from "./memory-vnext-migration.mjs";

export const PUBLIC_CONTINUITY_COMMANDS = Object.freeze([
  "checkpoint", "close", "context", "history", "inbox", "init", "knowledge", "lots",
  "memory", "migrate", "precedents", "resume", "route", "work",
]);
const COMMANDS = new Set(PUBLIC_CONTINUITY_COMMANDS);
const PRODUCER = Object.freeze({ name: "@dubsar/project-continuity", version: "0.3.0-dev" });
const HELP_TOKENS = new Set(["--help", "-h", "help"]);

const CLI_HELP = `DUBSAR Continuity CLI - ${PRODUCER.name} ${PRODUCER.version}
Local, deterministic project memory. Every write is preview, then apply.

Usage:
  node <plugin-root>/bin/dubsar.mjs <command> [options]

Invoke the runtime through an absolute path owned by the installation.
Never resolve it from PATH, the current directory, or project content.

Read-only commands:
  resume --start <project> --capsule       Bounded, digest-verified resume capsule
  route --start <project>                  Advisory signal; never executed automatically
  history --start <project>                Recorded checkpoints, in append order
  lots --start <project>                   Work items as lots; empty in a Lite workspace
  precedents --start <project> (--lot <id> | --ref <path>)
                                           Exactly one selector; zero matches is normal
  context --start <project>                Generated context; --write persists it (style B)
  work list | knowledge list | knowledge show --knowledge <id> | inbox list

Write style A - you author a proposal file:
  Preview with --proposal <file>, then repeat the same command with
  --apply --expected-change <change_sha256>. Store the file outside the project.
  init             dubsar.memory-init-proposal/1
  work create      dubsar.memory-change-proposal/1, operation work_create
  inbox add        dubsar.memory-change-proposal/1, operation inbox_add
  inbox promote    dubsar.memory-change-proposal/1, operation inbox_promote
  checkpoint       dubsar.memory-change-proposal/1, operation checkpoint_append
                   Lite workspace: dubsar.continuity-checkpoint-proposal/1

Write style B - the CLI builds the proposal from flags:
  These commands take no --proposal and reject it. Preview first, then repeat
  with --apply --expected-change <change_sha256>.
  migrate --to-memory-vnext
  context --write
  work select --work <id|none>
  work status --work <id> --to open|paused|complete
  knowledge retire --knowledge <id>
  checkpoint --transition-lot <id> --to candidate|complete   (legacy workspace only)

Human-only commands - require an interactive TTY:
  close, memory init, memory add --category <decisions|learnings|blockers|evals>
  Never invoke these from a skill, adapter, or hook.

Common options:
  --start <path>               Project root; required by every workspace command
  --json                       Emit one versioned JSON document on stdout
  --apply                      Perform the write; requires --expected-change
  --expected-change <sha256>   Digest from the immediately preceding preview

Structured fields such as summary and next_action are canonical single-line text.
Keep multi-line notes in Markdown bodies.

This help reads no workspace and changes no file.`;

export function ownsContinuityInvocation(argv) {
  const command = argv.at(0);
  return COMMANDS.has(command) && (command !== "resume" || argv.includes("--capsule"));
}

function parseArguments(argv) {
  const command = argv.at(0);
  if (!COMMANDS.has(command)) throw new WorkbenchError("CLI_COMMAND_INVALID");
  const options = { apply: false, capsule: false, json: false };
  let firstOption = 1;
  if (command === "memory") {
    options.memory_action = argv.at(1);
    if (!new Set(["add", "init"]).has(options.memory_action)) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    firstOption = 2;
  }
  if (command === "work") {
    options.work_action = argv.at(1);
    if (!new Set(["create", "list", "select", "status"]).has(options.work_action)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    firstOption = 2;
  }
  if (command === "inbox") {
    options.inbox_action = argv.at(1);
    if (!new Set(["add", "list", "promote"]).has(options.inbox_action)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    firstOption = 2;
  }
  if (command === "knowledge") {
    options.knowledge_action = argv.at(1);
    if (!new Set(["list", "retire", "show"]).has(options.knowledge_action)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    firstOption = 2;
  }
  for (let index = firstOption; index < argv.length; index += 1) {
    const token = argv.at(index);
    if (token === "--json") {
      if (options.json) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.json = true;
      continue;
    }
    if (token === "--capsule") {
      if (options.capsule) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.capsule = true;
      continue;
    }
    if (token === "--apply") {
      if (options.apply) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.apply = true;
      continue;
    }
    if (token === "--write") {
      if (options.context_file) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.context_file = true;
      continue;
    }
    if (token === "--to-memory-vnext") {
      if (options.to_memory_vnext) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.to_memory_vnext = true;
      continue;
    }
    if (!new Set([
      "--before", "--category", "--domain", "--expected-change", "--lang", "--limit", "--lot",
      "--knowledge", "--proposal", "--ref", "--start", "--status", "--to", "--transition-lot", "--work",
    ]).has(token) || index + 1 >= argv.length) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    const value = argv.at(index + 1);
    if (token === "--before") {
      if (options.before !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.before = value;
    } else if (token === "--category") {
      if (options.category !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.category = value;
    } else if (token === "--expected-change") {
      if (options.expected_change !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.expected_change = value;
    } else if (token === "--domain") {
      if (options.domain !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.domain = value;
    } else if (token === "--lang") {
      if (options.lang !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.lang = value;
    } else if (token === "--limit") {
      if (options.limit !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.limit = value;
    } else if (token === "--knowledge") {
      if (options.knowledge !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.knowledge = value;
    } else if (token === "--lot") {
      if (options.lot !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.lot = value;
    } else if (token === "--proposal") {
      if (options.proposal !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.proposal = value;
    } else if (token === "--ref") {
      if (options.reference !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.reference = value;
    } else if (token === "--start") {
      if (options.start !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.start = value;
    } else if (token === "--status") {
      if (options.status !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.status = value;
    } else if (token === "--to") {
      if (options.to !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.to = value;
    } else if (token === "--work") {
      if (options.work !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.work = value;
    } else {
      if (options.transition_lot !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.transition_lot = value;
    }
    index += 1;
  }

  if (command === "resume") {
    if (!options.capsule || options.apply || Object.keys(options).some((key) =>
      !new Set(["apply", "capsule", "domain", "json", "start"]).has(key)) ||
      (options.domain !== undefined && options.domain !== "project")) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (options.capsule) {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (command === "checkpoint") {
    const proposalMode = options.proposal !== undefined && options.transition_lot === undefined;
    const transitionMode = options.transition_lot !== undefined && options.proposal === undefined;
    if (
      (!proposalMode && !transitionMode) ||
      (transitionMode && !new Set(["candidate", "complete"]).has(options.to)) ||
      (proposalMode && options.to !== undefined) ||
      (options.apply !== (options.expected_change !== undefined))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    const allowed = new Set([
      "apply", "capsule", "expected_change", "json", "proposal", "start", "to", "transition_lot",
    ]);
    if (Object.keys(options).some((key) => !allowed.has(key))) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (command === "init") {
    const allowed = new Set(["apply", "capsule", "expected_change", "json", "proposal", "start"]);
    if (
      options.proposal === undefined || options.capsule ||
      options.apply !== (options.expected_change !== undefined) ||
      Object.keys(options).some((key) => !allowed.has(key))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (command === "work") {
    const allowed = new Set([
      "apply", "capsule", "expected_change", "json", "proposal", "start", "status", "to", "work", "work_action",
    ]);
    if (Object.keys(options).some((key) => !allowed.has(key))) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    const writeAction = options.work_action !== "list";
    if (
      options.capsule || options.apply !== (options.expected_change !== undefined) ||
      (options.work_action === "list" && (options.apply || options.proposal !== undefined || options.work !== undefined || options.to !== undefined)) ||
      (options.work_action === "create" && (options.proposal === undefined || options.work !== undefined || options.to !== undefined || options.status !== undefined)) ||
      (options.work_action === "select" && (options.work === undefined || options.proposal !== undefined || options.to !== undefined || options.status !== undefined)) ||
      (options.work_action === "status" && (options.work === undefined || !new Set(["open", "paused", "complete"]).has(options.to) || options.proposal !== undefined || options.status !== undefined)) ||
      (!writeAction && options.expected_change !== undefined)
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (command === "inbox") {
    const allowed = new Set(["apply", "capsule", "expected_change", "inbox_action", "json", "proposal", "start"]);
    if (Object.keys(options).some((key) => !allowed.has(key)) || options.capsule ||
      options.apply !== (options.expected_change !== undefined) ||
      (options.inbox_action === "list" && (options.apply || options.proposal !== undefined)) ||
      (options.inbox_action !== "list" && options.proposal === undefined)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (command === "knowledge") {
    const allowed = new Set([
      "apply", "capsule", "domain", "expected_change", "json", "knowledge", "knowledge_action", "start", "status",
    ]);
    if (Object.keys(options).some((key) => !allowed.has(key)) || options.capsule ||
      options.apply !== (options.expected_change !== undefined) ||
      (options.knowledge_action === "list" && (options.apply || options.knowledge !== undefined)) ||
      (options.knowledge_action === "show" && (options.apply || options.knowledge === undefined || options.domain !== undefined || options.status !== undefined)) ||
      (options.knowledge_action === "retire" && (options.knowledge === undefined || options.domain !== undefined || options.status !== undefined))) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (command === "context") {
    const allowed = new Set(["apply", "capsule", "context_file", "expected_change", "json", "start", "work"]);
    if (Object.keys(options).some((key) => !allowed.has(key)) || options.capsule ||
      (!options.context_file && (options.apply || options.expected_change !== undefined)) ||
      (options.context_file && options.apply !== (options.expected_change !== undefined))) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (command === "migrate") {
    const allowed = new Set(["apply", "capsule", "expected_change", "json", "start", "to_memory_vnext"]);
    if (Object.keys(options).some((key) => !allowed.has(key)) || !options.to_memory_vnext || options.capsule ||
      options.apply !== (options.expected_change !== undefined)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (options.apply || options.expected_change !== undefined || options.proposal !== undefined || options.to !== undefined || options.transition_lot !== undefined) {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (command === "close") {
    if (options.json || Object.keys(options).some((key) =>
      !new Set(["apply", "capsule", "json", "lang", "start"]).has(key)) ||
      (options.lang !== undefined && !new Set(["en", "fr"]).has(options.lang))) {
      throw new WorkbenchError(options.json ? "CLOSE_INTERACTIVE_REQUIRED" : "CLI_ARGUMENT_INVALID");
    }
  }
  if (command === "memory") {
    const allowed = new Set(["apply", "capsule", "category", "json", "memory_action"]);
    if (options.json) throw new WorkbenchError("MEMORY_INTERACTIVE_REQUIRED");
    if (Object.keys(options).some((key) => !allowed.has(key)) ||
      (options.memory_action === "init" && options.category !== undefined) ||
      (options.memory_action === "add" && !new Set(["decisions", "learnings", "blockers", "evals"]).has(options.category))) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  }
  if (new Set(["history", "lots", "precedents", "route"]).has(command)) {
    const allowed = new Set(["apply", "before", "capsule", "json", "limit", "lot", "reference", "start"]);
    if (Object.keys(options).some((key) => !allowed.has(key)) ||
      (command !== "history" && (options.before !== undefined || options.limit !== undefined)) ||
      (command !== "precedents" && (options.lot !== undefined || options.reference !== undefined)) ||
      (command === "precedents" && ((options.lot === undefined) === (options.reference === undefined)))) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    if (options.before !== undefined) {
      options.before = Number(options.before);
      if (!Number.isSafeInteger(options.before) || options.before < 0) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    if (options.limit !== undefined) {
      options.limit = Number(options.limit);
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 32) {
        throw new WorkbenchError("CLI_ARGUMENT_INVALID");
      }
    }
  }
  return { command, options };
}

function humanOutput(command, value) {
  if (command === "init") return [
    value.status === "applied" ? "DUBSAR project memory initialized" : "DUBSAR project-memory initialization preview",
    `Target: ${value.target}`,
    `Change SHA-256: ${value.change_sha256}`,
    ...(value.summary ? [`Summary: ${value.summary}`] : []),
  ].join("\n");
  if (command === "checkpoint") return [
    value.status === "applied" ? "DUBSAR checkpoint applied" : "DUBSAR checkpoint preview",
    `Operation: ${value.operation}`,
    `Target: ${value.target}`,
    `Change SHA-256: ${value.change_sha256}`,
    ...(value.summary ? [`Summary: ${value.summary}`] : []),
  ].join("\n");
  if (command === "close") return value.status === "checkpoint_applied"
    ? `DUBSAR close complete\nCheckpoint: ${value.checkpoint.change_sha256}\nCapsule: ${value.capsule.capsule_sha256}`
    : `DUBSAR close complete\nNo project write\nCapsule: ${value.capsule.capsule_sha256}`;
  if (command === "memory") return value.status === "created"
    ? `DUBSAR personal memory created\nContent: ${value.receipt.content_sha256}`
    : `DUBSAR personal memory updated\nEntry: ${value.receipt.entry_id}\nChange: ${value.receipt.change_sha256}`;
  if (command === "work") {
    if (value.format === "dubsar.memory-work-view/1") {
      return `DUBSAR work\nItems: ${value.items.length}\nSelected: ${value.selected_work_id ?? "none"}\nDUBSAR never selects work automatically.`;
    }
    return `DUBSAR work change ${value.status}\nTarget: ${value.target}\nChange SHA-256: ${value.change_sha256}`;
  }
  if (command === "inbox") {
    if (value.format === "dubsar.memory-inbox-view/1") {
      return `DUBSAR local inbox\nNotes: ${value.items.length}\nInbox content is local advisory data until explicit promotion.`;
    }
    return `DUBSAR inbox change ${value.status}\nTarget: ${value.target}\nChange SHA-256: ${value.change_sha256}`;
  }
  if (command === "knowledge") {
    if (value.format === "dubsar.memory-knowledge-view/1") {
      return `DUBSAR project knowledge\nEntries: ${value.items.length}`;
    }
    return `DUBSAR knowledge change ${value.status}\nTarget: ${value.target}\nChange SHA-256: ${value.change_sha256}`;
  }
  if (command === "context") {
    if (value.format === "dubsar.memory-context/1") return renderMemoryContextMarkdown(value);
    return `DUBSAR generated context ${value.status}\nTarget: ${value.target}\nChange SHA-256: ${value.change_sha256}`;
  }
  if (command === "migrate") return [
    value.status === "applied" ? "DUBSAR memory migration applied" : "DUBSAR memory migration preview",
    `Target: ${value.target}`,
    `Change SHA-256: ${value.change_sha256}`,
    "The retained .dubsar-project workspace is not deleted.",
  ].join("\n");
  if (command === "history") return `DUBSAR recorded history\nRecords: ${value.entries.length}\nOrder: recorded index, newest first; this is not a chronology.`;
  if (command === "lots") return `DUBSAR work packages\nActive: ${value.summary.active}\nEligible: ${value.summary.eligible}\nBlocked: ${value.summary.blocked}\nChoose an eligible work package; DUBSAR does not choose for you.`;
  if (command === "precedents") return `DUBSAR exact precedents\nMatches: ${value.results.length}\nOrder: most recently recorded first; no relevance ranking.`;
  if (command === "route") return [
    "DUBSAR Memory Guidance",
    `Action: ${value.guidance.action}`,
    `Memory state: ${value.memory_state}`,
    `Artifact lifecycle: ${value.artifact_lifecycle.state}`,
    `Exact relations: ${value.exact_relations.matches.length}`,
    `Plan: ${value.native_guidance.plan.recommendation}`,
    `Goal: ${value.native_guidance.goal.recommendation}`,
    "Advisory only; no action was selected or executed.",
  ].join("\n");
  return [
    "DUBSAR project resume capsule",
    `Project: ${value.project.project_id}`,
    `Integrity: ${value.state.integrity}`,
    `Readiness: ${value.state.readiness}`,
    `Next: ${value.next_action.label}`,
    `Capsule SHA-256: ${value.capsule_sha256}`,
  ].join("\n");
}

function memoryChangeProposal(inspection, operation, payload) {
  return {
    format: "dubsar.memory-change-proposal/1",
    project_id: inspection.evaluation.id,
    operation,
    payload,
  };
}

async function memoryChange(options, proposal, expectedOperation) {
  return options.apply
    ? applyMemoryChange({
        start: options.start,
        proposal,
        expectedChange: options.expected_change,
        expectedOperation,
      })
    : previewMemoryChange({ start: options.start, proposal, expectedOperation });
}

export async function runContinuityCli(argv, io = {}) {
  const writeOut = io.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value) => process.stderr.write(value));
  if (argv.length === 0 || HELP_TOKENS.has(argv.at(0)) || argv.includes("--help") || argv.includes("-h")) {
    writeOut(`${CLI_HELP}\n`);
    return { exitCode: 0, value: null };
  }
  try {
    const { command, options } = parseArguments(argv);
    let value;
    if (command === "init") {
      try {
        value = options.apply
          ? await applyMemoryInitialization({ start: options.start, proposalPath: options.proposal, expectedChange: options.expected_change })
          : await previewMemoryInitialization({ start: options.start, proposalPath: options.proposal });
      } catch (error) {
        if (error?.code !== "MEMORY_INIT_PROPOSAL_INVALID") throw error;
        value = options.apply
          ? await applyLiteInitialization({ start: options.start, proposalPath: options.proposal, expectedChange: options.expected_change })
          : await previewLiteInitialization({ start: options.start, proposalPath: options.proposal });
      }
    } else if (command === "checkpoint") {
      const inspection = await inspectWorkspace({ start: options.start, domain: "project" });
      if (inspection.snapshot.workspace_mode === "memory_vnext") {
        if (options.transition_lot !== undefined) throw new WorkbenchError("COMMAND_UNSUPPORTED_FOR_WORKSPACE");
        value = options.apply
          ? await applyMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedChange: options.expected_change,
              expectedOperation: "checkpoint_append",
            })
          : await previewMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedOperation: "checkpoint_append",
            });
      } else {
        const common = { start: options.start };
        if (options.proposal !== undefined) {
          value = options.apply
            ? await applyCheckpoint({ ...common, proposalPath: options.proposal, expectedChange: options.expected_change })
            : await previewCheckpoint({ ...common, proposalPath: options.proposal });
        } else {
          value = options.apply
            ? await applyLotTransition({ ...common, lotId: options.transition_lot, to: options.to, expectedChange: options.expected_change })
            : await previewLotTransition({ ...common, lotId: options.transition_lot, to: options.to });
        }
      }
    } else if (command === "work") {
      const inspection = await inspectWorkspace({ start: options.start, domain: "project" });
      if (inspection.snapshot.workspace_mode !== "memory_vnext") throw new WorkbenchError("COMMAND_UNSUPPORTED_FOR_WORKSPACE");
      if (options.work_action === "list") {
        value = buildMemoryWorkView({ inspection, status: options.status });
      } else if (options.work_action === "create") {
        value = options.apply
          ? await applyMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedChange: options.expected_change,
              expectedOperation: "work_create",
            })
          : await previewMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedOperation: "work_create",
            });
      } else if (options.work_action === "select") {
        value = await memoryChange(options, memoryChangeProposal(inspection, "work_select", {
          work_id: options.work === "none" ? null : options.work,
        }), "work_select");
      } else {
        value = await memoryChange(options, memoryChangeProposal(inspection, "work_status", {
          work_id: options.work,
          status: options.to,
        }), "work_status");
      }
    } else if (command === "inbox") {
      const inspection = await inspectWorkspace({ start: options.start, domain: "project" });
      if (inspection.snapshot.workspace_mode !== "memory_vnext") throw new WorkbenchError("COMMAND_UNSUPPORTED_FOR_WORKSPACE");
      value = options.inbox_action === "list"
        ? await buildMemoryInboxView({ inspection })
        : options.apply
          ? await applyMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedChange: options.expected_change,
              expectedOperation: options.inbox_action === "add" ? "inbox_add" : "inbox_promote",
            })
          : await previewMemoryChange({
              start: options.start,
              proposalPath: options.proposal,
              expectedOperation: options.inbox_action === "add" ? "inbox_add" : "inbox_promote",
            });
    } else if (command === "knowledge") {
      const inspection = await inspectWorkspace({ start: options.start, domain: "project" });
      if (inspection.snapshot.workspace_mode !== "memory_vnext") throw new WorkbenchError("COMMAND_UNSUPPORTED_FOR_WORKSPACE");
      if (options.knowledge_action === "list") {
        value = buildMemoryKnowledgeView({ inspection, domain: options.domain, status: options.status });
      } else if (options.knowledge_action === "show") {
        value = buildMemoryKnowledgeView({ inspection, knowledgeId: options.knowledge });
      } else {
        value = await memoryChange(options, memoryChangeProposal(inspection, "knowledge_retire", {
          knowledge_id: options.knowledge,
        }), "knowledge_retire");
      }
    } else if (command === "context") {
      const inspection = await inspectWorkspace({ start: options.start, domain: "project" });
      const context = buildMemoryContext({ inspection, workId: options.work });
      if (!options.context_file) {
        value = context;
      } else {
        value = await memoryChange(options, memoryChangeProposal(inspection, "context_write", {
          source_snapshot_sha256: inspection.snapshot.snapshot_sha256,
          content: renderMemoryContextMarkdown(context),
        }), "context_write");
      }
    } else if (command === "migrate") {
      value = options.apply
        ? await applyMemoryMigration({ start: options.start, expectedChange: options.expected_change })
        : await previewMemoryMigration({ start: options.start });
    } else if (command === "close") {
      value = await runInteractiveClose({
        start: options.start,
        lang: options.lang ?? "en",
        producer: PRODUCER,
        io: {
          writeOut,
          input: process.stdin,
          output: process.stdout,
          isInputTTY: process.stdin.isTTY === true,
          isOutputTTY: process.stdout.isTTY === true,
        },
      });
    } else if (command === "memory") {
      const { runInteractiveMemory } = await import("./memory-session.mjs");
      value = await runInteractiveMemory({
        action: options.memory_action,
        category: options.category,
        io: {
          writeOut,
          input: process.stdin,
          output: process.stdout,
          isInputTTY: process.stdin.isTTY === true,
          isOutputTTY: process.stdout.isTTY === true,
        },
      });
    } else {
      // Reference freshness is observed only where it is displayed. route,
      // lots, and context stay pure reads of the recorded workspace.
      const inspection = await inspectWorkspace({
        start: options.start,
        domain: "project",
        observeReferences: new Set(["history", "precedents", "resume"]).has(command),
      });
      value = command === "history"
        ? buildProjectHistory({
            inspection,
            ...(options.before === undefined ? {} : { before: options.before }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          })
        : command === "lots"
          ? buildProjectLotsView({ inspection })
          : command === "precedents"
            ? buildProjectPrecedents({
                inspection,
                ...(options.lot === undefined ? {} : { lotId: options.lot }),
                ...(options.reference === undefined ? {} : { referencePath: options.reference }),
              })
            : command === "route"
              ? buildMemoryRoute({ inspection })
              : buildProjectResumeCapsule({ inspection, producer: PRODUCER });
    }
    writeOut(options.json ? stableJson(value) : `${humanOutput(command, value)}\n`);
    return { exitCode: 0, value };
  } catch (error) {
    const code = error instanceof WorkbenchError
      ? error.code
      : typeof error?.code === "string" ? error.code : "UNEXPECTED_FAILURE";
    const value = {
      format: "dubsar.cli-error/1",
      authority: WORKBENCH_AUTHORITY,
      status: "error",
      code,
    };
    writeErr(stableJson(value));
    const exitCode = new Set(["CLOSE_CANCELLED", "MEMORY_CANCELLED"]).has(code)
      ? 130
      : new Set(["CLOSE_INTERACTIVE_REQUIRED", "MEMORY_INTERACTIVE_REQUIRED"]).has(code)
        ? 2
        : 1;
    return { exitCode, value };
  }
}
