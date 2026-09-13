import {
  TicketError,
  applyTicketChange,
  currentCursorReceipt,
  previewTicketChange,
  readTicketAllocations,
  readTickets,
  TERMINAL_TICKET_STATES,
} from "../../dubsar-workbench-launcher/src/registry-store.mjs";
import {
  CONTRACT_FINGERPRINT,
  MyWorkMcpError,
  buildControllerEnvelope,
  requireSelectedProject,
  stableJson,
} from "./canonical.mjs";
import {
  boundsMatch,
  CONTROLLER_RUN_TOOL,
  CONTROLLER_TOOL,
  contractAllowsUncappedContinuation,
  controllerRunToolCall,
  controllerToolCall,
  refsMatch,
  requireNewCorrectionBudget,
  requirePositiveCorrectionNumber,
} from "./mission-args.mjs";
import {
  callCreateDubsarWorkCursorAgent,
  callCreateDubsarWorkCursorAgentRun,
  controllerLaunchConfigured,
} from "./controller-client.mjs";
import { readCredentials } from "./oauth-store.mjs";
import {
  buildCodexEnvelope,
  CODEX_LAUNCH_RECEIPT_VERSION,
  CODEX_RUN_RECEIPT_VERSION,
  CODEX_STOP_RECEIPT_VERSION,
  localCodexReceiptShape,
} from "./codex-contract.mjs";
import { resolveCodexExecutor } from "./codex-executor.mjs";
import { readSupervisorRun } from "./codex-supervisor.mjs";
import { confineAuthorizedWorkspace } from "./codex-workspace.mjs";

export const TOOL_NAMES = Object.freeze([
  "list_tickets",
  "get_ticket",
  "prepare_cursor_mission",
  "launch_cursor_mission",
  "continue_cursor_mission",
  "attach_cursor_receipt",
  "sync_cursor_status",
  "launch_codex_mission",
  "continue_codex_mission",
  "stop_codex_mission",
]);

export const HERMES_TOOL_NAMES = Object.freeze([
  "list_tickets",
  "get_ticket",
  "launch_codex_mission",
  "continue_codex_mission",
  "stop_codex_mission",
]);

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_tickets",
    description: "List local DUBSAR My Work tickets without mutation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
      },
    },
  },
  {
    name: "get_ticket",
    description: "Read one local DUBSAR ticket without mutation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id", "ticket_id"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
      },
    },
  },
  {
    name: "prepare_cursor_mission",
    description:
      "Create exactly one DUB ticket and return create_dubsar_work_cursor_agent arguments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "start",
        "allocation_root",
        "project_id",
        "title",
        "objective",
        "criteria",
        "target_repository_url",
        "allowed_paths",
      ],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "array", items: { type: "string" } },
        target_repository_url: { type: "string" },
        starting_sha: { type: "string" },
        repository_refs: { type: "array" },
        allowed_paths: { type: "array", items: { type: "string" } },
        linear_issue: { type: "string" },
        linear_issue_id: { type: "string" },
        work_id: { type: "string" },
        pr_repository_url: { type: "string" },
        mission: { type: "string" },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        expected_evidence: { type: "array", items: { type: "string" } },
        required_capabilities: { type: "array", items: { type: "string" } },
        preferred_plugins: { type: "array", items: { type: "string" } },
        required_plugins: { type: "array", items: { type: "string" } },
        human_gates: { type: "array", items: { type: "string" } },
        correction_budget: { type: "string", const: "uncapped" },
      },
    },
  },
  {
    name: "launch_cursor_mission",
    description:
      "Create exactly one DUB ticket and issue exactly one Controller create_dubsar_work_cursor_agent call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "start",
        "allocation_root",
        "project_id",
        "title",
        "objective",
        "criteria",
        "target_repository_url",
        "allowed_paths",
      ],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "array", items: { type: "string" } },
        target_repository_url: { type: "string" },
        starting_sha: { type: "string" },
        repository_refs: { type: "array" },
        allowed_paths: { type: "array", items: { type: "string" } },
        linear_issue: { type: "string" },
        linear_issue_id: { type: "string" },
        work_id: { type: "string" },
        pr_repository_url: { type: "string" },
        mission: { type: "string" },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        expected_evidence: { type: "array", items: { type: "string" } },
        required_capabilities: { type: "array", items: { type: "string" } },
        preferred_plugins: { type: "array", items: { type: "string" } },
        required_plugins: { type: "array", items: { type: "string" } },
        human_gates: { type: "array", items: { type: "string" } },
        correction_budget: { type: "string", const: "uncapped" },
      },
    },
  },
  {
    name: "continue_cursor_mission",
    description:
      "Continue an existing DUB ticket through exactly one Controller create_dubsar_work_cursor_agent_run call. Reuses the persisted agent, branch, PR, and contract; does not allocate a ticket.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "start",
        "allocation_root",
        "project_id",
        "ticket_id",
        "correction_number",
        "prompt",
      ],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
        correction_number: { type: "integer", minimum: 1 },
        prompt: { type: "string" },
      },
    },
  },
  {
    name: "attach_cursor_receipt",
    description:
      "Attach a Controller receipt to the prepared ticket when ticket_id and contract_fingerprint match.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id", "ticket_id", "receipt"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
        receipt: { type: "object" },
        expected_contract_fingerprint: { type: "string" },
      },
    },
  },
  {
    name: "sync_cursor_status",
    description:
      "Apply existing KOT-119 Cursor/GitHub sync rules to one ticket from supplied observations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id", "ticket_id", "cursor_observation"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
        cursor_observation: { type: "object" },
        github_observation: { type: ["object", "null"] },
      },
    },
  },
  {
    name: "launch_codex_mission",
    description:
      "Validate one local Codex contract, persist one DUB ticket and intention, then start exactly one Codex/Herdr session. Does not allocate a parallel ticket registry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "start",
        "allocation_root",
        "project_id",
        "title",
        "objective",
        "criteria",
        "allowed_paths",
      ],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "array", items: { type: "string" } },
        allowed_paths: { type: "array", items: { type: "string" } },
        mission: { type: "string" },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        expected_evidence: { type: "array", items: { type: "string" } },
        human_gates: { type: "array", items: { type: "string" } },
        correction_budget: { type: "string", const: "uncapped" },
        auto_approve_dialogue: { type: "boolean", const: false },
        auto_recreate_session: { type: "boolean", const: false },
        close_homonym_workspace: { type: "boolean", const: false },
        work_id: { type: "string" },
      },
    },
  },
  {
    name: "continue_codex_mission",
    description:
      "Resume the same ticket through the persisted Codex session id. Never creates a silent new session or closes an existing workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id", "ticket_id", "prompt"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
        prompt: { type: "string" },
        codex_session_id: { type: "string" },
      },
    },
  },
  {
    name: "stop_codex_mission",
    description:
      "Interrupt only the concerned Codex execution. Files and history are kept. The stop result is not mission success.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "allocation_root", "project_id", "ticket_id"],
      properties: {
        start: { type: "string" },
        allocation_root: { type: "string" },
        project_id: { type: "string" },
        ticket_id: { type: "string" },
      },
    },
  },
]);

function wrap(error) {
  if (error instanceof MyWorkMcpError || error instanceof TicketError) return error;
  return new MyWorkMcpError("MY_WORK_OPERATION_FAILED");
}

async function mutate(env, operation) {
  const preview = await previewTicketChange({ ...env, operation });
  return applyTicketChange({ ...env, operation, expectedChange: preview.change_sha256 });
}

function expectedFingerprint(ticket, supplied, contract) {
  const fromTicket = (ticket.references ?? []).find((item) => CONTRACT_FINGERPRINT.test(item));
  const fromContract = contract?.contract_fingerprint;
  if (
    !CONTRACT_FINGERPRINT.test(fromTicket ?? "") ||
    !CONTRACT_FINGERPRINT.test(fromContract ?? "") ||
    fromTicket !== fromContract
  ) {
    throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
  }
  if (supplied != null && supplied !== fromTicket) {
    throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
  }
  return fromTicket;
}

function assertReceiptMatchesContract(ticket, receipt, { expectedCorrectionNumber = null, expectedAgentId = null } = {}) {
  const contract = preparedContractFrom(ticket);
  if (!contract) throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
  const preparedArgs = contract.arguments ?? contract;
  const expectedBounds = contract.receipt_bounds;
  const expected = expectedFingerprint(ticket, null, contract);
  if (receipt.ticket_id !== ticket.id) {
    throw new MyWorkMcpError("MY_WORK_TICKET_MISMATCH");
  }
  if (receipt.contract_fingerprint !== expected) {
    throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
  }
  const receiptVersion = receipt.receipt_version;
  if (
    receiptVersion !== "dubsar.cursor-launch-receipt/1" &&
    receiptVersion !== "dubsar.cursor-run-receipt/1"
  ) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  const hasCorrectionNumber = Object.hasOwn(receipt.bounds ?? {}, "correction_number");
  if (receiptVersion === "dubsar.cursor-launch-receipt/1" && hasCorrectionNumber) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (receiptVersion === "dubsar.cursor-run-receipt/1" && !hasCorrectionNumber) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (expectedCorrectionNumber != null && receipt.bounds?.correction_number !== expectedCorrectionNumber) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (expectedAgentId != null && receipt.agent_id !== expectedAgentId) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (String(receipt.target_repository_url ?? "") !== String(preparedArgs.target_repository_url ?? "")) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (!refsMatch(receipt.repository_refs, preparedArgs.repository_refs)) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  if (!boundsMatch(receipt.bounds, expectedBounds)) {
    throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
  }
  return contract;
}

function launchSubmissionRecorded(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  return activities.some(
    (row) => row?.kind === "launch_submitted" || row?.kind === "cursor_launch_failed",
  );
}

function preparedContractFrom(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    const row = activities[i];
    if (row?.kind === "cursor_contract" && row.evidence && typeof row.evidence === "object") {
      return row.evidence;
    }
  }
  return null;
}

function preparedCodexContractFrom(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  for (let i = activities.length - 1; i >= 0; i -= 1) {
    const row = activities[i];
    if (row?.kind === "codex_contract" && row.evidence && typeof row.evidence === "object") {
      return row.evidence;
    }
  }
  return null;
}

function codexLaunchSubmitted(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  return activities.some(
    (row) => row?.kind === "codex_launch_submitted" || row?.kind === "codex_launch_failed",
  );
}

function codexResumeSubmitted(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  return activities.some((row) => row?.kind === "codex_resume_submitted");
}

function cursorRunHistory(ticket) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  return activities
    .filter((row) => row?.kind === "cursor_run" && row.evidence && typeof row.evidence === "object")
    .map((row) => row.evidence);
}

function continuationSubmittedFor(ticket, correctionNumber) {
  const activities = Array.isArray(ticket?.activity) ? ticket.activity : [];
  return activities.some(
    (row) =>
      row?.kind === "continuation_submitted" &&
      row.evidence?.correction_number === correctionNumber,
  );
}

function lastRecordedCorrectionNumber(ticket) {
  const current = ticket?.cursor_run?.bounds?.correction_number;
  if (Number.isSafeInteger(current) && current >= 1) return current;
  return 0;
}

function publicTicket(ticket) {
  const current = currentCursorReceipt(ticket);
  return {
    id: ticket.id,
    title: ticket.title,
    objective: ticket.objective,
    criteria: ticket.criteria,
    state: ticket.state,
    project_id: ticket.project_id,
    references: ticket.references,
    cursor_launch: ticket.cursor_launch,
    cursor_run: ticket.cursor_run ?? null,
    codex_launch: ticket.codex_launch ?? null,
    codex_run: ticket.codex_run ?? null,
    codex_stop: ticket.codex_stop ?? null,
    prepared_contract: preparedContractFrom(ticket),
    prepared_codex_contract: preparedCodexContractFrom(ticket),
    herdr_id: ticket.codex_launch?.herdr_id ?? null,
    codex_session_id: ticket.codex_launch?.codex_session_id ?? null,
    workspace_root: ticket.codex_launch?.workspace_root ?? preparedCodexContractFrom(ticket)?.arguments?.workspace_root ?? null,
    work_id: ticket.work_id ?? null,
    duplicate_of: ticket.duplicate_of ?? null,
    agent: ticket.agent,
    branch: ticket.branch,
    pr: ticket.pr,
    blocker: ticket.blocker,
    activity: ticket.activity,
    current_run_id: current?.run_id ?? null,
  };
}

export async function executeTool(name, args = {}) {
  try {
    if (!TOOL_NAMES.includes(name)) throw new MyWorkMcpError("MY_WORK_TOOL_UNKNOWN");
    const env = requireSelectedProject(args);
    if (name === "list_tickets") {
      const store = await readTickets({ start: env.start });
      return { format: "dubsar.my-work-tickets/1", tickets: store.tickets.map(publicTicket) };
    }
    if (name === "get_ticket") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      const prepared = preparedContractFrom(ticket);
      const current = currentCursorReceipt(ticket);
      const durable = await readSupervisorRun(env.allocationRoot, ticket.id);
      return {
        format: "dubsar.my-work-ticket/1",
        ticket: publicTicket(ticket),
        prepared_contract: prepared,
        attached_receipt: current,
        attached_launch_receipt: ticket.cursor_launch ?? null,
        attached_run_receipts: cursorRunHistory(ticket),
        prepared_codex_contract: preparedCodexContractFrom(ticket),
        attached_codex_receipt: ticket.codex_run ?? ticket.codex_launch ?? null,
        herdr_id: durable?.herdr_id ?? ticket.codex_launch?.herdr_id ?? null,
        herdr_live: durable?.herdr_live ?? null,
        codex_session_id: durable?.codex_session_id ?? ticket.codex_launch?.codex_session_id ?? null,
        workspace_root: ticket.codex_launch?.workspace_root ?? preparedCodexContractFrom(ticket)?.arguments?.workspace_root ?? null,
      };
    }
    if (name === "prepare_cursor_mission") {
      if (
        typeof args.title !== "string" ||
        typeof args.objective !== "string" ||
        !Array.isArray(args.criteria) ||
        typeof args.target_repository_url !== "string" ||
        !Array.isArray(args.allowed_paths)
      ) {
        throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
      }
      requireNewCorrectionBudget(args.correction_budget);
      const linearIssue = args.linear_issue_id ?? args.linear_issue;
      const envelopeInput = {
        targetRepositoryUrl: args.target_repository_url,
        startingSha: args.starting_sha,
        repositoryRefs: args.repository_refs,
        allowedPaths: args.allowed_paths,
        linearIssue,
        prRepositoryUrl: args.pr_repository_url,
        mission: args.mission,
        acceptanceCriteria: args.acceptance_criteria,
        expectedEvidence: args.expected_evidence,
        requiredCapabilities: args.required_capabilities,
        preferredPlugins: args.preferred_plugins,
        requiredPlugins: args.required_plugins,
        humanGates: args.human_gates,
        title: args.title,
        objective: args.objective,
        criteria: args.criteria,
      };
      buildControllerEnvelope({ ticketId: "DUB-001", ...envelopeInput });
      const existingStore = await readTickets({ start: env.start });
      for (const existing of existingStore.tickets) {
        const candidate = buildControllerEnvelope({ ticketId: existing.id, ...envelopeInput });
        if (!(existing.references ?? []).includes(candidate.contract_fingerprint)) continue;
        let contract = preparedContractFrom(existing);
        if (!contract) {
          await mutate(env, {
            type: "activity",
            id: existing.id,
            kind: "cursor_contract",
            summary: `${CONTROLLER_TOOL} arguments persisted`,
            evidence: { ...candidate },
          });
          contract = candidate;
        }
        return {
          format: "dubsar.my-work-cursor-mission/1",
          ticket_id: existing.id,
          persisted: false,
          contract_fingerprint: contract.contract_fingerprint,
          receipt_bounds: contract.receipt_bounds,
          ...controllerToolCall(contract.arguments),
        };
      }
      const allocations = await readTicketAllocations({ allocationRoot: env.allocationRoot });
      const ticketId = `DUB-${String(allocations.next_number).padStart(3, "0")}`;
      const envelope = buildControllerEnvelope({
        ticketId,
        targetRepositoryUrl: args.target_repository_url,
        startingSha: args.starting_sha,
        repositoryRefs: args.repository_refs,
        allowedPaths: args.allowed_paths,
        linearIssue,
        prRepositoryUrl: args.pr_repository_url,
        mission: args.mission,
        acceptanceCriteria: args.acceptance_criteria,
        expectedEvidence: args.expected_evidence,
        requiredCapabilities: args.required_capabilities,
        preferredPlugins: args.preferred_plugins,
        requiredPlugins: args.required_plugins,
        humanGates: args.human_gates,
        title: args.title,
        objective: args.objective,
        criteria: args.criteria,
      });
      const operation = {
        type: "create",
        title: args.title,
        objective: args.objective,
        criteria: args.criteria,
        work_id: args.work_id ?? null,
        references: [envelope.contract_fingerprint, envelope.arguments.target_repository_url],
      };
      await mutate(env, operation);
      await mutate(env, {
        type: "activity",
        id: ticketId,
        kind: "cursor_contract",
        summary: `${CONTROLLER_TOOL} arguments persisted`,
        evidence: { ...envelope },
      });
      return {
        format: "dubsar.my-work-cursor-mission/1",
        ticket_id: envelope.ticket_id ?? envelope.arguments.ticket_id,
        persisted: true,
        contract_fingerprint: envelope.contract_fingerprint,
        receipt_bounds: envelope.receipt_bounds,
        ...controllerToolCall(envelope.arguments),
      };
    }
    if (name === "launch_cursor_mission") {
      const prepared = await executeTool("prepare_cursor_mission", args);
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === prepared.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      if (ticket.cursor_launch) {
        return {
          format: "dubsar.my-work-cursor-launch/1",
          ticket_id: ticket.id,
          state: ticket.state,
          agent_id: ticket.cursor_launch.agent_id,
          run_id: ticket.cursor_launch.run_id,
          source_url: ticket.cursor_launch.source_url,
          launched: false,
        };
      }
      if (launchSubmissionRecorded(ticket)) {
        throw new MyWorkMcpError("MY_WORK_LAUNCH_NOT_RETRYABLE");
      }
      if (controllerLaunchConfigured() !== true) {
        const credentials = await readCredentials();
        if (!credentials?.access_token || typeof credentials.controller_url !== "string") {
          throw new MyWorkMcpError("MY_WORK_CONTROLLER_NOT_CONNECTED");
        }
      }
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "launch_submitted",
        summary: `single ${CONTROLLER_TOOL} request`,
        evidence: { tool: CONTROLLER_TOOL, ticket_id: ticket.id },
      });
      let receipt;
      try {
        receipt = await callCreateDubsarWorkCursorAgent(prepared.arguments);
        if (
          !receipt ||
          typeof receipt !== "object" ||
          receipt.receipt_version !== "dubsar.cursor-launch-receipt/1" ||
          typeof receipt.agent_id !== "string" ||
          typeof receipt.run_id !== "string" ||
          typeof receipt.ticket_id !== "string" ||
          typeof receipt.contract_fingerprint !== "string" ||
          !receipt.bounds
        ) {
          throw new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
        }
      } catch (error) {
        await mutate(env, {
          type: "fail-cursor-launch",
          id: ticket.id,
          code: error instanceof MyWorkMcpError ? error.code : "MY_WORK_LAUNCH_AMBIGUOUS",
          summary: "Controller launch failed or was ambiguous; no retry",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
      }
      try {
        const attached = await executeTool("attach_cursor_receipt", {
          ...args,
          ticket_id: ticket.id,
          receipt,
          expected_contract_fingerprint: prepared.contract_fingerprint,
        });
        return {
          format: "dubsar.my-work-cursor-launch/1",
          ticket_id: attached.ticket_id,
          state: attached.state,
          agent_id: attached.cursor_launch.agent_id,
          run_id: attached.cursor_launch.run_id,
          source_url: attached.cursor_launch.source_url,
          launched: true,
        };
      } catch (error) {
        await mutate(env, {
          type: "fail-cursor-launch",
          id: ticket.id,
          code: error instanceof MyWorkMcpError || error instanceof TicketError ? error.code : "MY_WORK_LAUNCH_AMBIGUOUS",
          summary: "Controller receipt did not match local ticket bounds; no fabricated receipt",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_LAUNCH_AMBIGUOUS");
      }
    }
    if (name === "continue_cursor_mission") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      const contract = preparedContractFrom(ticket);
      if (!contract) throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
      if (!ticket.cursor_launch) throw new MyWorkMcpError("MY_WORK_LAUNCH_REQUIRED");
      if (TERMINAL_TICKET_STATES.includes(ticket.state)) {
        throw new MyWorkMcpError("MY_WORK_TICKET_TERMINAL");
      }
      if (!contractAllowsUncappedContinuation(contract)) {
        throw new MyWorkMcpError("MY_WORK_CORRECTION_BUDGET_CAPPED");
      }
      const correctionNumber = requirePositiveCorrectionNumber(args.correction_number);
      const lastNumber = lastRecordedCorrectionNumber(ticket);
      if (ticket.cursor_run && lastNumber === correctionNumber) {
        return {
          format: "dubsar.my-work-cursor-continue/1",
          ticket_id: ticket.id,
          state: ticket.state,
          agent_id: ticket.cursor_run.agent_id,
          run_id: ticket.cursor_run.run_id,
          source_url: ticket.cursor_run.source_url,
          correction_number: correctionNumber,
          continued: false,
        };
      }
      if (correctionNumber <= lastNumber) {
        throw new MyWorkMcpError("MY_WORK_CORRECTION_NUMBER_INVALID");
      }
      if (continuationSubmittedFor(ticket, correctionNumber)) {
        throw new MyWorkMcpError("MY_WORK_CONTINUE_NOT_RETRYABLE");
      }
      if (controllerLaunchConfigured() !== true) {
        const credentials = await readCredentials();
        if (!credentials?.access_token || typeof credentials.controller_url !== "string") {
          throw new MyWorkMcpError("MY_WORK_CONTROLLER_NOT_CONNECTED");
        }
      }
      const runCall = controllerRunToolCall(contract.arguments, {
        agentId: ticket.cursor_launch.agent_id,
        correctionNumber,
        prompt: args.prompt,
      });
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "continuation_submitted",
        summary: `single ${CONTROLLER_RUN_TOOL} request`,
        evidence: {
          tool: CONTROLLER_RUN_TOOL,
          ticket_id: ticket.id,
          agent_id: ticket.cursor_launch.agent_id,
          correction_number: correctionNumber,
        },
      });
      let receipt;
      try {
        receipt = await callCreateDubsarWorkCursorAgentRun(runCall.arguments);
        if (
          !receipt ||
          typeof receipt !== "object" ||
          receipt.receipt_version !== "dubsar.cursor-run-receipt/1" ||
          typeof receipt.agent_id !== "string" ||
          typeof receipt.run_id !== "string" ||
          typeof receipt.ticket_id !== "string" ||
          typeof receipt.contract_fingerprint !== "string" ||
          !receipt.bounds ||
          receipt.agent_id !== ticket.cursor_launch.agent_id ||
          receipt.bounds.correction_number !== correctionNumber
        ) {
          throw new MyWorkMcpError("MY_WORK_CONTINUE_AMBIGUOUS");
        }
      } catch (error) {
        await mutate(env, {
          type: "fail-cursor-run",
          id: ticket.id,
          code: error instanceof MyWorkMcpError ? error.code : "MY_WORK_CONTINUE_AMBIGUOUS",
          summary: "Controller continuation failed or was ambiguous; no retry",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CONTINUE_AMBIGUOUS");
      }
      try {
        assertReceiptMatchesContract(ticket, receipt, {
          expectedCorrectionNumber: correctionNumber,
          expectedAgentId: ticket.cursor_launch.agent_id,
        });
        await mutate(env, { type: "attach-cursor-run", id: ticket.id, receipt });
        const after = await readTickets({ start: env.start });
        const updated = after.tickets.find((item) => item.id === ticket.id);
        return {
          format: "dubsar.my-work-cursor-continue/1",
          ticket_id: updated.id,
          state: updated.state,
          agent_id: updated.cursor_run.agent_id,
          run_id: updated.cursor_run.run_id,
          source_url: updated.cursor_run.source_url,
          correction_number: correctionNumber,
          continued: true,
        };
      } catch (error) {
        await mutate(env, {
          type: "fail-cursor-run",
          id: ticket.id,
          code: error instanceof MyWorkMcpError || error instanceof TicketError ? error.code : "MY_WORK_CONTINUE_AMBIGUOUS",
          summary: "Controller run receipt did not match local ticket, agent, fingerprint, or correction_number; no fabricated receipt",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CONTINUE_AMBIGUOUS");
      }
    }
    if (name === "attach_cursor_receipt") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      const receipt = args.receipt;
      if (!receipt || typeof receipt !== "object") throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
      const contract = preparedContractFrom(ticket);
      if (!contract) throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
      expectedFingerprint(ticket, args.expected_contract_fingerprint, contract);
      assertReceiptMatchesContract(ticket, receipt);
      if (ticket.cursor_launch) {
        if (stableJson(ticket.cursor_launch) !== stableJson(receipt)) {
          throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
        }
        return {
          format: "dubsar.my-work-receipt-attach/1",
          ticket_id: ticket.id,
          state: ticket.state,
          idempotent: true,
          cursor_launch: ticket.cursor_launch,
        };
      }
      await mutate(env, { type: "attach-cursor-launch", id: ticket.id, receipt });
      const after = await readTickets({ start: env.start });
      const updated = after.tickets.find((item) => item.id === ticket.id);
      return {
        format: "dubsar.my-work-receipt-attach/1",
        ticket_id: updated.id,
        state: updated.state,
        idempotent: false,
        cursor_launch: updated.cursor_launch,
      };
    }
    if (name === "launch_codex_mission") {
      if (
        typeof args.title !== "string" ||
        typeof args.objective !== "string" ||
        !Array.isArray(args.criteria) ||
        !Array.isArray(args.allowed_paths)
      ) {
        throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
      }
      const workspaceRoot = await confineAuthorizedWorkspace(env.start, env.start);
      const envelopeInput = {
        workspaceRoot,
        allowedPaths: args.allowed_paths,
        mission: args.mission,
        acceptanceCriteria: args.acceptance_criteria,
        expectedEvidence: args.expected_evidence,
        humanGates: args.human_gates,
        title: args.title,
        objective: args.objective,
        criteria: args.criteria,
        autoApproveDialogue: args.auto_approve_dialogue,
        autoRecreateSession: args.auto_recreate_session,
        closeHomonymWorkspace: args.close_homonym_workspace,
        correctionBudget: args.correction_budget,
      };
      buildCodexEnvelope({ ticketId: "DUB-001", ...envelopeInput });
      const existingStore = await readTickets({ start: env.start });
      let ticketId = null;
      let envelope = null;
      for (const existing of existingStore.tickets) {
        const candidate = buildCodexEnvelope({ ticketId: existing.id, ...envelopeInput });
        if (!(existing.references ?? []).includes(candidate.contract_fingerprint)) continue;
        ticketId = existing.id;
        envelope = preparedCodexContractFrom(existing) ?? candidate;
        if (!preparedCodexContractFrom(existing)) {
          await mutate(env, {
            type: "activity",
            id: existing.id,
            kind: "codex_contract",
            summary: "local Codex/Herdr contract persisted",
            evidence: { ...candidate },
          });
          envelope = candidate;
        }
        break;
      }
      if (ticketId == null) {
        const allocations = await readTicketAllocations({ allocationRoot: env.allocationRoot });
        ticketId = `DUB-${String(allocations.next_number).padStart(3, "0")}`;
        envelope = buildCodexEnvelope({ ticketId, ...envelopeInput });
        await mutate(env, {
          type: "create",
          title: args.title,
          objective: args.objective,
          criteria: args.criteria,
          work_id: args.work_id ?? null,
          references: [envelope.contract_fingerprint, "codex-local"],
        });
        await mutate(env, {
          type: "activity",
          id: ticketId,
          kind: "codex_contract",
          summary: "local Codex/Herdr contract persisted",
          evidence: { ...envelope },
        });
      }
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === ticketId);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      if (ticket.cursor_launch) throw new MyWorkMcpError("MY_WORK_BACKEND_CONFLICT");
      if (ticket.codex_launch) {
        return {
          format: "dubsar.my-work-codex-launch/1",
          ticket_id: ticket.id,
          state: ticket.state,
          herdr_id: ticket.codex_launch.herdr_id,
          codex_session_id: ticket.codex_launch.codex_session_id,
          workspace_root: ticket.codex_launch.workspace_root,
          launched: false,
          mission_success: false,
        };
      }
      if (codexLaunchSubmitted(ticket)) {
        throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_NOT_RETRYABLE");
      }
      const executor = resolveCodexExecutor();
      const argv = ["herdr", "pane", "run", "<pane>", "env", "XDG_RUNTIME_DIR", "systemd-run", "--user", "--scope"];
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "codex_trace",
        summary: "trace before Codex/Herdr launch",
        evidence: { argv, workspace_root: workspaceRoot, ticket_id: ticket.id },
      });
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "codex_launch_submitted",
        summary: "single Codex/Herdr exec request",
        evidence: { argv, ticket_id: ticket.id },
      });
      let result;
      try {
        result = await executor.exec({
          ticketId: ticket.id,
          workspaceRoot,
          authorizedWorkspace: workspaceRoot,
          allocationRoot: env.allocationRoot,
          missionId: ticket.id,
          prompt: envelope.arguments.mission,
        });
        if (!result || result.ambiguous === true || typeof result.codex_session_id !== "string" || typeof result.herdr_id !== "string") {
          throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
        }
      } catch (error) {
        await mutate(env, {
          type: "fail-codex-launch",
          id: ticket.id,
          code: error instanceof MyWorkMcpError ? error.code : "MY_WORK_CODEX_LAUNCH_AMBIGUOUS",
          summary: "Codex launch failed or was ambiguous; no retry",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      }
      const receipt = localCodexReceiptShape({
        version: CODEX_LAUNCH_RECEIPT_VERSION,
        ticketId: ticket.id,
        contractFingerprint: envelope.contract_fingerprint,
        workspaceRoot,
        herdrId: result.herdr_id,
        sessionId: result.codex_session_id,
        missionId: ticket.id,
        status: "launched",
      });
      try {
        await mutate(env, { type: "attach-codex-launch", id: ticket.id, receipt });
      } catch (error) {
        await mutate(env, {
          type: "fail-codex-launch",
          id: ticket.id,
          code: error instanceof MyWorkMcpError || error instanceof TicketError ? error.code : "MY_WORK_CODEX_LAUNCH_AMBIGUOUS",
          summary: "Codex receipt did not match local ticket bounds; no fabricated Cursor receipt",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_AMBIGUOUS");
      }
      return {
        format: "dubsar.my-work-codex-launch/1",
        ticket_id: ticket.id,
        state: "In Progress",
        herdr_id: receipt.herdr_id,
        codex_session_id: receipt.codex_session_id,
        workspace_root: receipt.workspace_root,
        launched: true,
        mission_success: false,
      };
    }
    if (name === "continue_codex_mission") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      const contract = preparedCodexContractFrom(ticket);
      if (!contract) throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
      if (!ticket.codex_launch) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_REQUIRED");
      if (TERMINAL_TICKET_STATES.includes(ticket.state)) {
        throw new MyWorkMcpError("MY_WORK_TICKET_TERMINAL");
      }
      if (typeof args.prompt !== "string" || args.prompt.trim() !== args.prompt || args.prompt.length < 1) {
        throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
      }
      const sessionId = ticket.codex_launch.codex_session_id;
      const herdrId = ticket.codex_launch.herdr_id;
      const workspaceRoot = ticket.codex_launch.workspace_root;
      const confined = await confineAuthorizedWorkspace(env.start, workspaceRoot);
      if (args.codex_session_id != null && args.codex_session_id !== sessionId) {
        throw new MyWorkMcpError("MY_WORK_CODEX_SESSION_MISMATCH");
      }
      if (codexResumeSubmitted(ticket) && !ticket.codex_run) {
        throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_NOT_RETRYABLE");
      }
      const executor = resolveCodexExecutor();
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "codex_trace",
        summary: "trace before Codex/Herdr resume",
        evidence: { argv: ["herdr", "pane", "run", "<pane>", "env", "XDG_RUNTIME_DIR", "systemd-run", "--user", "--scope", "codex", "exec", "resume", sessionId, "--json"], ticket_id: ticket.id },
      });
      await mutate(env, {
        type: "activity",
        id: ticket.id,
        kind: "codex_resume_submitted",
        summary: "single Codex exec resume by id",
        evidence: { ticket_id: ticket.id, codex_session_id: sessionId, herdr_id: herdrId },
      });
      let result;
      try {
        result = await executor.resume({
          ticketId: ticket.id,
          workspaceRoot: confined,
          authorizedWorkspace: confined,
          allocationRoot: env.allocationRoot,
          herdrId,
          sessionId,
          prompt: args.prompt,
        });
        if (!result || result.ambiguous === true || result.codex_session_id !== sessionId || result.herdr_id !== herdrId) {
          throw new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
        }
      } catch (error) {
        await mutate(env, {
          type: "fail-codex-run",
          id: ticket.id,
          code: error instanceof MyWorkMcpError ? error.code : "MY_WORK_CODEX_CONTINUE_AMBIGUOUS",
          summary: "Codex resume failed or was ambiguous; no silent new session",
        });
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CODEX_CONTINUE_AMBIGUOUS");
      }
      const receipt = localCodexReceiptShape({
        version: CODEX_RUN_RECEIPT_VERSION,
        ticketId: ticket.id,
        contractFingerprint: contract.contract_fingerprint,
        workspaceRoot,
        herdrId,
        sessionId,
        missionId: ticket.id,
        status: "resumed",
      });
      await mutate(env, { type: "attach-codex-run", id: ticket.id, receipt });
      return {
        format: "dubsar.my-work-codex-continue/1",
        ticket_id: ticket.id,
        state: "In Progress",
        herdr_id: herdrId,
        codex_session_id: sessionId,
        workspace_root: workspaceRoot,
        continued: true,
        mission_success: false,
      };
    }
    if (name === "stop_codex_mission") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      if (!ticket.codex_launch) throw new MyWorkMcpError("MY_WORK_CODEX_LAUNCH_REQUIRED");
      if (TERMINAL_TICKET_STATES.includes(ticket.state)) {
        throw new MyWorkMcpError("MY_WORK_TICKET_TERMINAL");
      }
      if (ticket.codex_stop) {
        return {
          format: "dubsar.my-work-codex-stop/1",
          ticket_id: ticket.id,
          state: ticket.state,
          herdr_id: ticket.codex_launch.herdr_id,
          codex_session_id: ticket.codex_launch.codex_session_id,
          interrupted: false,
          mission_success: false,
        };
      }
      const executor = resolveCodexExecutor();
      let result;
      try {
        result = await executor.stop({
          sessionId: ticket.codex_launch.codex_session_id,
          herdrId: ticket.codex_launch.herdr_id,
          workspaceRoot: ticket.codex_launch.workspace_root,
          authorizedWorkspace: env.start,
          allocationRoot: env.allocationRoot,
          ticketId: ticket.id,
        });
        if (!result || result.ambiguous === true) {
          throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
        }
        if (result.status === "already_finished") {
          return {
            format: "dubsar.my-work-codex-stop/1",
            ticket_id: ticket.id,
            state: ticket.state,
            herdr_id: ticket.codex_launch.herdr_id,
            codex_session_id: ticket.codex_launch.codex_session_id,
            interrupted: false,
            already_finished: true,
            mission_success: false,
          };
        }
        if (result.status !== "interrupted") {
          throw new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
        }
      } catch (error) {
        throw error instanceof MyWorkMcpError ? error : new MyWorkMcpError("MY_WORK_CODEX_STOP_AMBIGUOUS");
      }
      const contract = preparedCodexContractFrom(ticket);
      const receipt = localCodexReceiptShape({
        version: CODEX_STOP_RECEIPT_VERSION,
        ticketId: ticket.id,
        contractFingerprint: contract.contract_fingerprint,
        workspaceRoot: ticket.codex_launch.workspace_root,
        herdrId: ticket.codex_launch.herdr_id,
        sessionId: ticket.codex_launch.codex_session_id,
        missionId: ticket.id,
        status: "interrupted",
      });
      await mutate(env, { type: "record-codex-stop", id: ticket.id, receipt });
      return {
        format: "dubsar.my-work-codex-stop/1",
        ticket_id: ticket.id,
        state: ticket.state,
        herdr_id: ticket.codex_launch.herdr_id,
        codex_session_id: ticket.codex_launch.codex_session_id,
        interrupted: true,
        mission_success: false,
        logging_error: result.logging_error === true,
      };
    }
    if (name !== "sync_cursor_status") throw new MyWorkMcpError("MY_WORK_TOOL_UNKNOWN");
    const store = await readTickets({ start: env.start });
    const ticket = store.tickets.find((item) => item.id === args.ticket_id);
    if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
    try {
      await mutate(env, {
        type: "sync-cursor-status",
        id: ticket.id,
        cursor_observation: args.cursor_observation,
        github_observation: args.github_observation ?? null,
      });
    } catch (error) {
      if (error instanceof TicketError && error.code === "TICKET_SYNC_TERMINAL") {
        return { format: "dubsar.my-work-sync/1", ticket: publicTicket(ticket) };
      }
      throw error;
    }
    const after = await readTickets({ start: env.start });
    const updated = after.tickets.find((item) => item.id === ticket.id);
    return {
      format: "dubsar.my-work-sync/1",
      ticket: publicTicket(updated),
    };
  } catch (error) {
    throw wrap(error);
  }
}
