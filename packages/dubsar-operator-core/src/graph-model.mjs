import {
  WORKBENCH_AUTHORITY,
  comparePortable,
  deepFreeze,
} from "./contracts.mjs";
import { safeDisplayText } from "./display-safety.mjs";

export const WORKBENCH_GRAPH_FORMAT = "dubsar.workbench-graph/1";

function display(value, limits, fallback) {
  const candidate = safeDisplayText(value, limits.maxViewTextChars).text;
  return candidate.length > 0 ? candidate : fallback;
}

function unavailable(snapshot, code) {
  return deepFreeze({
    format: WORKBENCH_GRAPH_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    status: "unavailable",
    source_snapshot_sha256: snapshot.snapshot_sha256,
    nodes: [],
    edges: [],
    diagnostics: [{ code, severity: "warning" }],
  });
}

function sortByLotId(items) {
  return [...items].sort((left, right) =>
    comparePortable(String(left?.lot_id ?? ""), String(right?.lot_id ?? "")),
  );
}

function sortByEvidenceId(items) {
  return [...items].sort((left, right) =>
    comparePortable(
      String(left?.evidence_id ?? ""),
      String(right?.evidence_id ?? ""),
    ),
  );
}

export function buildWorkbenchGraph({ snapshot, view, limits }) {
  if (snapshot.domain !== "project") {
    return unavailable(snapshot, "GRAPH_DOMAIN_UNSUPPORTED");
  }

  if (snapshot.workspace_mode === "memory_vnext") {
    const works = [...(snapshot.documents.works ?? [])].sort((left, right) =>
      comparePortable(String(left?.work_id ?? ""), String(right?.work_id ?? "")),
    );
    const nodes = [{
      id: "mission",
      kind: "mission",
      label: display(view?.overview?.title, limits, "Project"),
      detail: display(view?.overview?.summary, limits, "Local project continuity"),
    }];
    const edges = [];
    works.forEach((work, index) => {
      const id = `lot-${String(index).padStart(3, "0")}`;
      nodes.push({
        id,
        kind: "lot",
        label: display(work.title, limits, "Untitled work item"),
        detail: display(work.status, limits, "open"),
      });
      edges.push({
        id: `contains-${id}`,
        from: "mission",
        to: id,
        kind: "contains",
      });
    });
    if (
      nodes.length > limits.maxViewItems ||
      edges.length > limits.maxViewItems * 2
    ) {
      return unavailable(snapshot, "GRAPH_LIMIT_EXCEEDED");
    }
    nodes.sort((left, right) => comparePortable(left.id, right.id));
    edges.sort((left, right) => comparePortable(left.id, right.id));
    return deepFreeze({
      format: WORKBENCH_GRAPH_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      status: "available",
      source_snapshot_sha256: snapshot.snapshot_sha256,
      nodes,
      edges,
      diagnostics: [],
    });
  }

  if (snapshot.workspace_mode === "lite") {
    const nodes = [{
      id: "mission",
      kind: "mission",
      label: display(view?.overview?.title, limits, "Mission"),
      detail: display(view?.overview?.summary, limits, "Local continuity"),
    }];
    const edges = [];
    (view?.blockers ?? []).slice(0, 8).forEach((blocker, index) => {
      const id = `blocker-${String(index).padStart(3, "0")}`;
      nodes.push({ id, kind: "blocker", label: display(blocker.title, limits, "Blocker"), detail: display(blocker.code, limits, "recorded blocker") });
      edges.push({ id: `blocker-link-${id}`, from: "mission", to: id, kind: "has_blocker" });
    });
    (view?.decisions ?? []).slice(0, 8).forEach((decision, index) => {
      const id = `decision-${String(index).padStart(3, "0")}`;
      nodes.push({ id, kind: "decision", label: display(decision.label, limits, "Decision"), detail: "recorded" });
      edges.push({ id: `decision-link-${id}`, from: "mission", to: id, kind: "has_recorded_decision" });
    });
    return deepFreeze({
      format: WORKBENCH_GRAPH_FORMAT,
      authority: WORKBENCH_AUTHORITY,
      status: "available",
      source_snapshot_sha256: snapshot.snapshot_sha256,
      nodes,
      edges,
      diagnostics: [],
    });
  }

  const mission = snapshot.documents["mission.json"];
  const lotDocument = snapshot.documents["lots.json"];
  const contract = snapshot.documents["execution-contract.json"];
  const evidenceDocument = snapshot.documents["evidence.json"];
  const evidenceV2 = evidenceDocument?.format === "dubsar.project-evidence/2";
  const lots = Array.isArray(lotDocument?.lots)
    ? sortByLotId(lotDocument.lots)
    : [];
  const evidence = Array.isArray(evidenceDocument?.entries)
    ? sortByEvidenceId(evidenceDocument.entries)
    : [];
  const decisions = Array.isArray(mission?.open_decisions)
    ? mission.open_decisions
    : [];
  const blockers = Array.isArray(view?.blockers) ? view.blockers : [];
  const nodes = [];
  const edges = [];
  const lotIds = new Map();

  nodes.push({
    id: "mission",
    kind: "mission",
    label: display(view?.overview?.title, limits, "Mission"),
    detail: display(view?.overview?.summary, limits, "Projet local"),
  });

  lots.forEach((lot, index) => {
    const id = `lot-${String(index).padStart(3, "0")}`;
    lotIds.set(lot.lot_id, id);
    nodes.push({
      id,
      kind: "lot",
      label: display(lot.title, limits, "Lot sans titre"),
      detail: display(lot.status, limits, "statut inconnu"),
    });
    edges.push({
      id: `contains-${id}`,
      from: "mission",
      to: id,
      kind: "contains",
    });
  });

  for (const lot of lots) {
    const from = lotIds.get(lot.lot_id);
    const dependencies = Array.isArray(lot.depends_on) ? lot.depends_on : [];
    for (const dependency of dependencies) {
      const to = lotIds.get(dependency);
      if (!from || !to) {
        return unavailable(snapshot, "GRAPH_REFERENCE_INVALID");
      }
      edges.push({
        id: `depends-${from}-${to}`,
        from,
        to,
        kind: "depends_on",
      });
    }
  }

  if (typeof contract?.lot_id === "string" && contract.lot_id.length > 0) {
    const governed = lotIds.get(contract.lot_id);
    if (!governed) {
      return unavailable(snapshot, "GRAPH_REFERENCE_INVALID");
    }
    nodes.push({
      id: "contract",
      kind: "contract",
      label: "Contrat d'execution",
      detail: display(contract.status, limits, "statut inconnu"),
    });
    edges.push({
      id: `governs-${governed}`,
      from: "contract",
      to: governed,
      kind: "governs",
    });
  }

  evidence.forEach((entry, index) => {
    const supportedLot = lotIds.get(entry.lot_id);
    if (!supportedLot) {
      return;
    }
    const id = `evidence-${String(index).padStart(3, "0")}`;
    nodes.push({
      id,
      kind: "evidence",
      label: display(evidenceV2 ? entry?.statement : entry?.claim, limits, "Preuve locale"),
      detail: display(entry.class, limits, "classe inconnue"),
    });
    edges.push({
      id: `supports-${id}-${supportedLot}`,
      from: id,
      to: supportedLot,
      kind: "supports",
    });
  });

  if (evidence.some((entry) => !lotIds.has(entry.lot_id))) {
    return unavailable(snapshot, "GRAPH_REFERENCE_INVALID");
  }

  decisions.forEach((decision, index) => {
    const id = `decision-${String(index).padStart(3, "0")}`;
    nodes.push({
      id,
      kind: "decision",
      label: display(decision, limits, "Decision ouverte"),
      detail: "ouverte",
    });
    edges.push({
      id: `decision-link-${id}`,
      from: "mission",
      to: id,
      kind: "has_open_decision",
    });
  });

  blockers.forEach((blocker, index) => {
    const id = `blocker-${String(index).padStart(3, "0")}`;
    nodes.push({
      id,
      kind: "blocker",
      label: display(blocker.title, limits, "Blocage"),
      detail: display(blocker.code, limits, "blocage canonique"),
    });
    edges.push({
      id: `blocker-link-${id}`,
      from: "mission",
      to: id,
      kind: "has_blocker",
    });
  });

  if (
    nodes.length > limits.maxViewItems ||
    edges.length > limits.maxViewItems * 2
  ) {
    return unavailable(snapshot, "GRAPH_LIMIT_EXCEEDED");
  }

  nodes.sort((left, right) => comparePortable(left.id, right.id));
  edges.sort((left, right) => comparePortable(left.id, right.id));
  return deepFreeze({
    format: WORKBENCH_GRAPH_FORMAT,
    authority: WORKBENCH_AUTHORITY,
    status: "available",
    source_snapshot_sha256: snapshot.snapshot_sha256,
    nodes,
    edges,
    diagnostics: [],
  });
}
