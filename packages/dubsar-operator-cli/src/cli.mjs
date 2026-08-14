import {
  WORKBENCH_AUTHORITY,
  WorkbenchError,
  buildProjectHistory,
  buildProjectLotsView,
  buildProjectPrecedents,
  buildProjectResumeCapsule,
  inspectProjectCatalog,
  inspectWorkspace,
  inspectWorkspaceWithReviews,
  loadProjectRegistry,
  locateWorkspace,
  stableJson,
} from "../../dubsar-operator-core/src/index.mjs";
import {
  renderReviewLedgerReport,
  renderWorkbenchInteractiveReport,
  renderWorkbenchReport,
} from "../../dubsar-workbench-report/src/index.mjs";
import {
  WorkbenchServerError,
  startWorkbenchServer,
} from "../../dubsar-workbench-server/src/index.mjs";
import {
  applyCheckpoint,
  applyLotTransition,
  previewCheckpoint,
  previewLotTransition,
} from "./checkpoint-writer.mjs";
import { runInteractiveClose } from "./close-session.mjs";
import { memoryErrorCode, runInteractiveMemory } from "./memory-session.mjs";
import {
  ownsContinuityInvocation,
  runContinuityCli,
} from "../../dubsar-project-continuity/runtime/cli.mjs";
import {
  inspectWorkspace as inspectContinuityWorkspace,
} from "../../dubsar-project-continuity/runtime/index.mjs";

export const OPERATOR_CLI_IDENTITY = Object.freeze({
  name: "@dubsar/operator-cli",
  version: "0.1.0-dev",
});

const COMMANDS = new Set([
  "capsule",
  "checkpoint",
  "close",
  "catalog",
  "doctor",
  "history",
  "locate",
  "lots",
  "memory",
  "precedents",
  "report",
  "reviews",
  "resume",
  "status",
  "ui",
  "validate",
]);

function parseArguments(argv) {
  const command = argv.at(0);
  if (!COMMANDS.has(command)) {
    throw new WorkbenchError("CLI_COMMAND_INVALID");
  }
  const options = { apply: false, capsule: false, interactive: false, json: false, reviews: false };
  let firstOption = 1;
  if (command === "memory") {
    options.memory_action = argv.at(1);
    if (!new Set(["add", "init"]).has(options.memory_action)) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    firstOption = 2;
  }
  for (let index = firstOption; index < argv.length; index += 1) {
    const token = argv.at(index);
    if (token === "--json") {
      if (options.json) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
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
    if (token === "--reviews") {
      if (options.reviews) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.reviews = true;
      continue;
    }
    if (token === "--interactive") {
      if (options.interactive) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.interactive = true;
      continue;
    }
    if (
      !new Set([
        "--before", "--category", "--domain", "--expected-change", "--lang", "--limit", "--lot",
        "--project", "--proposal", "--ref", "--registry", "--start",
        "--to", "--transition-lot",
      ]).has(token) ||
      index + 1 >= argv.length
    ) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
    const value = argv.at(index + 1);
    if (token === "--domain") {
      if (options.domain !== undefined) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.domain = value;
    } else if (token === "--start") {
      if (options.start !== undefined) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.start = value;
    } else if (token === "--registry") {
      if (options.registry !== undefined) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.registry = value;
    } else if (token === "--project") {
      if (options.project !== undefined) {
        throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      }
      options.project = value;
    } else if (token === "--expected-change") {
      if (options.expected_change !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.expected_change = value;
    } else if (token === "--proposal") {
      if (options.proposal !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.proposal = value;
    } else if (token === "--before") {
      if (options.before !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.before = value;
    } else if (token === "--limit") {
      if (options.limit !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.limit = value;
    } else if (token === "--lang") {
      if (options.lang !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.lang = value;
    } else if (token === "--category") {
      if (options.category !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.category = value;
    } else if (token === "--lot") {
      if (options.lot !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.lot = value;
    } else if (token === "--ref") {
      if (options.reference !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.reference = value;
    } else if (token === "--to") {
      if (options.to !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.to = value;
    } else {
      if (options.transition_lot !== undefined) throw new WorkbenchError("CLI_ARGUMENT_DUPLICATE");
      options.transition_lot = value;
    }
    index += 1;
  }
  if (options.domain !== undefined && !new Set(["audit", "project"]).has(options.domain)) {
    throw new WorkbenchError("DOMAIN_INVALID");
  }
  if (options.reviews && !new Set(["report", "ui"]).has(command)) {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (options.interactive && command !== "report") {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (options.capsule && command !== "resume") {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (command === "checkpoint") {
    const proposalMode = options.proposal !== undefined && options.transition_lot === undefined;
    const transitionMode = options.transition_lot !== undefined && options.proposal === undefined;
    if (
      (!proposalMode && !transitionMode) || options.registry !== undefined ||
      options.project !== undefined || options.domain !== undefined || options.reviews ||
      options.interactive || options.capsule ||
      (transitionMode && !new Set(["candidate", "complete"]).has(options.to)) ||
      (proposalMode && options.to !== undefined) ||
      (options.apply !== (options.expected_change !== undefined))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (
    options.apply || options.expected_change !== undefined || options.proposal !== undefined ||
    options.to !== undefined || options.transition_lot !== undefined
  ) {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  if (new Set(["catalog", "capsule"]).has(command)) {
    if (
      options.registry === undefined ||
      options.start !== undefined ||
      options.domain !== undefined ||
      options.reviews ||
      options.interactive || options.capsule ||
      options.before !== undefined || options.limit !== undefined ||
      options.lot !== undefined || options.reference !== undefined ||
      options.lang !== undefined || options.category !== undefined ||
      (command === "capsule" && options.project === undefined) ||
      (command === "catalog" && options.project !== undefined)
    ) {
      throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    }
  } else if (command === "close") {
    if (
      options.registry !== undefined || options.project !== undefined ||
      options.domain !== undefined || options.reviews || options.interactive || options.capsule ||
      options.before !== undefined || options.limit !== undefined || options.lot !== undefined ||
      options.reference !== undefined ||
      options.category !== undefined ||
      (options.lang !== undefined && !new Set(["en", "fr"]).has(options.lang))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (command === "memory") {
    if (
      options.start !== undefined || options.registry !== undefined || options.project !== undefined ||
      options.domain !== undefined || options.reviews || options.interactive || options.capsule ||
      options.before !== undefined || options.limit !== undefined || options.lot !== undefined ||
      options.reference !== undefined || options.lang !== undefined ||
      (options.memory_action === "init" && options.category !== undefined) ||
      (options.memory_action === "add" && !new Set([
        "decisions", "learnings", "blockers", "evals",
      ]).has(options.category))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  } else if (new Set(["history", "lots", "precedents"]).has(command)) {
    if (
      options.registry !== undefined || options.project !== undefined ||
      options.domain !== undefined || options.reviews || options.interactive || options.capsule ||
      options.lang !== undefined || options.category !== undefined ||
      (command !== "history" && (options.before !== undefined || options.limit !== undefined)) ||
      (command !== "precedents" && (options.lot !== undefined || options.reference !== undefined)) ||
      (command === "precedents" && ((options.lot === undefined) === (options.reference === undefined)))
    ) throw new WorkbenchError("CLI_ARGUMENT_INVALID");
    if (options.before !== undefined) {
      options.before = Number(options.before);
      if (!Number.isSafeInteger(options.before) || options.before < 0) {
        throw new WorkbenchError("CLI_ARGUMENT_INVALID");
      }
    }
    if (options.limit !== undefined) {
      options.limit = Number(options.limit);
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 32) {
        throw new WorkbenchError("CLI_ARGUMENT_INVALID");
      }
    }
  } else if (
    options.registry !== undefined || options.project !== undefined ||
    options.before !== undefined || options.limit !== undefined ||
    options.lot !== undefined || options.reference !== undefined || options.lang !== undefined ||
    options.category !== undefined
  ) {
    throw new WorkbenchError("CLI_ARGUMENT_INVALID");
  }
  return { command, options };
}

function validationEnvelope(inspection) {
  return {
    format: "dubsar.validation/1",
    authority: WORKBENCH_AUTHORITY,
    source: inspection.view.source,
    integrity: inspection.evaluation.integrity,
    readiness: inspection.evaluation.readiness,
    counts: inspection.evaluation.counts,
    next_action: inspection.evaluation.next_action,
  };
}

function humanOutput(command, value) {
  if (command === "checkpoint") {
    return [
      value.status === "applied" ? "DUBSAR checkpoint applied" : "DUBSAR checkpoint preview",
      `Operation: ${value.operation}`,
      `Target: ${value.target}`,
      `Change SHA-256: ${value.change_sha256}`,
      ...(value.summary ? [`Summary: ${value.summary}`] : []),
    ].join("\n");
  }
  if (command === "close") {
    return value.status === "checkpoint_applied"
      ? `DUBSAR close complete\nCheckpoint: ${value.checkpoint.change_sha256}\nCapsule: ${value.capsule.capsule_sha256}`
      : `DUBSAR close complete\nNo project write\nCapsule: ${value.capsule.capsule_sha256}`;
  }
  if (command === "memory") {
    return value.status === "created"
      ? `DUBSAR personal memory created\nContent: ${value.receipt.content_sha256}`
      : `DUBSAR personal memory updated\nEntry: ${value.receipt.entry_id}\nChange: ${value.receipt.change_sha256}`;
  }
  if (command === "catalog") {
    return [
      "DUBSAR project catalog",
      `Projects: ${value.summary.total}`,
      `Available: ${value.summary.available}`,
      `Unavailable: ${value.summary.unavailable}`,
      `Ready: ${value.summary.ready}`,
      `Action required: ${value.summary.action_required}`,
    ].join("\n");
  }
  if (command === "capsule") {
    return [
      "DUBSAR resume capsule",
      `Project: ${value.project.project_id}`,
      `Integrity: ${value.state.integrity}`,
      `Readiness: ${value.state.readiness}`,
      `Next: ${value.next_action.label}`,
      `Capsule SHA-256: ${value.capsule_sha256}`,
    ].join("\n");
  }
  if (command === "locate") {
    return [
      `DUBSAR ${value.domain}`,
      `Marker: ${value.marker}`,
      `Parent distance: ${value.distance}`,
    ].join("\n");
  }
  if (command === "history") {
    return [
      "DUBSAR recorded history",
      `Records: ${value.entries.length}`,
      "Order: recorded index, newest first; this is not a chronology.",
    ].join("\n");
  }
  if (command === "lots") {
    return [
      "DUBSAR work packages",
      `Active: ${value.summary.active}`,
      `Eligible: ${value.summary.eligible}`,
      `Blocked: ${value.summary.blocked}`,
      "Choose an eligible work package; DUBSAR does not choose for you.",
    ].join("\n");
  }
  if (command === "precedents") {
    return [
      "DUBSAR exact precedents",
      `Matches: ${value.results.length}`,
      "Order: most recently recorded first; no relevance ranking.",
    ].join("\n");
  }
  if (command === "doctor") {
    return [
      "DUBSAR doctor",
      `Node: ${value.runtime.node}`,
      `Integrity: ${value.integrity}`,
      `Readiness: ${value.readiness}`,
      `Next: ${value.next_action}`,
    ].join("\n");
  }
  if (command === "reviews") {
    const receiptSet = value.ledger.receipt_set_sha256 ?? "unavailable";
    const count = (name, item) => `${name}: ${item ?? "unavailable"}`;
    const reviewLines = value.reviews.flatMap((review) => [
      `Review: ${review.decision_id}/${review.receipt_id}`,
      `Declared role/isolation: ${review.declared_role}/${review.declared_isolation}`,
      `Input canonical digest match: ${review.input_canonical_digest_match}`,
      ...(review.resulting_canonical_digest_match === null
        ? []
        : [
            `Resulting canonical digest match: ${review.resulting_canonical_digest_match}`,
          ]),
      ...review.findings.map(
        (finding) =>
          `Advisory review finding: ${finding.finding_id} [${finding.severity}] ${finding.summary}`,
      ),
      ...review.alternatives.map((item) => `Alternative: ${item}`),
      ...review.limitations.map((item) => `Limitation: ${item}`),
    ]);
    return [
      "Advisory Review Ledger",
      `Status: ${value.ledger.status}`,
      count("Discovered", value.ledger.discovered_count),
      count("Valid", value.ledger.valid_count),
      count("Omitted", value.ledger.omitted_count),
      `Receipt set SHA-256: ${receiptSet}`,
      `Projection SHA-256: ${value.projection_sha256}`,
      ...value.ledger.diagnostics.map(
        (item) => `Diagnostic: ${item.code} [${item.severity}]`,
      ),
      ...(reviewLines.length === 0
        ? ["No advisory review entry is displayed."]
        : reviewLines),
      "Advisory only: this ledger does not change canonical integrity or readiness.",
    ].join("\n");
  }
  const status = command === "validate" ? value : value;
  return [
    `DUBSAR ${status.source.domain}`,
    `Integrity: ${status.integrity.status}`,
    `Readiness: ${status.readiness.status}`,
    `Next: ${status.next_action.label}`,
    `Snapshot: ${status.source.snapshot_sha256}`,
  ].join("\n");
}

export async function runCli(argv, io = {}) {
  if (ownsContinuityInvocation(argv) && !new Set(["close", "memory"]).has(argv.at(0))) {
    return runContinuityCli(argv, {
      writeOut: io.writeOut,
      writeErr: io.writeErr,
    });
  }
  const writeOut = io.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value) => process.stderr.write(value));
  let session = null;
  try {
    const { command, options } = parseArguments(argv);
    let value;
    let output;
    if (command === "checkpoint") {
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
    } else if (command === "close") {
      if (options.json) throw new WorkbenchError("CLOSE_INTERACTIVE_REQUIRED");
      value = await runInteractiveClose({
        start: options.start,
        lang: options.lang ?? "en",
        producer: OPERATOR_CLI_IDENTITY,
        io: {
          writeOut,
          readLine: io.readLine,
          input: io.input ?? process.stdin,
          output: io.output ?? process.stdout,
          isInputTTY: io.isInputTTY ?? process.stdin.isTTY === true,
          isOutputTTY: io.isOutputTTY ?? process.stdout.isTTY === true,
          today: io.today,
        },
      });
    } else if (command === "memory") {
      if (options.json) throw new WorkbenchError("MEMORY_INTERACTIVE_REQUIRED");
      value = await runInteractiveMemory({
        action: options.memory_action,
        category: options.category,
        io: {
          writeOut,
          readLine: io.readLine,
          input: io.input ?? process.stdin,
          output: io.output ?? process.stdout,
          isInputTTY: io.isInputTTY ?? process.stdin.isTTY === true,
          isOutputTTY: io.isOutputTTY ?? process.stdout.isTTY === true,
          today: io.today,
        },
      });
    } else if (new Set(["catalog", "capsule"]).has(command)) {
      const registry = await loadProjectRegistry(options.registry);
      const entries = command === "catalog"
        ? registry.projects
        : registry.projects.filter((entry) => entry.project_id === options.project);
      if (entries.length === 0) {
        throw new WorkbenchError("CAPSULE_PROJECT_UNAVAILABLE");
      }
      if (command === "catalog") {
        value = await inspectProjectCatalog({
          entries,
          includeReviews: true,
          producer: OPERATOR_CLI_IDENTITY,
        });
      } else {
        // The Dashboard CTA reads through this path, so it observes references
        // and receives a /4 capsule carrying evidence_freshness.
        const inspection = await inspectContinuityWorkspace({
          start: entries[0].root,
          domain: "project",
          observeReferences: true,
        });
        value = buildProjectResumeCapsule({
          inspection,
          producer: OPERATOR_CLI_IDENTITY,
        });
      }
    } else if (command === "locate") {
      const location = await locateWorkspace({
        start: options.start,
        domain: options.domain,
      });
      value = {
        format: "dubsar.location/1",
        authority: WORKBENCH_AUTHORITY,
        domain: location.domain,
        marker: location.marker,
        distance: location.distance,
      };
    } else if (new Set(["history", "lots", "precedents"]).has(command)) {
      const inspection = await inspectWorkspace({
        start: options.start,
        domain: "project",
        producer: OPERATOR_CLI_IDENTITY,
      });
      value = command === "history"
        ? buildProjectHistory({
            inspection,
            ...(options.before === undefined ? {} : { before: options.before }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          })
        : command === "lots"
          ? buildProjectLotsView({ inspection })
          : buildProjectPrecedents({
              inspection,
              ...(options.lot === undefined ? {} : { lotId: options.lot }),
              ...(options.reference === undefined ? {} : { referencePath: options.reference }),
            });
    } else {
      const includeReviews = command === "reviews" || options.reviews;
      const inspection = await (includeReviews
        ? inspectWorkspaceWithReviews({
            start: options.start,
            domain: options.domain,
            producer: OPERATOR_CLI_IDENTITY,
          })
        : inspectWorkspace({
            start: options.start,
            domain: options.domain,
            producer: OPERATOR_CLI_IDENTITY,
          }));
      if (command === "validate") {
        value = validationEnvelope(inspection);
      } else if (command === "reviews") {
        value = inspection.review_ledger;
      } else if (command === "ui") {
        const report = options.reviews
          ? renderReviewLedgerReport(
              inspection.view,
              inspection.review_ledger,
            )
          : renderWorkbenchReport(inspection.view);
        session = await startWorkbenchServer(Buffer.from(report.html, "utf8"));
        value = options.reviews
          ? {
              format: "dubsar.review-ledger-ui-session/1",
              status: "ready",
              authority: WORKBENCH_AUTHORITY,
              url: session.url,
              snapshot_sha256: inspection.view.source.snapshot_sha256,
              canonical_root_sha256:
                inspection.review_ledger.source.canonical_root_sha256,
              receipt_set_sha256:
                inspection.review_ledger.ledger.receipt_set_sha256,
              review_projection_sha256:
                inspection.review_ledger.projection_sha256,
              review_presentation: report.manifest.review_presentation,
            }
          : {
              format: "dubsar.ui-session/1",
              status: "ready",
              authority: WORKBENCH_AUTHORITY,
              url: session.url,
              snapshot_sha256: inspection.view.source.snapshot_sha256,
            };
        output = options.json
          ? `${JSON.stringify(value)}\n`
          : `DUBSAR_WORKBENCH_READY ${session.url}\n`;
      } else if (command === "report") {
        const report = options.interactive
          ? renderWorkbenchInteractiveReport(inspection.view, {
              graph: inspection.graph,
              ...(options.reviews
                ? { reviewLedger: inspection.review_ledger }
                : {}),
            })
          : options.reviews
            ? renderReviewLedgerReport(
                inspection.view,
                inspection.review_ledger,
              )
            : renderWorkbenchReport(inspection.view);
        value = report.manifest;
        output = options.json ? stableJson(report.manifest) : report.html;
      } else if (command === "doctor") {
        value = {
          format: "dubsar.doctor/1",
          authority: WORKBENCH_AUTHORITY,
          runtime: {
            node: process.version,
            supported: Number(process.versions.node.split(".")[0]) >= 20,
          },
          domain: inspection.view.source.domain,
          integrity: inspection.view.integrity.status,
          readiness: inspection.view.readiness.status,
          next_action: inspection.view.next_action.label,
          diagnostics: inspection.view.integrity.diagnostics,
        };
      } else {
        value = command === "resume" && options.capsule
          ? buildProjectResumeCapsule({
              inspection,
              producer: OPERATOR_CLI_IDENTITY,
            })
          : inspection.view;
      }
    }
    writeOut(
      output ??
        (options.json ? stableJson(value) : `${humanOutput(command, value)}\n`),
    );
    return {
      exitCode: 0,
      value,
      ...(session === null ? {} : { session }),
    };
  } catch (error) {
    if (session !== null) {
      await session.close("cli-error");
    }
    const code =
      error instanceof WorkbenchError || error instanceof WorkbenchServerError
        ? error.code
        : memoryErrorCode(error) ?? "UNEXPECTED_FAILURE";
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
