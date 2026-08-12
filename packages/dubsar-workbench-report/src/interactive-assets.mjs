export const INTERACTIVE_STYLE = String.raw`
:root {
  color-scheme: dark;
  --bg: #0b0f19;
  --panel: #0d1420;
  --panel-soft: #101925;
  --line: #243244;
  --line-strong: #34465c;
  --text: #f4f7fb;
  --muted: #98a6b9;
  --quiet: #64748a;
  --cyan: #58d5f7;
  --blue: #63a4ff;
  --green: #7bd88f;
  --amber: #f4a340;
  --red: #ff4f56;
  --radius: 14px;
  font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text);
}

* { box-sizing: border-box; }

html, body { min-height: 100%; }

body {
  margin: 0;
  background:
    radial-gradient(circle at 46% -18%, rgba(48, 126, 194, 0.10), transparent 34%),
    var(--bg);
  color: var(--text);
}

button, summary { font: inherit; }

button { color: inherit; }

.app-shell {
  display: grid;
  grid-template-columns: 182px minmax(0, 1fr) 410px;
  min-height: 100vh;
}

.app-shell.graph-mode { grid-template-columns: 182px minmax(0, 1fr); }

.rail {
  position: sticky;
  top: 0;
  display: flex;
  min-height: 100vh;
  max-height: 100vh;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: rgba(7, 13, 23, 0.84);
}

.brand {
  padding: 35px 20px 29px;
  font-size: 1.1rem;
  font-weight: 760;
  letter-spacing: 0.04em;
}

.nav-list { display: grid; gap: 8px; }

.nav-button {
  position: relative;
  width: 100%;
  padding: 15px 20px;
  border: 0;
  background: transparent;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
}

.nav-button::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: transparent;
  content: "";
}

.nav-button:hover,
.nav-button:focus-visible {
  background: rgba(38, 61, 88, 0.26);
  color: var(--text);
  outline: none;
}

.nav-button[aria-selected="true"] {
  background: linear-gradient(90deg, rgba(40, 86, 127, 0.32), rgba(40, 86, 127, 0.08));
  color: var(--text);
}

.nav-button[aria-selected="true"]::before {
  background: var(--cyan);
  box-shadow: 0 0 16px rgba(88, 213, 247, 0.6);
}

.rail-meta {
  margin-top: auto;
  padding: 22px 20px 28px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.76rem;
  line-height: 1.55;
}

.offline-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}

.offline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 12px rgba(123, 216, 143, 0.45);
}

.snapshot-code,
code {
  font-family: "Cascadia Mono", "Fira Code", Consolas, monospace;
}

.workspace {
  min-width: 0;
  padding: 48px 38px 44px;
}

.project-kicker,
.section-label,
.signal-label,
.memory-title,
.graph-kicker {
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 670;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.project-header {
  padding-bottom: 25px;
  border-bottom: 1px solid var(--line-strong);
}

.project-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

.snapshot-note {
  color: var(--quiet);
  font-size: 0.77rem;
}

h1, h2, h3, p { margin-top: 0; }

h1 {
  margin: 16px 0 23px;
  font-size: clamp(2.35rem, 4.2vw, 4.2rem);
  font-weight: 520;
  letter-spacing: -0.045em;
  line-height: 1.02;
}

.state-row {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(300px, 1.6fr);
  gap: 26px;
}

.state-block {
  min-width: 0;
  padding-left: 16px;
  border-left: 2px solid var(--amber);
}

.state-block.blocked { border-left-color: var(--red); }

.state-label {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 0.73rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.state-value {
  color: var(--amber);
  font-size: 1.05rem;
}

.state-block.blocked .state-value { color: var(--red); }

.state-detail {
  display: block;
  margin-top: 5px;
  color: var(--muted);
  font-size: 0.88rem;
  line-height: 1.45;
}

.next-section { margin-top: 30px; }

.next-action {
  display: grid;
  grid-template-columns: 5px minmax(0, 1fr) auto;
  align-items: center;
  min-height: 102px;
  margin-top: 15px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: rgba(9, 16, 27, 0.42);
  overflow: hidden;
}

.next-action-bar {
  align-self: stretch;
  background: var(--amber);
  box-shadow: 0 0 18px rgba(244, 163, 64, 0.34);
}

.next-action-copy { padding: 22px 25px; }

.next-action-copy strong {
  display: block;
  margin-bottom: 6px;
  font-size: clamp(1.08rem, 2vw, 1.42rem);
  font-weight: 580;
}

.next-action-copy span {
  color: var(--muted);
  font-size: 0.84rem;
}

.next-action-tag {
  margin-right: 25px;
  color: var(--amber);
  font-size: 0.77rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.signal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin-top: 32px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.signal-column { padding: 26px 0; }

.signal-column + .signal-column {
  padding-left: 30px;
  border-left: 1px solid var(--line);
}

.health-value {
  display: block;
  margin: 12px 0 16px;
  color: var(--green);
  font-size: 2.6rem;
  font-weight: 580;
  letter-spacing: -0.04em;
}

.health-value.invalid { color: var(--red); }

.progress-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  margin-top: 21px;
}

.progress-line strong {
  color: var(--cyan);
  font-size: 1.24rem;
  font-weight: 580;
}

.progress-line span { color: var(--muted); font-size: 0.82rem; }

progress {
  width: 100%;
  height: 9px;
  margin-top: 10px;
  border: 0;
  border-radius: 999px;
  background: #223044;
  overflow: hidden;
}

progress::-webkit-progress-bar { background: #223044; }
progress::-webkit-progress-value { background: var(--cyan); }
progress::-moz-progress-bar { background: var(--cyan); }

.signal-list,
.decision-list,
.memory-list,
.graph-node-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.signal-list { margin-top: 12px; }

.signal-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}

.signal-list li:last-child { border-bottom: 0; }

.signal-list strong { color: var(--text); font-weight: 600; }

.decisions-section { margin-top: 29px; }

.decision-list { margin-top: 13px; border-top: 1px solid var(--line); }

.decision-item {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}

.decision-index { color: var(--quiet); font-family: "Cascadia Mono", Consolas, monospace; }

.decision-copy strong {
  display: block;
  margin-bottom: 5px;
  font-size: 0.92rem;
  font-weight: 550;
  line-height: 1.45;
}

.decision-copy span,
.decision-state { color: var(--muted); font-size: 0.77rem; }

.decision-state { color: var(--amber); }

.empty-state {
  padding: 20px 0;
  color: var(--muted);
  font-size: 0.88rem;
}

.technical {
  margin-top: 32px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.78rem;
}

.technical summary { cursor: pointer; }

.technical dl {
  display: grid;
  grid-template-columns: minmax(150px, 0.35fr) 1fr;
  gap: 9px 18px;
  margin-bottom: 0;
}

.technical dt { color: var(--quiet); }
.technical dd { margin: 0; overflow-wrap: anywhere; }

.memory-panel {
  min-width: 0;
  padding: 49px 38px 40px;
  border-left: 1px solid var(--line-strong);
  background: rgba(5, 11, 20, 0.44);
}

.memory-list { margin-top: 25px; }

.memory-item {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  gap: 15px;
  align-items: center;
  min-height: 104px;
  border-bottom: 1px solid var(--line);
}

.memory-index {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  color: var(--green);
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 0.72rem;
}

.memory-item:nth-child(2) .memory-index { color: var(--cyan); }
.memory-item:nth-child(3) .memory-index { color: var(--red); }
.memory-item:nth-child(4) .memory-index { color: var(--blue); }
.memory-item:nth-child(5) .memory-index { color: var(--green); }

.memory-copy strong {
  display: block;
  margin-bottom: 5px;
  font-size: 1rem;
  font-weight: 550;
}

.memory-copy span { color: var(--muted); font-size: 0.78rem; }

.memory-count {
  color: var(--green);
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 0.78rem;
  text-align: right;
}

.memory-count.pending { color: var(--quiet); }

.memory-previews {
  grid-column: 1 / -1;
  margin: 0 0 18px 51px;
  color: var(--muted);
}

.memory-previews summary {
  cursor: pointer;
  color: var(--cyan);
  font-size: 0.76rem;
}

.memory-previews ol { margin-top: 12px; }

.memory-preview {
  padding: 10px 0;
  border-top: 1px solid var(--line);
}

.memory-preview > span {
  display: block;
  color: var(--quiet);
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 0.68rem;
}

.memory-preview strong { display: block; margin-top: 4px; color: var(--text); font-size: 0.82rem; }
.memory-preview p { margin-top: 5px; color: var(--muted); font-size: 0.74rem; line-height: 1.45; }

.memory-warning {
  margin-top: 23px;
  color: var(--quiet);
  font-size: 0.75rem;
  line-height: 1.55;
}

.graph-view { min-height: calc(100vh - 92px); }

.graph-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}

.graph-header h1 { margin-bottom: 8px; font-size: clamp(2rem, 3vw, 3.2rem); }

.graph-header p { max-width: 640px; color: var(--muted); line-height: 1.5; }

.graph-toolbar { display: flex; flex: 0 0 auto; gap: 8px; }

.graph-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0 0 14px;
  border: 1px solid var(--line);
  background: rgba(9, 16, 27, 0.66);
}

.graph-summary li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 11px 14px;
  border-right: 1px solid var(--line);
}

.graph-summary li:last-child { border-right: 0; }

.graph-summary strong { color: var(--text); font-size: 0.94rem; }
.graph-summary span { color: var(--quiet); font-size: 0.7rem; text-align: right; }

.graph-scope-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.graph-scope-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.graph-scope-button strong {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(99, 164, 255, 0.1);
  color: var(--quiet);
  font: 600 0.68rem Consolas, monospace;
}

.graph-scope-button:hover,
.graph-scope-button:focus-visible {
  border-color: var(--cyan);
  color: var(--text);
  outline: none;
}

.graph-scope-button[aria-pressed="true"] {
  border-color: rgba(88, 213, 247, 0.66);
  background: rgba(88, 213, 247, 0.1);
  color: var(--cyan);
}

.tool-button,
.graph-node-choice {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  cursor: pointer;
}

.tool-button {
  min-width: 40px;
  height: 38px;
  padding: 0 12px;
  border-radius: 7px;
  color: var(--muted);
}

.tool-button:hover,
.tool-button:focus-visible,
.graph-node-choice:hover,
.graph-node-choice:focus-visible {
  border-color: var(--cyan);
  color: var(--text);
  outline: none;
}

.graph-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  height: clamp(420px, calc(100vh - 350px), 660px);
  min-height: 420px;
  border: 1px solid var(--line-strong);
  background: rgba(7, 13, 23, 0.68);
}

.canvas-wrap { position: relative; min-height: 0; overflow: hidden; }

#graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  touch-action: none;
  cursor: grab;
}

#graph-canvas.dragging { cursor: grabbing; }

.graph-details {
  min-height: 0;
  padding: 22px;
  overflow: auto;
  border-left: 1px solid var(--line);
  background: rgba(9, 16, 27, 0.82);
}

.graph-details h2 { margin: 9px 0 8px; font-size: 1.05rem; }
.graph-details p { color: var(--muted); font-size: 0.8rem; line-height: 1.5; }

.graph-detail-relations {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  color: var(--quiet) !important;
  font-size: 0.72rem !important;
}

.graph-node-list { margin-top: 22px; }

.graph-node-choice {
  width: 100%;
  padding: 10px 11px;
  border-width: 0 0 1px;
  border-color: var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 0.77rem;
  text-align: left;
}

.graph-node-choice[aria-current="true"] { color: var(--cyan); }

[hidden] { display: none !important; }

@media (max-width: 1180px) {
  .app-shell { grid-template-columns: 168px minmax(0, 1fr); }
  .memory-panel { grid-column: 2; border-top: 1px solid var(--line-strong); border-left: 0; }
  .memory-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 28px; }
}

@media (max-width: 760px) {
  .app-shell { display: block; }
  .rail { position: static; min-height: auto; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { padding: 22px 18px 15px; }
  .nav-list { display: flex; }
  .nav-button { padding: 13px 18px; }
  .rail-meta { display: none; }
  .workspace, .memory-panel { padding: 30px 20px; }
  .memory-panel { border-top: 1px solid var(--line-strong); }
  .state-row, .signal-grid, .graph-layout { grid-template-columns: 1fr; }
  .signal-column + .signal-column { padding-left: 0; border-top: 1px solid var(--line); border-left: 0; }
  .memory-list { display: block; }
  .graph-header { display: block; }
  .graph-toolbar { margin-top: 18px; }
  .graph-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .graph-summary li:nth-child(2) { border-right: 0; }
  .graph-summary li:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
  .graph-details { border-top: 1px solid var(--line); border-left: 0; }
  .graph-layout { height: auto; min-height: 0; }
  .canvas-wrap, #graph-canvas { min-height: 480px; }
  .decision-item { grid-template-columns: 24px minmax(0, 1fr); }
  .decision-state { grid-column: 2; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;

export const INTERACTIVE_SCRIPT = String.raw`
(() => {
  "use strict";

  const MAX_ITEMS = 256;
  const MAX_TEXT = 2000;
  const MAX_CANVAS_PIXELS = 4000000;
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const dataNode = document.getElementById("workbench-data");
  const dashboard = document.getElementById("dashboard-view");
  const graphView = document.getElementById("graph-view");
  const canvas = document.getElementById("graph-canvas");

  function safeObject(value, depth) {
    if (depth > 8) return false;
    if (value === null) return true;
    if (typeof value === "string") return value.length <= MAX_TEXT;
    if (typeof value === "number") return Number.isSafeInteger(value);
    if (typeof value === "boolean") return true;
    if (typeof value !== "object") return false;
    if (Array.isArray(value)) {
      return value.length <= MAX_ITEMS && value.every((item) => safeObject(item, depth + 1));
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_ITEMS || keys.some((key) => FORBIDDEN_KEYS.has(key))) return false;
    return keys.every((key) => safeObject(value[key], depth + 1));
  }

  function safeText(value) {
    return typeof value === "string" && value.length <= MAX_TEXT;
  }

  function validGraph(graph) {
    if (
      !graph ||
      graph.format !== "dubsar.workbench-graph/1" ||
      !new Set(["available", "unavailable"]).has(graph.status) ||
      !Array.isArray(graph.nodes) ||
      !Array.isArray(graph.edges) ||
      !Array.isArray(graph.diagnostics) ||
      graph.nodes.length > MAX_ITEMS ||
      graph.edges.length > MAX_ITEMS * 2
    ) return false;
    const ids = new Set();
    for (const node of graph.nodes) {
      if (
        !node ||
        !safeText(node.id) ||
        !safeText(node.kind) ||
        !safeText(node.label) ||
        !safeText(node.detail) ||
        ids.has(node.id)
      ) return false;
      ids.add(node.id);
    }
    return graph.edges.every((edge) =>
      edge &&
      safeText(edge.id) &&
      safeText(edge.from) &&
      safeText(edge.to) &&
      safeText(edge.kind) &&
      ids.has(edge.from) &&
      ids.has(edge.to)
    );
  }

  function validMemory(memory) {
    if (
      !memory ||
      memory.format !== "dubsar.personal-memory-presentation/1" ||
      memory.authority !== "private_advisory_snapshot" ||
      !new Set(["included", "not_included"]).has(memory.status) ||
      !Array.isArray(memory.categories) ||
      memory.categories.length !== 5
    ) return false;
    return memory.categories.every((category) =>
      category &&
      safeText(category.id) &&
      safeText(category.label) &&
      typeof category.included === "boolean" &&
      Number.isSafeInteger(category.count) &&
      category.count >= 0 &&
      category.count <= 10 &&
      Array.isArray(category.entries) &&
      category.entries.length === category.count &&
      category.entries.every((entry) =>
        entry &&
        safeText(entry.id) &&
        safeText(entry.date) &&
        safeText(entry.title) &&
        safeText(entry.preview) &&
        Array.isArray(entry.links) &&
        entry.links.length <= 16 &&
        entry.links.every(safeText)
      )
    );
  }

  function validData(value) {
    return Boolean(
      value &&
      value.format === "dubsar.workbench-interactive-data/2" &&
      safeObject(value, 0) &&
      validGraph(value.graph) &&
      validMemory(value.memory) &&
      value.view &&
      value.view.format === "dubsar.workbench-view/1" &&
      value.view.overview &&
      safeText(value.view.overview.title) &&
      Array.isArray(value.view.blockers) &&
      Array.isArray(value.view.decisions) &&
      Array.isArray(value.view.evidence)
    );
  }

  let data;
  try {
    data = JSON.parse(dataNode.textContent);
    if (!validData(data)) throw new Error("invalid");
  } catch {
    document.documentElement.dataset.runtime = "invalid";
    return;
  }

  const colors = {
    mission: "#58d5f7",
    lot: "#63a4ff",
    contract: "#c084fc",
    blocker: "#ff4f56",
    decision: "#f4a340",
    evidence: "#7bd88f",
    memory: "#63a4ff"
  };

  function trimLabel(value, max) {
    return value.length <= max ? value : value.slice(0, max - 1) + "\u2026";
  }

  function idHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededPosition(id, index) {
    const hash = idHash(id);
    const angle = ((hash % 3600) / 3600) * Math.PI * 2;
    const radius = index === 0 ? 0 : 80 + (hash % 170);
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    };
  }

  function buildNodes() {
    const canonical = data.graph.status === "available"
      ? data.graph.nodes.map((item) => ({ ...item, scope: "project" }))
      : [{ id: "mission", kind: "mission", label: data.view.overview.title, detail: data.view.overview.summary, scope: "project" }];
    const memory = data.memory.status === "included"
      ? data.memory.categories.flatMap((category) => [
          {
            id: "memory-category-" + category.id,
            kind: "memory",
            label: category.label,
            detail: String(category.count) + " apercus prives",
            scope: "memory-" + category.id
          },
          ...category.entries.map((entry) => ({
            id: entry.id,
            kind: "memory",
            label: entry.title,
            detail: entry.preview,
            scope: "memory-" + category.id
          }))
        ])
      : [];
    const source = [...canonical, ...memory];
    return source.map((item, index) => {
      const position = seededPosition(item.id, index);
      return {
        id: item.id,
        kind: item.kind,
        label: item.label,
        detail: item.detail,
        scope: item.scope,
        x: position.x,
        y: position.y,
        vx: 0,
        vy: 0,
        fixed: false
      };
    });
  }

  const nodes = buildNodes();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = data.graph.edges.map((edge) => ({
    id: edge.id,
    kind: edge.kind,
    from: nodeById.get(edge.from),
    to: nodeById.get(edge.to)
  })).filter((edge) => edge.from && edge.to);
  if (data.memory.status === "included") {
    const titleTargets = new Map();
    data.memory.categories.forEach((category) => {
      const categoryId = "memory-category-" + category.id;
      titleTargets.set(category.id.toLowerCase(), categoryId);
      titleTargets.set(category.label.toLowerCase(), categoryId);
      if (nodeById.has("mission")) {
        links.push({
          id: "memory-root-" + category.id,
          kind: "memory_category",
          from: nodeById.get("mission"),
          to: nodeById.get(categoryId)
        });
      }
      category.entries.forEach((entry) => {
        titleTargets.set(entry.title.toLowerCase(), entry.id);
        links.push({
          id: "memory-entry-link-" + entry.id,
          kind: "memory_entry",
          from: nodeById.get(categoryId),
          to: nodeById.get(entry.id)
        });
      });
    });
    data.memory.categories.forEach((category) => {
      category.entries.forEach((entry) => {
        entry.links.forEach((link, index) => {
          const targetId = titleTargets.get(link.toLowerCase());
          if (targetId && targetId !== entry.id) {
            links.push({
              id: "memory-backlink-" + entry.id + "-" + index,
              kind: "memory_backlink",
              from: nodeById.get(entry.id),
              to: nodeById.get(targetId)
            });
          }
        });
      });
    });
  }
  let activeScope = "project";
  let selected = nodeById.get("mission") || nodes[0];
  let hovered = null;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let fitScale = 1;
  let dpr = 1;
  let width = 0;
  let height = 0;
  let pointer = null;
  let moved = false;
  let simulationFrame = 0;
  let simulationTicks = 0;
  const context = canvas.getContext("2d", { alpha: false });
  const detailKind = document.getElementById("graph-detail-kind");
  const detailTitle = document.getElementById("graph-detail-title");
  const detailText = document.getElementById("graph-detail-text");
  const detailRelations = document.getElementById("graph-detail-relations");

  function visibleNodes() {
    return nodes.filter((node) => node.scope === activeScope);
  }

  function visibleLinks() {
    const ids = new Set(visibleNodes().map((node) => node.id));
    return links.filter((link) => ids.has(link.from.id) && ids.has(link.to.id));
  }

  function resetVisiblePositions() {
    visibleNodes().forEach((node, index) => {
      const position = seededPosition(node.id, index);
      node.x = position.x;
      node.y = position.y;
      node.vx = 0;
      node.vy = 0;
      node.fixed = false;
    });
  }

  function screenPoint(node) {
    return {
      x: width / 2 + panX + node.x * scale * fitScale,
      y: height / 2 + panY + node.y * scale * fitScale
    };
  }

  function tickSimulation() {
    const repulsion = 1800;
    const spring = 0.018;
    const center = 0.004;
    const scopeNodes = visibleNodes();
    const scopeLinks = visibleLinks();
    let energy = 0;
    scopeNodes.forEach((node) => {
      node.fx = 0;
      node.fy = 0;
    });
    for (let leftIndex = 0; leftIndex < scopeNodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < scopeNodes.length; rightIndex += 1) {
        const left = scopeNodes[leftIndex];
        const right = scopeNodes[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        if (dx === 0 && dy === 0) {
          dx = ((idHash(left.id + right.id) % 17) - 8) / 10 || 0.1;
          dy = ((idHash(right.id + left.id) % 17) - 8) / 10 || 0.1;
        }
        const distanceSquared = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const force = repulsion / distanceSquared;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        left.fx -= fx;
        left.fy -= fy;
        right.fx += fx;
        right.fy += fy;
      }
    }
    scopeLinks.forEach((link) => {
      const dx = link.to.x - link.from.x;
      const dy = link.to.y - link.from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const target = link.kind === "depends_on" ? 145 : 115;
      const force = (distance - target) * spring;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      link.from.fx += fx;
      link.from.fy += fy;
      link.to.fx -= fx;
      link.to.fy -= fy;
    });
    scopeNodes.forEach((node) => {
      if (node.fixed) return;
      node.vx = Math.max(-8, Math.min(8, (node.vx + node.fx - node.x * center) * 0.86));
      node.vy = Math.max(-8, Math.min(8, (node.vy + node.fy - node.y * center) * 0.86));
      node.x += node.vx;
      node.y += node.vy;
      energy += node.vx * node.vx + node.vy * node.vy;
    });
    return energy;
  }

  function animateGraph() {
    let energy = 0;
    for (let index = 0; index < 3; index += 1) {
      energy = tickSimulation();
      simulationTicks += 1;
    }
    draw();
    if (simulationTicks < 180 && (simulationTicks < 36 || energy > 0.02)) {
      simulationFrame = requestAnimationFrame(animateGraph);
    } else {
      simulationFrame = 0;
    }
  }

  function startSimulation() {
    simulationTicks = 0;
    if (simulationFrame === 0 && visibleNodes().length > 1) {
      simulationFrame = requestAnimationFrame(animateGraph);
    }
  }

  function statusLabel(value) {
    const labels = {
      complete: "Terminé",
      planned: "Planifié",
      candidate: "Candidat",
      draft: "Brouillon",
      approved: "Approuvé",
      open: "Ouverte"
    };
    return labels[value] || value;
  }

  function draw() {
    if (!context || width <= 0 || height <= 0) return;
    const scopeNodes = visibleNodes();
    const scopeLinks = visibleLinks();
    const neighborIds = new Set(selected ? [selected.id] : []);
    scopeLinks.forEach((link) => {
      if (link.from === selected) neighborIds.add(link.to.id);
      if (link.to === selected) neighborIds.add(link.from.id);
    });
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#07101b";
    context.fillRect(0, 0, width, height);

    scopeLinks.forEach((link) => {
      const from = screenPoint(link.from);
      const to = screenPoint(link.to);
      const active = link.from === selected || link.to === selected;
      context.lineWidth = active ? 2 : 1;
      context.strokeStyle = active ? "rgba(88, 213, 247, 0.82)" : "rgba(92, 125, 158, 0.34)";
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    });

    scopeNodes.forEach((node) => {
      const point = screenPoint(node);
      const radius = node.kind === "mission" ? 15 : 10;
      const color = colors[node.kind] || "#b5c2d1";
      const connected = neighborIds.size === 0 || neighborIds.has(node.id);
      context.save();
      context.globalAlpha = connected ? 1 : 0.32;
      context.shadowColor = color;
      context.shadowBlur = node === selected ? 18 : 8;
      context.fillStyle = "#0b1725";
      context.strokeStyle = color;
      context.lineWidth = node === selected ? 3 : 1.5;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();

      if (node.kind === "lot") {
        context.fillStyle = connected ? color : "#617186";
        context.font = "600 10px Consolas, monospace";
        context.textAlign = "center";
        context.fillText(statusLabel(node.detail), point.x, point.y + radius + 15, 78);
      }

      const persistent = new Set(["mission", "contract", "blocker"]).has(node.kind) ||
        (node.kind === "memory" && node.id.startsWith("memory-category-"));
      if (node === selected || node === hovered || persistent) {
        context.fillStyle = node === selected ? "#f4f7fb" : "#b5c2d1";
        context.font = node === selected ? "600 13px Segoe UI, sans-serif" : "12px Segoe UI, sans-serif";
        context.textAlign = point.x < 70 ? "left" : point.x > width - 70 ? "right" : "center";
        const labelY = node.kind === "lot" ? point.y + radius + 31 : point.y + radius + 19;
        context.fillText(trimLabel(node.label, 30), point.x, labelY, 150);
      }
    });
  }

  function resize() {
    const box = canvas.getBoundingClientRect();
    width = Math.max(1, Math.floor(box.width));
    height = Math.max(1, Math.floor(box.height));
    const budgetDpr = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
    dpr = Math.max(
      0.01,
      Math.min(Math.max(window.devicePixelRatio || 1, 1), 2, budgetDpr)
    );
    const scopeNodes = visibleNodes();
    const maxNodeX = Math.max(1, ...scopeNodes.map((node) => Math.abs(node.x)));
    const maxNodeY = Math.max(1, ...scopeNodes.map((node) => Math.abs(node.y)));
    fitScale = Math.min(
      1,
      Math.max(0.35, (width - 80) / (maxNodeX * 2)),
      Math.max(0.35, (height - 88) / (maxNodeY * 2))
    );
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    draw();
  }

  function selectNode(node) {
    selected = node;
    detailKind.textContent = node.kind === "lot"
      ? "lot · " + statusLabel(node.detail)
      : node.kind;
    detailTitle.textContent = node.label;
    detailText.textContent = node.detail;
    const relations = visibleLinks().filter(
      (link) => link.from === node || link.to === node
    );
    if (relations.length === 0) {
      detailRelations.textContent = "Aucune relation dans cette vue.";
    } else if (node.id.startsWith("memory-category-")) {
      detailRelations.textContent = String(relations.length) + " entrées dans cette catégorie.";
    } else if (relations.length > 4) {
      const counts = new Map();
      relations.forEach((link) => {
        const other = link.from === node ? link.to : link.from;
        counts.set(other.kind, (counts.get(other.kind) || 0) + 1);
      });
      const kindLabels = {
        blocker: "blocage",
        contract: "contrat",
        decision: "décision",
        evidence: "preuve",
        lot: "lot",
        memory: "entrée mémoire",
        mission: "mission"
      };
      detailRelations.textContent = String(relations.length) + " relations directes : " +
        [...counts.entries()].map(([kind, count]) =>
          String(count) + " " + (kindLabels[kind] || kind) + (count > 1 ? "s" : "")
        ).join(" · ") + ".";
    } else {
      const relationLabels = {
        contains: "Contient",
        depends_on: "Dépend de",
        governs: "Gouverne",
        has_blocker: "Bloque",
        has_open_decision: "Décision ouverte",
        memory_backlink: "Lié à",
        memory_entry: "Contient",
        supports: "Étaye"
      };
      detailRelations.textContent = relations.map((link) => {
        const other = link.from === node ? link.to : link.from;
        return (relationLabels[link.kind] || link.kind) + " · " + trimLabel(other.label, 36);
      }).join(" • ");
    }
    document.querySelectorAll(".graph-node-choice").forEach((button) => {
      button.setAttribute("aria-current", String(button.dataset.nodeId === node.id));
    });
    draw();
  }

  function hitTest(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const scopeNodes = visibleNodes();
    for (let index = scopeNodes.length - 1; index >= 0; index -= 1) {
      const node = scopeNodes[index];
      const point = screenPoint(node);
      const radius = node.kind === "mission" ? 22 : 18;
      if (Math.hypot(point.x - x, point.y - y) <= radius) return node;
    }
    return null;
  }

  function setGraphScope(next) {
    const target = document.querySelector(
      '.graph-scope-button[data-graph-scope="' + next + '"]'
    );
    if (!target) return;
    activeScope = next;
    hovered = null;
    panX = 0;
    panY = 0;
    scale = 1;
    document.querySelectorAll(".graph-scope-button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button === target));
    });
    document.querySelectorAll("[data-node-scope]").forEach((item) => {
      item.hidden = item.dataset.nodeScope !== activeScope;
    });
    resetVisiblePositions();
    selected = activeScope === "project"
      ? nodeById.get("mission") || visibleNodes()[0]
      : nodeById.get("memory-category-" + activeScope.slice("memory-".length)) || visibleNodes()[0];
    if (selected) selectNode(selected);
    resize();
    startSimulation();
  }

  function setView(next) {
    const graphActive = next === "graph";
    dashboard.hidden = graphActive;
    graphView.hidden = !graphActive;
    document.getElementById("memory-panel").hidden = graphActive;
    document.getElementById("app-shell").classList.toggle("graph-mode", graphActive);
    document.querySelectorAll(".nav-button").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.view === next));
    });
    if (graphActive) {
      requestAnimationFrame(() => {
        resize();
        startSimulation();
        document.querySelector('.graph-scope-button[aria-pressed="true"]')?.focus();
      });
    }
  }

  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.querySelectorAll(".graph-node-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const node = nodeById.get(button.dataset.nodeId);
      if (node) selectNode(node);
    });
  });

  document.querySelectorAll(".graph-scope-button").forEach((button) => {
    button.addEventListener("click", () => setGraphScope(button.dataset.graphScope));
  });

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    const node = hitTest(event.clientX, event.clientY);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, node };
    moved = false;
    canvas.classList.add("dragging");
    if (node) {
      node.fixed = true;
      node.vx = 0;
      node.vy = 0;
      selectNode(node);
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer) {
      const nextHovered = hitTest(event.clientX, event.clientY);
      if (nextHovered !== hovered) {
        hovered = nextHovered;
        canvas.style.cursor = hovered ? "pointer" : "grab";
        draw();
      }
      return;
    }
    if (pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    if (pointer.node) {
      pointer.node.x += dx / (scale * fitScale);
      pointer.node.y += dy / (scale * fitScale);
    } else {
      panX += dx;
      panY += dy;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    draw();
  });

  function endPointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!moved && !pointer.node) {
      const node = hitTest(event.clientX, event.clientY);
      if (node) selectNode(node);
    }
    if (pointer.node) {
      pointer.node.fixed = false;
      startSimulation();
    }
    pointer = null;
    canvas.classList.remove("dragging");
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!pointer && hovered) {
      hovered = null;
      canvas.style.cursor = "grab";
      draw();
    }
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(2.4, Math.max(0.45, scale * factor));
    draw();
  }, { passive: false });

  document.getElementById("graph-zoom-in").addEventListener("click", () => {
    scale = Math.min(2.4, scale * 1.15);
    draw();
  });
  document.getElementById("graph-zoom-out").addEventListener("click", () => {
    scale = Math.max(0.45, scale / 1.15);
    draw();
  });
  document.getElementById("graph-reset").addEventListener("click", () => {
    panX = 0;
    panY = 0;
    scale = 1;
    resetVisiblePositions();
    startSimulation();
    draw();
  });
  window.addEventListener("resize", resize);
  setGraphScope("project");
  document.documentElement.dataset.runtime = "ready";
})();
`;
