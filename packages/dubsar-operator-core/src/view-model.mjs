import {
  WORKBENCH_AUTHORITY,
  WORKBENCH_VIEW_FORMAT,
  WorkbenchError,
  comparePortable,
  deepFreeze,
} from "./contracts.mjs";
import { safeDisplayText, safeStructuralText } from "./display-safety.mjs";

function humanizeCode(code) {
  return code
    .toLowerCase()
    .replaceAll(":", " — ")
    .replaceAll("_", " ");
}

function publicId(value, fallback, privacy, limits) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/iu.test(value)
  ) {
    return fallback;
  }
  const structural = safeStructuralText(value, limits.maxViewTextChars);
  if (structural.redacted || structural.truncated || structural.text !== value) {
    addTextPrivacy(privacy, structural);
    return fallback;
  }
  return structural.text;
}

function projectEvidenceFormat(document) {
  return new Set([
    "dubsar.project-evidence/1",
    "dubsar.project-evidence/2",
  ]).has(document?.format)
    ? document.format
    : "dubsar.project-evidence/1";
}

function addTextPrivacy(privacy, display) {
  if (display.redacted) {
    privacy.redacted_fields += 1;
  }
  if (display.truncated) {
    privacy.truncated_fields += 1;
  }
  return display.text;
}

function projectPresentation(snapshot, evaluation, limits, privacy) {
  if (snapshot.workspace_mode === "memory_vnext") {
    const selected = evaluation.memory.selected_work;
    const title = safeDisplayText(
      evaluation.memory.project.title,
      limits.maxViewTextChars,
    );
    const summary = safeDisplayText(
      selected === null
        ? "No work item selected. Choose an open work item to resume."
        : selected.objective,
      limits.maxViewTextChars,
    );
    const evidence = (evaluation.continuity?.records ?? [])
      .slice(-limits.maxViewItems)
      .map((entry, index) => {
        const statement = safeDisplayText(entry.statement, limits.maxViewTextChars);
        return {
          id: publicId(entry.evidence_id, `checkpoint-${index + 1}`, privacy, limits),
          statement: addTextPrivacy(privacy, statement),
          status: entry.supported ? "supported" : "reported",
          content_redacted: statement.redacted,
        };
      });
    const decisions = (evaluation.continuity?.decisions ?? [])
      .slice(-limits.maxViewItems)
      .map((entry, index) => {
        const label = safeDisplayText(entry.statement, limits.maxViewTextChars);
        return {
          id: publicId(entry.evidence_id, `recorded-decision-${index + 1}`, privacy, limits),
          label: addTextPrivacy(privacy, label),
          status: "recorded",
          content_redacted: label.redacted,
        };
      });
    return {
      overview: {
        title: addTextPrivacy(privacy, title) || "Untitled continuity project",
        summary: addTextPrivacy(privacy, summary),
        counts: null,
      },
      evidence,
      decisions,
    };
  }
  if (snapshot.workspace_mode === "lite") {
    const state = snapshot.documents["state.json"] ?? {};
    const checkpointDocument = snapshot.documents["checkpoints.json"] ?? {};
    const checkpoints = Array.isArray(checkpointDocument.entries) ? checkpointDocument.entries : [];
    const title = safeDisplayText(state.title, limits.maxViewTextChars);
    const summary = safeDisplayText(state.mission, limits.maxViewTextChars);
    const evidence = checkpoints.slice(-limits.maxViewItems).map((entry, index) => {
      const statement = safeDisplayText(entry.summary, limits.maxViewTextChars);
      return {
        id: publicId(entry.checkpoint_id, `checkpoint-${index + 1}`, privacy, limits),
        statement: addTextPrivacy(privacy, statement),
        status: entry.references?.length > 0 ? "supported" : "reported",
        content_redacted: statement.redacted,
      };
    });
    const decisions = checkpoints.filter((entry) => entry.kind === "decision")
      .slice(-limits.maxViewItems).map((entry, index) => {
        const label = safeDisplayText(entry.summary, limits.maxViewTextChars);
        return {
          id: publicId(entry.checkpoint_id, `recorded-decision-${index + 1}`, privacy, limits),
          label: addTextPrivacy(privacy, label),
          status: "recorded",
          content_redacted: label.redacted,
        };
      });
    return {
      overview: {
        title: addTextPrivacy(privacy, title) || "Untitled continuity project",
        summary: addTextPrivacy(privacy, summary) || "No mission recorded.",
        counts: null,
      },
      evidence,
      decisions,
    };
  }
  const mission = snapshot.documents["mission.json"] ?? {};
  const evidenceDocument = snapshot.documents["evidence.json"] ?? {};
  const title = safeDisplayText(mission.title, limits.maxViewTextChars);
  const summary = safeDisplayText(
    mission.desired_outcome,
    limits.maxViewTextChars,
  );
  const evidence = (Array.isArray(evidenceDocument.entries)
    ? evidenceDocument.entries
    : []
  )
    .slice(0, limits.maxViewItems)
    .map((entry, index) => {
      const statement = safeDisplayText(
        entry?.statement ?? entry?.claim,
        limits.maxViewTextChars,
      );
      const text = addTextPrivacy(privacy, statement);
      const continuityRecord = evaluation.continuity?.records?.find(
        (item) => item.evidence_id === entry?.evidence_id,
      );
      const supported = continuityRecord?.supported === true;
      return {
        id: publicId(
          entry?.evidence_id,
          `evidence-${index + 1}`,
          privacy,
          limits,
        ),
        statement: text,
        status: supported ? "supported" : entry?.class === "reported" ? "reported" : "unverified",
        content_redacted: statement.redacted,
      };
    });
  const missionDecisions = (Array.isArray(mission.open_decisions)
    ? mission.open_decisions
    : []
  )
    .slice(0, limits.maxViewItems)
    .map((decision, index) => {
      const label = safeDisplayText(decision, limits.maxViewTextChars);
      return {
        id: `decision-${String(index + 1).padStart(3, "0")}`,
        label: addTextPrivacy(privacy, label),
        status: "open",
        content_redacted: label.redacted,
      };
    });
  const recordedDecisions = (evaluation.continuity?.decisions ?? [])
    .slice(0, Math.max(0, limits.maxViewItems - missionDecisions.length))
    .map((decision, index) => {
      const label = safeDisplayText(decision.statement, limits.maxViewTextChars);
      return {
        id: publicId(
          decision.evidence_id,
          `recorded-decision-${index + 1}`,
          privacy,
          limits,
        ),
        label: addTextPrivacy(privacy, label),
        status: "recorded",
        content_redacted: label.redacted,
      };
    });
  return {
    overview: {
      title: addTextPrivacy(privacy, title) || "Untitled project mission",
      summary: addTextPrivacy(privacy, summary) || "No desired outcome recorded.",
      counts: null,
    },
    evidence,
    decisions: [...missionDecisions, ...recordedDecisions],
  };
}

function auditPresentation(snapshot, limits, privacy) {
  const scope = snapshot.documents["audit-scope.json"] ?? {};
  const review = snapshot.documents["evidence-review.json"] ?? {};
  const actionsDocument = snapshot.documents["sensitive-actions.json"] ?? {};
  const title = safeDisplayText(scope.objective, limits.maxViewTextChars);
  const limitations = Array.isArray(scope.limitations) ? scope.limitations : [];
  const summary = safeDisplayText(
    limitations.length > 0
      ? limitations.join(" ")
      : "Bounded local audit preparation; not an audit result.",
    limits.maxViewTextChars,
  );
  const evidence = (Array.isArray(review.supported_observations)
    ? review.supported_observations
    : []
  )
    .slice(0, limits.maxViewItems)
    .map((observation, index) => {
      const statement = safeDisplayText(
        observation?.statement,
        limits.maxViewTextChars,
      );
      return {
        id: `observation-${String(index + 1).padStart(3, "0")}`,
        statement: addTextPrivacy(privacy, statement),
        status:
          Array.isArray(observation?.evidence_refs) &&
          observation.evidence_refs.length > 0
            ? "supported"
            : "unverified",
        content_redacted: statement.redacted,
      };
    });
  const decisions = (Array.isArray(actionsDocument.actions)
    ? actionsDocument.actions
    : []
  )
    .slice(0, limits.maxViewItems)
    .map((action, index) => {
      const label = safeDisplayText(
        action?.proposed_review_point ?? action?.effect,
        limits.maxViewTextChars,
      );
      const allowedStatuses = new Set([
        "approved",
        "rejected",
        "unreviewed",
      ]);
      return {
        id: publicId(action?.id, `action-${index + 1}`, privacy, limits),
        label: addTextPrivacy(privacy, label),
        status: allowedStatuses.has(action?.human_status)
          ? action.human_status
          : "unreviewed",
        content_redacted: label.redacted,
      };
    });
  return {
    overview: {
      title: addTextPrivacy(privacy, title) || "Untitled audit preparation",
      summary: addTextPrivacy(privacy, summary),
      counts: null,
    },
    evidence,
    decisions,
  };
}

export function buildWorkbenchView({ snapshot, evaluation, limits, producer }) {
  if (
    !snapshot ||
    snapshot.format !== "dubsar.workspace-snapshot/1" ||
    !evaluation ||
    evaluation.domain !== snapshot.domain ||
    !producer ||
    typeof producer.name !== "string" ||
    typeof producer.version !== "string"
  ) {
    throw new WorkbenchError("VIEW_INPUT_INVALID");
  }
  const privacy = { redacted_fields: 0, truncated_fields: 0 };
  const presentation =
    snapshot.domain === "project"
      ? projectPresentation(snapshot, evaluation, limits, privacy)
      : auditPresentation(snapshot, limits, privacy);
  presentation.overview.counts = evaluation.counts;

  const blockers = [
    ...evaluation.integrity.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: "error",
      title: humanizeCode(diagnostic.code),
    })),
    ...evaluation.readiness.reasons
      .filter((reason) => reason !== "INTEGRITY_INVALID")
      .map((reason) => ({
        code: reason,
        severity: "warning",
        title: humanizeCode(reason),
      })),
    ...(evaluation.continuity?.open_blockers ?? []).map((blocker) => {
      const title = safeDisplayText(blocker.statement, limits.maxViewTextChars);
      return {
        code: publicId(blocker.evidence_id, "recorded-blocker", privacy, limits),
        severity: "warning",
        title: addTextPrivacy(privacy, title),
      };
    }),
  ].sort((left, right) => comparePortable(left.code, right.code));

  const formats =
    snapshot.domain === "project"
      ? snapshot.workspace_mode === "memory_vnext" ? [
          "dubsar.continuity-checkpoints/2",
          "dubsar.knowledge/1",
          "dubsar.local-state/1",
          "dubsar.memory-project/1",
          "dubsar.work/1",
        ] : snapshot.workspace_mode === "lite" ? [
          "dubsar.continuity-checkpoints/1",
          "dubsar.continuity-state/1",
        ] : [
          "dubsar.execution-contract/1",
          projectEvidenceFormat(snapshot.documents["evidence.json"]),
          "dubsar.project-lots/1",
          "dubsar.project-mission/1",
        ]
      : [
          "dubsar.audit-scope/1",
          "dubsar.automation-inventory/1",
          "dubsar.evidence-index/1",
          "dubsar.evidence-review/1",
          "dubsar.sensitive-actions/1",
        ];
  const publicSourceId = publicId(
    evaluation.id,
    null,
    privacy,
    limits,
  );
  return deepFreeze({
    format: WORKBENCH_VIEW_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    producer: {
      name: producer.name,
      version: producer.version,
    },
    source: {
      domain: snapshot.domain,
      id: publicSourceId,
      snapshot_sha256: snapshot.snapshot_sha256,
      formats,
    },
    integrity: evaluation.integrity,
    readiness: evaluation.readiness,
    blockers,
    next_action: evaluation.next_action,
    overview: presentation.overview,
    evidence: presentation.evidence,
    decisions: presentation.decisions,
    privacy,
  });
}
