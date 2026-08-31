import {
  TicketError,
  applyTicketChange,
  previewTicketChange,
  readTicketAllocations,
  readTickets,
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
  CONTROLLER_TOOL,
  controllerToolCall,
  refsMatch,
} from "./mission-args.mjs";

export const TOOL_NAMES = Object.freeze([
  "list_tickets",
  "get_ticket",
  "prepare_cursor_mission",
  "attach_cursor_receipt",
  "sync_cursor_status",
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
        correction_budget: { type: "integer" },
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

function publicTicket(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    objective: ticket.objective,
    criteria: ticket.criteria,
    state: ticket.state,
    project_id: ticket.project_id,
    references: ticket.references,
    cursor_launch: ticket.cursor_launch,
    prepared_contract: preparedContractFrom(ticket),
    work_id: ticket.work_id ?? null,
    duplicate_of: ticket.duplicate_of ?? null,
    agent: ticket.agent,
    branch: ticket.branch,
    pr: ticket.pr,
    blocker: ticket.blocker,
    activity: ticket.activity,
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
      return {
        format: "dubsar.my-work-ticket/1",
        ticket: publicTicket(ticket),
        prepared_contract: prepared,
        attached_receipt: ticket.cursor_launch,
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
      if (args.correction_budget != null && args.correction_budget !== 3) {
        throw new MyWorkMcpError("MY_WORK_MISSION_INCOMPLETE");
      }
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
          envelope: contract,
          ...controllerToolCall(contract),
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
        references: [envelope.contract_fingerprint, envelope.target_repository_url],
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
        ticket_id: envelope.ticket_id,
        envelope,
        ...controllerToolCall(envelope),
      };
    }
    if (name === "attach_cursor_receipt") {
      const store = await readTickets({ start: env.start });
      const ticket = store.tickets.find((item) => item.id === args.ticket_id);
      if (!ticket) throw new MyWorkMcpError("MY_WORK_TICKET_NOT_FOUND");
      const receipt = args.receipt;
      if (!receipt || typeof receipt !== "object") throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
      const contract = preparedContractFrom(ticket);
      const expected = expectedFingerprint(ticket, args.expected_contract_fingerprint, contract);
      if (receipt.ticket_id !== ticket.id) {
        throw new MyWorkMcpError("MY_WORK_TICKET_MISMATCH");
      }
      if (receipt.contract_fingerprint !== expected) {
        throw new MyWorkMcpError("MY_WORK_FINGERPRINT_MISMATCH");
      }
      if (
        contract &&
        String(receipt.target_repository_url ?? "") !== String(contract.target_repository_url ?? "")
      ) {
        throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
      }
      if (contract && !refsMatch(receipt.repository_refs, contract.repository_refs)) {
        throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
      }
      if (contract && !boundsMatch(receipt.bounds, contract.bounds)) {
        throw new MyWorkMcpError("MY_WORK_RECEIPT_MISMATCH");
      }
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
