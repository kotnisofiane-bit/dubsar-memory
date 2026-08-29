import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("KOT-116 validateur transversal collecte toutes les divergences", async () => {
  const findings = [];
  const check = (condition, code) => { if (!condition) findings.push(code); };
  const engine = await readFile(new URL("../packages/dubsar-workbench-launcher/src/registry-store.mjs", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../packages/dubsar-workbench-launcher/src/launcher.mjs", import.meta.url), "utf8");
  const server = await readFile(new URL("../packages/dubsar-workbench-server/src/server.mjs", import.meta.url), "utf8");
  const report = await readFile(new URL("../packages/dubsar-workbench-report/src/interactive.mjs", import.meta.url), "utf8");
  const assets = await readFile(new URL("../packages/dubsar-workbench-report/src/interactive-assets.mjs", import.meta.url), "utf8");
  check(engine.includes("dubsar.ticket-allocations/1") && engine.includes("allocationRoot"), "GLOBAL_ALLOCATION_MISSING");
  check(engine.includes("TICKET_GITHUB_OBSERVER_REQUIRED") && engine.includes("trusted_github_observer"), "TRUST_BOUNDARY_MISSING");
  check(launcher.includes("createTicketDashboardHandler") && launcher.includes("runTicketCli"), "CLI_DASHBOARD_PARITY_MISSING");
  check(server.includes("tickets/(preview|apply)") && server.includes("application/json"), "LOOPBACK_CHANNEL_MISSING");
  for (const state of ["Backlog", "To Do", "In Progress", "In Review", "Blocked", "Paused", "Done", "Cancelled", "Duplicate"]) check(report.includes(state), `GROUP_${state}_MISSING`);
  for (const feature of ["ticket-search", "ticket-project", "ticket-state", "ticket-detail", "ticket-action-json"]) check(report.includes(feature), `UI_${feature}_MISSING`);
  check(report.includes("Advanced") && report.includes("Resume / Memory") && report.includes("Graph"), "ADVANCED_REGRESSION");
  check(assets.includes("workbench-language") && assets.includes("translations"), "I18N_MISSING");
  check(assets.includes(":focus-visible") && report.includes("aria-live") && assets.includes("min-resolution: 192dpi") && assets.includes("max-width: 1100px"), "ACCESSIBILITY_STRUCTURE_MISSING");
  assert.deepEqual(findings, [], `KOT-116 divergences:\n${findings.join("\n")}`);
});
