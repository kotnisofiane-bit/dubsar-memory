import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const defaultRepositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const policyModuleUrl = new URL("./check-workbench-runtime.mjs", import.meta.url);
const MANIFEST_PATH = "WORKBENCH_CONFORMANCE.json";
const POLICY_PATH = "tools/check-workbench-runtime.mjs";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;
const SHA256 = /^[a-f0-9]{64}$/u;
const PACKAGE_VERSION = "0.1.0-dev";
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
}

export const WORKBENCH_COMPONENTS = freeze([
  {
    key: "cli",
    name: "@dubsar/operator-cli",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-operator-cli",
    entrypoint: "packages/dubsar-operator-cli/bin/dubsar.mjs",
    package_interface: { kind: "bin", target: "./bin/dubsar.mjs" },
    capability_profile: "local_cli_with_explicit_project_memory_writes_and_human_close",
    effects: {
      filesystem_read: "explicit_registry_workspace_init_migration_checkpoint_or_memory_proposal_and_opt_in_fixed_memory_scoped",
      filesystem_write: "one_staged_continuity_directory_or_one_confirmed_allowlisted_project_memory_file_or_one_fixed_personal_memory_file_after_exact_confirmation",
      environment: "localappdata_for_explicit_personal_memory_only",
      subprocess: "none",
      inbound_network: "foreground_ipv4_loopback_listener_via_ui_only",
      outbound_network: "none",
      output: "stdout_stderr_and_ui_url",
    },
    formats: [
      "dubsar.checkpoint-apply/1",
      "dubsar.checkpoint-preview/1",
      "dubsar.checkpoint-proposal/1",
      "dubsar.cli-error/1",
      "dubsar.close-result/1",
      "dubsar.continuity-checkpoint-proposal/1",
      "dubsar.continuity-checkpoints/1",
      "dubsar.continuity-checkpoints/2",
      "dubsar.continuity-init-apply/1",
      "dubsar.continuity-init-preview/1",
      "dubsar.continuity-state/1",
      "dubsar.doctor/1",
      "dubsar.inbox-note/1",
      "dubsar.knowledge/1",
      "dubsar.local-state/1",
      "dubsar.location/1",
      "dubsar.memory-change-apply/1",
      "dubsar.memory-change-preview/1",
      "dubsar.memory-change-proposal/1",
      "dubsar.memory-context/1",
      "dubsar.memory-inbox-view/1",
      "dubsar.memory-init-apply/1",
      "dubsar.memory-init-preview/1",
      "dubsar.memory-knowledge-view/1",
      "dubsar.memory-migration-apply/1",
      "dubsar.memory-migration-preview/1",
      "dubsar.memory-project/1",
      "dubsar.memory-snapshot/1",
      "dubsar.memory-work-view/1",
      "dubsar.personal-memory-command-result/1",
      "dubsar.project-evidence/2",
      "dubsar.resume-capsule/3",
      "dubsar.resume-capsule/4",
      "dubsar.review-ledger-ui-session/1",
      "dubsar.ui-session/1",
      "dubsar.validation/1",
      "dubsar.work/1",
    ],
  },
  {
    key: "codex-adapter",
    name: "@dubsar/codex-workbench-adapter",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-codex-workbench",
    entrypoint: "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "explicit_one_shot_resume_capsule_adapter",
    effects: {
      filesystem_read: "explicit_registry_and_workspace_via_cli",
      filesystem_write: "none",
      environment: "localappdata_default_registry_only",
      subprocess: "fixed_node_cli_without_shell",
      inbound_network: "none",
      outbound_network: "none",
      output: "validated_capsule_or_closed_error",
    },
    formats: ["dubsar.codex-capsule-error/1"],
  },
  {
    key: "core",
    name: "@dubsar/operator-core",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-operator-core",
    entrypoint: "packages/dubsar-operator-core/src/index.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "deterministic_workspace_reader",
    effects: {
      filesystem_read: "workspace_scoped",
      filesystem_write: "none",
      environment: "none",
      subprocess: "none",
      inbound_network: "none",
      outbound_network: "none",
      output: "return_values",
    },
    formats: [
      "dubsar.artifact-lifecycle/1",
      "dubsar.memory-route/2",
      "dubsar.project-history/1",
      "dubsar.project-lots-view/1",
      "dubsar.project-precedents/1",
      "dubsar.resume-capsule/1",
      "dubsar.resume-capsule/2",
      "dubsar.resume-capsule/3",
      "dubsar.resume-capsule/4",
      "dubsar.review-ledger-view/1",
      "dubsar.workbench-catalog/1",
      "dubsar.workbench-continuity-data/3",
      "dubsar.workbench-graph/1",
      "dubsar.workbench-projects/1",
      "dubsar.workbench-view/1",
      "dubsar.workspace-snapshot/1",
    ],
  },
  {
    key: "personal-memory",
    name: "@dubsar/personal-memory",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-personal-memory",
    entrypoint: "packages/dubsar-personal-memory/src/index.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "fixed_windows_personal_advisory_memory",
    effects: {
      filesystem_read: "fixed_localappdata_dubsar_memory_five_markdown_files_only",
      filesystem_write: "initialize_exact_directory_or_append_one_confirmed_markdown_entry",
      environment: "localappdata_only",
      subprocess: "none",
      inbound_network: "none",
      outbound_network: "none",
      output: "bounded_preview_and_path_free_receipt",
    },
    formats: [
      "dubsar.personal-memory-init-apply/1",
      "dubsar.personal-memory-init-preview/1",
      "dubsar.personal-memory-update-apply/1",
      "dubsar.personal-memory-update-preview/1",
    ],
  },
  {
    key: "report",
    name: "@dubsar/workbench-report",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-workbench-report",
    entrypoint: "packages/dubsar-workbench-report/src/index.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "pure_static_renderer",
    effects: {
      filesystem_read: "none",
      filesystem_write: "none",
      environment: "none",
      subprocess: "none",
      inbound_network: "none",
      outbound_network: "none",
      output: "html_and_manifest_return_values",
    },
    formats: [
      "dubsar.review-ledger-report/1",
      "dubsar.workbench-catalog-interactive-data/1",
      "dubsar.workbench-catalog-interactive-report/1",
      "dubsar.workbench-continuity-interactive-data/2",
      "dubsar.workbench-continuity-interactive-data/3",
      "dubsar.workbench-continuity-interactive-data/4",
      "dubsar.workbench-continuity-interactive-report/2",
      "dubsar.workbench-continuity-interactive-report/3",
      "dubsar.workbench-continuity-interactive-report/4",
      "dubsar.workbench-interactive-data/2",
      "dubsar.workbench-interactive-report/2",
      "dubsar.workbench-report/1",
    ],
  },
  {
    key: "launcher",
    name: "@dubsar/workbench-launcher",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-workbench-launcher",
    entrypoint: "packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "explicit_local_report_launcher",
    effects: {
      filesystem_read: "explicit_registry_workspaces_and_optional_five_file_memory",
      filesystem_write: "fixed_localappdata_registry_single_html_and_explicit_desktop_start_menu_shortcuts",
      environment: "windows_known_folders_and_allowlisted_installation_paths",
      subprocess: "fixed_windows_powershell_bootstrap_picker_and_google_chrome_without_shell",
      inbound_network: "temporary_live_or_one_shot_ipv4_loopback_via_server_only",
      outbound_network: "none",
      output: "atomic_registry_html_shortcuts_error_dialog_and_chrome_via_loopback_or_file",
    },
    formats: [
      "dubsar.personal-memory-snapshot/1",
      "dubsar.workbench-catalog-launch/1",
      "dubsar.workbench-launch-check/1",
      "dubsar.workbench-launch-error/1",
      "dubsar.workbench-launch/1",
      "dubsar.workbench-project-management/1",
    ],
  },
  {
    key: "server",
    name: "@dubsar/workbench-server",
    version: PACKAGE_VERSION,
    root: "packages/dubsar-workbench-server",
    entrypoint: "packages/dubsar-workbench-server/src/index.mjs",
    package_interface: { kind: "exports", target: "./src/index.mjs" },
    capability_profile: "foreground_live_and_one_shot_loopback_transport",
    effects: {
      filesystem_read: "none",
      filesystem_write: "none",
      environment: "none",
      subprocess: "none",
      inbound_network: "foreground_live_or_one_shot_ipv4_loopback_listener",
      outbound_network: "none",
      output: "loopback_http_response_and_session_state",
    },
    formats: ["dubsar.workbench-session-closed/1"],
  },
]);

// The public Continuity runtime is a separately packaged product, but the
// internal Workbench Core and CLI delegate to these exact captured sources.
// Capture it as a support root without relabelling it as a Workbench component.
export const CONFORMANCE_SUPPORT_ROOTS = freeze([
  {
    key: "continuity-runtime",
    root: "packages/dubsar-project-continuity/runtime",
  },
]);

const identityBindings = freeze({
  cli: {
    path: "packages/dubsar-operator-cli/src/cli.mjs",
    binding: "OPERATOR_CLI_IDENTITY",
  },
  "codex-adapter": {
    path: "packages/dubsar-codex-workbench/src/index.mjs",
    binding: "CODEX_WORKBENCH_ADAPTER_IDENTITY",
  },
  core: {
    path: "packages/dubsar-operator-core/src/index.mjs",
    binding: "OPERATOR_CORE_IDENTITY",
  },
  "personal-memory": {
    path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
    binding: "PERSONAL_MEMORY_IDENTITY",
  },
  report: {
    path: "packages/dubsar-workbench-report/src/render.mjs",
    binding: "WORKBENCH_REPORT_RENDERER",
  },
  launcher: {
    path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
    binding: "WORKBENCH_LAUNCHER_IDENTITY",
  },
  server: {
    path: "packages/dubsar-workbench-server/src/server.mjs",
    binding: "WORKBENCH_SERVER_IDENTITY",
  },
});

const formatBindings = freeze({
  cli: [
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      binding: "CHECKPOINT_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      binding: "CHECKPOINT_EVIDENCE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      binding: "CHECKPOINT_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      binding: "CHECKPOINT_PROPOSAL_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/close-session.mjs",
      binding: "CLOSE_RESULT_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
      binding: "LITE_INIT_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
      binding: "LITE_INIT_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite.mjs",
      binding: "LITE_CHECKPOINTS_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite.mjs",
      binding: "LITE_PROPOSAL_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite.mjs",
      binding: "LITE_STATE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-session.mjs",
      binding: "MEMORY_COMMAND_RESULT_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-context.mjs",
      binding: "MEMORY_CONTEXT_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-snapshot-compiler.mjs",
      binding: "MEMORY_SNAPSHOT_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      binding: "MEMORY_RESUME_CAPSULE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      binding: "MEMORY_RESUME_CAPSULE_V4_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      binding: "MEMORY_CHECKPOINTS_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      binding: "MEMORY_KNOWLEDGE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      binding: "MEMORY_LOCAL_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      binding: "MEMORY_MANIFEST_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      binding: "MEMORY_WORK_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
      binding: "MEMORY_INIT_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
      binding: "MEMORY_INIT_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
      binding: "MEMORY_MIGRATION_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
      binding: "MEMORY_MIGRATION_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      binding: "MEMORY_INBOX_VIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      binding: "MEMORY_KNOWLEDGE_VIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      binding: "MEMORY_WORK_VIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
      binding: "MEMORY_CHANGE_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
      binding: "MEMORY_CHANGE_PREVIEW_FORMAT",
    },
  ],
  "codex-adapter": [
    {
      path: "packages/dubsar-codex-workbench/src/index.mjs",
      binding: "CODEX_CAPSULE_ERROR_FORMAT",
    },
  ],
  core: [
    {
      path: "packages/dubsar-project-continuity/runtime/artifact-lifecycle.mjs",
      binding: "ARTIFACT_LIFECYCLE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-router.mjs",
      binding: "MEMORY_ROUTE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      binding: "PROJECT_HISTORY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      binding: "PROJECT_LOTS_VIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      binding: "PROJECT_PRECEDENTS_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/capsule.mjs",
      binding: "PROJECT_RESUME_CAPSULE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      binding: "MEMORY_RESUME_CAPSULE_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      binding: "MEMORY_RESUME_CAPSULE_V4_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/capsule.mjs",
      binding: "RESUME_CAPSULE_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/catalog.mjs",
      binding: "WORKBENCH_CATALOG_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/catalog.mjs",
      binding: "WORKBENCH_CONTINUITY_DATA_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/project-registry.mjs",
      binding: "PROJECT_REGISTRY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/contracts.mjs",
      binding: "WORKBENCH_VIEW_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/graph-model.mjs",
      binding: "WORKBENCH_GRAPH_FORMAT",
    },
    {
      path: "packages/dubsar-operator-core/src/review-ledger.mjs",
      binding: "REVIEW_LEDGER_FORMAT",
    },
  ],
  "personal-memory": [
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      binding: "PERSONAL_MEMORY_INIT_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      binding: "PERSONAL_MEMORY_INIT_APPLY_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      binding: "PERSONAL_MEMORY_UPDATE_PREVIEW_FORMAT",
    },
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      binding: "PERSONAL_MEMORY_UPDATE_APPLY_FORMAT",
    },
  ],
  report: [
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      binding: "WORKBENCH_CATALOG_INTERACTIVE_DATA_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      binding: "WORKBENCH_CATALOG_INTERACTIVE_REPORT_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      binding: "WORKBENCH_CONTINUITY_INTERACTIVE_DATA_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      binding: "WORKBENCH_CONTINUITY_INTERACTIVE_REPORT_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/interactive.mjs",
      binding: "WORKBENCH_INTERACTIVE_DATA_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/interactive.mjs",
      binding: "WORKBENCH_INTERACTIVE_REPORT_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/render.mjs",
      binding: "WORKBENCH_REPORT_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-report/src/review-ledger.mjs",
      binding: "REVIEW_LEDGER_REPORT_FORMAT",
    },
  ],
  launcher: [
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      binding: "WORKBENCH_CATALOG_LAUNCH_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      binding: "WORKBENCH_PROJECT_MANAGEMENT_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      binding: "WORKBENCH_LAUNCH_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      binding: "WORKBENCH_LAUNCH_CHECK_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      binding: "WORKBENCH_LAUNCH_ERROR_FORMAT",
    },
    {
      path: "packages/dubsar-workbench-launcher/src/personal-memory.mjs",
      binding: "PERSONAL_MEMORY_FORMAT",
    },
  ],
});

const formatProducers = freeze({
  cli: [
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      function: "buildCheckpointChange",
      called_by_export: "previewCheckpoint",
      occurrences: 2,
      formats: ["dubsar.checkpoint-preview/1", "dubsar.project-evidence/2"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      function: "buildLotTransitionChange",
      called_by_export: "previewLotTransition",
      occurrences: 1,
      formats: ["dubsar.checkpoint-preview/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/checkpoint-writer.mjs",
      function: "publishOneFile",
      called_by_export: "applyCheckpoint",
      occurrences: 1,
      formats: ["dubsar.checkpoint-apply/1"],
    },
    {
      path: "packages/dubsar-operator-cli/src/cli.mjs",
      function: "runCli",
      exported: true,
      occurrences: 5,
      formats: [
        "dubsar.cli-error/1",
        "dubsar.doctor/1",
        "dubsar.location/1",
        "dubsar.review-ledger-ui-session/1",
        "dubsar.ui-session/1",
      ],
    },
    {
      path: "packages/dubsar-operator-cli/src/cli.mjs",
      function: "validationEnvelope",
      called_by_export: "runCli",
      occurrences: 1,
      formats: ["dubsar.validation/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/close-session.mjs",
      function: "runInteractiveClose",
      exported: true,
      occurrences: 3,
      formats: ["dubsar.checkpoint-proposal/1", "dubsar.close-result/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/close-session.mjs",
      function: "runLiteClose",
      occurrences: 3,
      formats: ["dubsar.close-result/1", "dubsar.continuity-checkpoint-proposal/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
      function: "initializationDocuments",
      occurrences: 2,
      formats: ["dubsar.continuity-checkpoints/1", "dubsar.continuity-state/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
      function: "buildInitialization",
      occurrences: 1,
      formats: ["dubsar.continuity-init-preview/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/lite-initializer.mjs",
      function: "applyLiteInitialization",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.continuity-init-apply/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-session.mjs",
      function: "runInteractiveMemory",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.personal-memory-command-result/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/close-session.mjs",
      function: "runMemoryClose",
      occurrences: 3,
      formats: ["dubsar.close-result/1", "dubsar.memory-change-proposal/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-context.mjs",
      function: "buildMemoryContext",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-context/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-snapshot-compiler.mjs",
      function: "compileMemorySnapshot",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-snapshot/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      function: "buildMemoryResumeCapsule",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.resume-capsule/3", "dubsar.resume-capsule/4"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      function: "assertMemoryManifest",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-project/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      function: "assertMemoryWork",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.work/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      function: "assertMemoryKnowledge",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.knowledge/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      function: "assertMemoryLocalState",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.local-state/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-contracts.mjs",
      function: "assertMemoryCheckpoints",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.continuity-checkpoints/2"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
      function: "buildInitialization",
      called_by_export: "previewMemoryInitialization",
      occurrences: 1,
      formats: ["dubsar.memory-init-preview/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-initializer.mjs",
      function: "applyMemoryInitialization",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-init-apply/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
      function: "buildMigration",
      called_by_export: "previewMemoryMigration",
      occurrences: 1,
      formats: ["dubsar.memory-migration-preview/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-migration.mjs",
      function: "applyMemoryMigration",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-migration-apply/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      function: "buildMemoryWorkView",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-work-view/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      function: "buildMemoryKnowledgeView",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-knowledge-view/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-views.mjs",
      function: "buildMemoryInboxView",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-inbox-view/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
      function: "buildChange",
      called_by_export: "previewMemoryChange",
      occurrences: 3,
      formats: [
        "dubsar.inbox-note/1",
        "dubsar.local-state/1",
        "dubsar.memory-change-preview/1",
      ],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-writer.mjs",
      function: "publishOneFile",
      called_by_export: "applyMemoryChange",
      occurrences: 1,
      formats: ["dubsar.memory-change-apply/1"],
    },
  ],
  "codex-adapter": [
    {
      path: "packages/dubsar-codex-workbench/skills/resume-dubsar-workbench/scripts/read-capsule.mjs",
      function: "fail",
      occurrences: 1,
      formats: ["dubsar.codex-capsule-error/1"],
    },
  ],
  core: [
    {
      path: "packages/dubsar-project-continuity/runtime/artifact-lifecycle.mjs",
      function: "deriveArtifactLifecycle",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.artifact-lifecycle/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-router.mjs",
      function: "buildMemoryRoute",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.memory-route/2"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      function: "buildProjectHistory",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.project-history/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      function: "buildProjectLotsView",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.project-lots-view/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/continuity-views.mjs",
      function: "buildProjectPrecedents",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.project-precedents/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/capsule.mjs",
      function: "buildResumeCapsule",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.resume-capsule/1"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/capsule.mjs",
      function: "buildProjectResumeCapsule",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.resume-capsule/2"],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/memory-vnext-capsule.mjs",
      function: "buildMemoryResumeCapsule",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.resume-capsule/3", "dubsar.resume-capsule/4"],
    },
    {
      path: "packages/dubsar-operator-core/src/catalog.mjs",
      function: "inspectProjectCatalog",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-catalog/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/catalog.mjs",
      function: "inspectProjectContinuityCatalog",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-continuity-data/3"],
    },
    {
      path: "packages/dubsar-operator-core/src/project-registry.mjs",
      function: "createProjectRegistry",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-projects/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/project-registry.mjs",
      function: "parseProjectRegistry",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-projects/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/graph-model.mjs",
      function: "buildWorkbenchGraph",
      exported: true,
      occurrences: 3,
      formats: ["dubsar.workbench-graph/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/graph-model.mjs",
      function: "unavailable",
      called_by_export: "buildWorkbenchGraph",
      occurrences: 1,
      formats: ["dubsar.workbench-graph/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/view-model.mjs",
      function: "buildWorkbenchView",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-view/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/snapshot.mjs",
      function: "captureWorkspaceSnapshot",
      called_by_export: "snapshotWorkspace",
      occurrences: 1,
      formats: ["dubsar.workspace-snapshot/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/review-ledger.mjs",
      function: "readReviewLedger",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.review-ledger-view/1"],
    },
    {
      path: "packages/dubsar-operator-core/src/review-ledger.mjs",
      function: "unavailableProjection",
      called_by_export: "readReviewLedger",
      occurrences: 1,
      formats: ["dubsar.review-ledger-view/1"],
    },
  ],
  "personal-memory": [
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      function: "preparePersonalMemoryInitialization",
      exported: true,
      occurrences: 2,
      formats: [
        "dubsar.personal-memory-init-apply/1",
        "dubsar.personal-memory-init-preview/1",
      ],
    },
    {
      path: "packages/dubsar-project-continuity/runtime/personal-memory.mjs",
      function: "preparePersonalMemoryAppend",
      exported: true,
      occurrences: 2,
      formats: [
        "dubsar.personal-memory-update-apply/1",
        "dubsar.personal-memory-update-preview/1",
      ],
    },
  ],
  report: [
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      function: "renderWorkbenchCatalogInteractiveReport",
      exported: true,
      occurrences: 2,
      formats: [
        "dubsar.workbench-catalog-interactive-data/1",
        "dubsar.workbench-catalog-interactive-report/1",
      ],
    },
    {
      path: "packages/dubsar-workbench-report/src/catalog-interactive.mjs",
      function: "renderWorkbenchContinuityInteractiveReport",
      exported: true,
      occurrences: 6,
      formats: [
        "dubsar.workbench-continuity-interactive-data/2",
        "dubsar.workbench-continuity-interactive-data/3",
        "dubsar.workbench-continuity-interactive-data/4",
        "dubsar.workbench-continuity-interactive-report/2",
        "dubsar.workbench-continuity-interactive-report/3",
        "dubsar.workbench-continuity-interactive-report/4",
      ],
    },
    {
      path: "packages/dubsar-workbench-report/src/interactive.mjs",
      function: "interactiveData",
      called_by_export: "renderWorkbenchInteractiveReport",
      occurrences: 1,
      formats: ["dubsar.workbench-interactive-data/2"],
    },
    {
      path: "packages/dubsar-workbench-report/src/interactive.mjs",
      function: "renderWorkbenchInteractiveReport",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-interactive-report/2"],
    },
    {
      path: "packages/dubsar-workbench-report/src/render.mjs",
      function: "renderWorkbenchReport",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.workbench-report/1"],
    },
    {
      path: "packages/dubsar-workbench-report/src/review-ledger.mjs",
      function: "renderReviewLedgerReport",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.review-ledger-report/1"],
    },
  ],
  launcher: [
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      function: "executeCatalogLaunch",
      called_by_export: "launchWorkbench",
      occurrences: 2,
      formats: [
        "dubsar.workbench-catalog-launch/1",
        "dubsar.workbench-launch-check/1",
      ],
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      function: "manageWorkbenchProjects",
      exported: true,
      occurrences: 2,
      formats: ["dubsar.workbench-project-management/1"],
    },
    {
      path: "packages/dubsar-workbench-launcher/src/launcher.mjs",
      function: "executeLaunch",
      called_by_export: "launchWorkbench",
      occurrences: 2,
      formats: [
        "dubsar.workbench-launch-check/1",
        "dubsar.workbench-launch/1",
      ],
    },
    {
      path: "packages/dubsar-workbench-launcher/bin/dubsar-workbench-open.mjs",
      function: "errorEnvelope",
      occurrences: 1,
      formats: ["dubsar.workbench-launch-error/1"],
    },
    {
      path: "packages/dubsar-workbench-launcher/src/personal-memory.mjs",
      function: "capturePersonalMemory",
      exported: true,
      occurrences: 1,
      formats: ["dubsar.personal-memory-snapshot/1"],
    },
  ],
  server: [
    {
      path: "packages/dubsar-workbench-server/src/server.mjs",
      function: "startServer",
      called_by_export: "startWorkbenchServer",
      occurrences: 2,
      formats: ["dubsar.workbench-session-closed/1"],
    },
  ],
});

export class ConformanceError extends Error {
  constructor(code, subject = null) {
    super(code);
    this.name = "ConformanceError";
    this.code = code;
    this.subject = subject;
  }
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sorted(values) {
  return [...values].sort(compareBytes);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${sorted(Object.keys(value))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

function exactKeys(value, expected, code, subject = null) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameValue(sorted(Object.keys(value)), sorted(expected))
  ) {
    throw new ConformanceError(code, subject);
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function samePhysicalPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function assertPortablePath(value, subject = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes(":") ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /[^A-Za-z0-9._/-]/u.test(value)
  ) {
    throw new ConformanceError("PATH_INVALID", subject);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED.test(segment) ||
        segment.normalize("NFC") !== segment,
    )
  ) {
    throw new ConformanceError("PATH_INVALID", subject);
  }
  return value;
}

function identityOf(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    nlink: String(stat.nlink),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  };
}

function sameFileIdentity(left, right) {
  return sameValue(identityOf(left), identityOf(right));
}

async function captureRegularFile(repositoryRoot, relativePath, limits = {}) {
  assertPortablePath(relativePath, relativePath);
  const maxBytes = limits.maxBytes ?? MAX_FILE_BYTES;
  const absolute = path.resolve(repositoryRoot, ...relativePath.split("/"));
  if (!isInside(repositoryRoot, absolute)) {
    throw new ConformanceError("PATH_OUTSIDE_REPOSITORY", relativePath);
  }
  const lexical = await lstat(absolute, { bigint: true });
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    throw new ConformanceError("FILE_TYPE_UNSAFE", relativePath);
  }
  const physical = await realpath(absolute);
  if (!samePhysicalPath(absolute, physical)) {
    throw new ConformanceError("FILE_PHYSICAL_ALIAS", relativePath);
  }
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.ino === 0n ||
      before.size < 0n ||
      before.size > BigInt(maxBytes) ||
      !sameFileIdentity(lexical, before)
    ) {
      throw new ConformanceError(
        before.nlink !== 1n ? "FILE_LINK_COUNT_UNSAFE" : "FILE_IDENTITY_UNSAFE",
        relativePath,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.length) !== before.size ||
      !sameFileIdentity(before, after)
    ) {
      throw new ConformanceError("FILE_CHANGED_DURING_READ", relativePath);
    }
    return {
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      identity: `${before.dev}:${before.ino}`,
      content: bytes,
    };
  } finally {
    await handle.close();
  }
}

async function assertDirectory(directory, repositoryRoot, subject) {
  const lexical = await lstat(directory, { bigint: true });
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new ConformanceError("DIRECTORY_TYPE_UNSAFE", subject);
  }
  const physical = await realpath(directory);
  if (!samePhysicalPath(directory, physical) || !isInside(repositoryRoot, physical)) {
    throw new ConformanceError("DIRECTORY_PHYSICAL_ALIAS", subject);
  }
  return lexical;
}

async function walkRoot(repositoryRoot, component, output, directories) {
  const root = path.resolve(repositoryRoot, ...component.root.split("/"));
  if (!isInside(repositoryRoot, root)) {
    throw new ConformanceError("ROOT_OUTSIDE_REPOSITORY", component.key);
  }

  async function walk(directory, portableDirectory) {
    const before = await assertDirectory(
      directory,
      repositoryRoot,
      portableDirectory,
    );
    directories.push({
      absolute: directory,
      portable: portableDirectory,
      identity: identityOf(before),
    });
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareBytes(left.name, right.name));
    for (const entry of entries) {
      const portable = `${portableDirectory}/${entry.name}`;
      assertPortablePath(portable, portable);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute, { bigint: true });
      if (info.isSymbolicLink()) {
        throw new ConformanceError("PATH_LINK_UNSAFE", portable);
      }
      if (info.isDirectory()) {
        await walk(absolute, portable);
      } else if (info.isFile()) {
        output.push(await captureRegularFile(repositoryRoot, portable));
      } else {
        throw new ConformanceError("FILE_TYPE_UNSAFE", portable);
      }
    }
  }

  await walk(root, component.root);
}

function roleFor(relativePath) {
  if (relativePath.endsWith("/README.md")) {
    return "documentation";
  }
  if (relativePath.endsWith("/package.json")) {
    return "metadata";
  }
  return "runtime";
}

export async function captureWorkbenchFiles(
  repositoryRoot = defaultRepositoryRoot,
  { includeContent = false } = {},
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const rootInfo = await assertDirectory(resolvedRoot, resolvedRoot, "repository");
  const files = [];
  const directories = [];
  for (const component of WORKBENCH_COMPONENTS) {
    await walkRoot(resolvedRoot, component, files, directories);
  }
  for (const support of CONFORMANCE_SUPPORT_ROOTS) {
    await walkRoot(resolvedRoot, support, files, directories);
  }
  files.sort((left, right) => compareBytes(left.path, right.path));
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new ConformanceError("FILE_COUNT_INVALID");
  }
  const pathKeys = new Set();
  const caseKeys = new Set();
  const identities = new Set();
  let totalBytes = 0;
  for (const file of files) {
    const caseKey = file.path.normalize("NFC").toLowerCase();
    if (pathKeys.has(file.path)) {
      throw new ConformanceError("FILE_PATH_DUPLICATE", file.path);
    }
    if (caseKeys.has(caseKey)) {
      throw new ConformanceError("FILE_PATH_CASE_COLLISION", file.path);
    }
    if (identities.has(file.identity)) {
      throw new ConformanceError("FILE_PHYSICAL_ALIAS", file.path);
    }
    pathKeys.add(file.path);
    caseKeys.add(caseKey);
    identities.add(file.identity);
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ConformanceError("TOTAL_SIZE_LIMIT_EXCEEDED");
    }
  }
  for (const directory of directories) {
    const after = await lstat(directory.absolute, { bigint: true });
    if (!sameValue(directory.identity, identityOf(after))) {
      throw new ConformanceError("DIRECTORY_CHANGED_DURING_READ", directory.portable);
    }
  }
  const rootAfter = await lstat(resolvedRoot, { bigint: true });
  if (!sameFileIdentity(rootInfo, rootAfter)) {
    throw new ConformanceError("REPOSITORY_CHANGED_DURING_READ");
  }
  return files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    role: roleFor(file.path),
    identity: file.identity,
    ...(includeContent ? { content: Buffer.from(file.content) } : {}),
  }));
}

function comparableCapture(files) {
  return files.map(({ path: filePath, bytes, sha256: digest, identity }) => ({
    path: filePath,
    bytes,
    sha256: digest,
    identity,
  }));
}

function publicInventory(files) {
  return files.map(({ path: filePath, bytes, sha256: digest, role }) => ({
    path: filePath,
    bytes,
    sha256: digest,
    role,
  }));
}

export function computeContentRoot(files) {
  const hash = createHash("sha256");
  hash.update(Buffer.from("dubsar.workbench-files/1\0", "utf8"));
  for (const file of files) {
    hash.update(Buffer.from(`${file.sha256}  ${file.path}\n`, "utf8"));
  }
  return hash.digest("hex");
}

function assertNoDuplicateJsonKeys(source) {
  let expression;
  try {
    const ast = parse(`(${source}\n)`, { ecmaVersion: "latest" });
    expression = ast.body.at(0)?.expression;
  } catch {
    throw new ConformanceError("MANIFEST_JSON_INVALID");
  }
  function visit(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type === "ObjectExpression") {
      const keys = new Set();
      for (const property of node.properties) {
        const key = property?.key?.value;
        if (
          property?.type !== "Property" ||
          property.computed ||
          property.kind !== "init" ||
          typeof key !== "string"
        ) {
          throw new ConformanceError("MANIFEST_JSON_INVALID");
        }
        if (keys.has(key)) {
          throw new ConformanceError("MANIFEST_KEY_DUPLICATE");
        }
        keys.add(key);
        visit(property.value);
      }
    } else if (node.type === "ArrayExpression") {
      for (const element of node.elements) {
        visit(element);
      }
    }
  }
  visit(expression);
}

async function loadManifest(repositoryRoot, sourceOverride) {
  let source;
  if (sourceOverride !== undefined) {
    if (typeof sourceOverride === "string") {
      source = sourceOverride;
    } else {
      source = `${JSON.stringify(sourceOverride)}\n`;
    }
  } else {
    const captured = await captureRegularFile(repositoryRoot, MANIFEST_PATH, {
      maxBytes: MAX_MANIFEST_BYTES,
    });
    source = captured.content.toString("utf8");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new ConformanceError("MANIFEST_SIZE_LIMIT_EXCEEDED");
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new ConformanceError("MANIFEST_JSON_INVALID");
  }
  assertNoDuplicateJsonKeys(source);
  return { manifest, digest: sha256(Buffer.from(source, "utf8")) };
}

function validateManifestSchema(manifest) {
  exactKeys(
    manifest,
    [
      "format",
      "authority",
      "scope",
      "source",
      "review",
      "policy",
      "components",
      "files",
      "content_root_sha256",
    ],
    "MANIFEST_SCHEMA_INVALID",
  );
  if (
    manifest.format !== "dubsar.workbench-conformance/1" ||
    manifest.authority !== "local_preparation_record" ||
    manifest.scope !== "local_workbench_with_explicit_checkpoint" ||
    !SHA256.test(manifest.content_root_sha256)
  ) {
    throw new ConformanceError("MANIFEST_IDENTITY_INVALID");
  }
  exactKeys(manifest.source, ["kind", "commit"], "SOURCE_SCHEMA_INVALID");
  if (manifest.source.kind !== "working_tree" || manifest.source.commit !== null) {
    throw new ConformanceError("SOURCE_STATE_INVALID");
  }
  exactKeys(manifest.review, ["status"], "REVIEW_SCHEMA_INVALID");
  if (manifest.review.status !== "pending") {
    throw new ConformanceError("REVIEW_STATE_INVALID");
  }
  exactKeys(manifest.policy, ["path", "sha256"], "POLICY_SCHEMA_INVALID");
  if (manifest.policy.path !== POLICY_PATH || !SHA256.test(manifest.policy.sha256)) {
    throw new ConformanceError("POLICY_IDENTITY_INVALID");
  }
  if (
    !Array.isArray(manifest.components) ||
    manifest.components.length !== WORKBENCH_COMPONENTS.length
  ) {
    throw new ConformanceError("COMPONENT_SET_INVALID");
  }
  for (const [index, component] of manifest.components.entries()) {
    exactKeys(
      component,
      [
        "key",
        "name",
        "version",
        "root",
        "entrypoint",
        "package_interface",
        "capability_profile",
        "effects",
        "formats",
      ],
      "COMPONENT_SCHEMA_INVALID",
      String(index),
    );
    exactKeys(
      component.package_interface,
      ["kind", "target"],
      "COMPONENT_INTERFACE_SCHEMA_INVALID",
      component.key,
    );
    exactKeys(
      component.effects,
      [
        "filesystem_read",
        "filesystem_write",
        "environment",
        "subprocess",
        "inbound_network",
        "outbound_network",
        "output",
      ],
      "COMPONENT_EFFECTS_SCHEMA_INVALID",
      component.key,
    );
    if (!Array.isArray(component.formats)) {
      throw new ConformanceError("COMPONENT_FORMATS_INVALID", component.key);
    }
  }
  if (!sameValue(manifest.components, WORKBENCH_COMPONENTS)) {
    throw new ConformanceError("COMPONENT_DECLARATION_MISMATCH");
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_FILES
  ) {
    throw new ConformanceError("FILE_INVENTORY_INVALID");
  }
  const paths = new Set();
  const casePaths = new Set();
  let previous = null;
  let totalBytes = 0;
  for (const [index, file] of manifest.files.entries()) {
    exactKeys(
      file,
      ["path", "bytes", "sha256", "role"],
      "FILE_SCHEMA_INVALID",
      String(index),
    );
    assertPortablePath(file.path, String(index));
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > MAX_FILE_BYTES ||
      !SHA256.test(file.sha256) ||
      !new Set(["documentation", "metadata", "runtime"]).has(file.role)
    ) {
      throw new ConformanceError("FILE_RECORD_INVALID", file.path);
    }
    if (file.role !== roleFor(file.path)) {
      throw new ConformanceError("FILE_ROLE_MISMATCH", file.path);
    }
    const casePath = file.path.normalize("NFC").toLowerCase();
    if (paths.has(file.path)) {
      throw new ConformanceError("FILE_PATH_DUPLICATE", file.path);
    }
    if (casePaths.has(casePath)) {
      throw new ConformanceError("FILE_PATH_CASE_COLLISION", file.path);
    }
    paths.add(file.path);
    casePaths.add(casePath);
    if (previous !== null && compareBytes(previous, file.path) >= 0) {
      throw new ConformanceError("FILE_ORDER_INVALID", file.path);
    }
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ConformanceError("TOTAL_SIZE_LIMIT_EXCEEDED");
    }
    previous = file.path;
  }
}

function walkAst(node, callback, parent = null) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (callback(node, parent) === false) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walkAst(child, callback, node);
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      walkAst(value, callback, node);
    }
  }
}

function parseCapturedModule(file, componentKey) {
  try {
    return parse(file.content.toString("utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    throw new ConformanceError("COMPONENT_SOURCE_PARSE_FAILED", componentKey);
  }
}

function capturedBinding(component, capturedFiles, definition) {
  const file = capturedFiles.find((entry) => entry.path === definition.path);
  if (!file || !file.content) {
    throw new ConformanceError("RUNTIME_BINDING_SOURCE_MISSING", component.key);
  }
  const ast = parseCapturedModule(file, component.key);
  const matches = [];
  for (const statement of ast.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration" ||
      statement.declaration.kind !== "const"
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      if (
        declaration.id?.type === "Identifier" &&
        declaration.id.name === definition.binding
      ) {
        matches.push(declaration.init);
      }
    }
  }
  if (matches.length !== 1) {
    throw new ConformanceError("RUNTIME_BINDING_INVALID", component.key);
  }
  return matches.at(0);
}

function observedIdentity(component, capturedFiles) {
  const initializer = capturedBinding(
    component,
    capturedFiles,
    identityBindings[component.key],
  );
  if (
    initializer?.type !== "CallExpression" ||
    initializer.arguments.length !== 1 ||
    initializer.callee?.type !== "MemberExpression" ||
    initializer.callee.computed ||
    initializer.callee.object?.type !== "Identifier" ||
    initializer.callee.object.name !== "Object" ||
    initializer.callee.property?.name !== "freeze" ||
    initializer.arguments.at(0)?.type !== "ObjectExpression"
  ) {
    throw new ConformanceError("RUNTIME_IDENTITY_INVALID", component.key);
  }
  const value = {};
  for (const property of initializer.arguments.at(0).properties) {
    const key = property?.key?.name ?? property?.key?.value;
    if (
      property?.type !== "Property" ||
      property.computed ||
      property.kind !== "init" ||
      !new Set(["name", "version"]).has(key) ||
      typeof property.value?.value !== "string" ||
      Object.hasOwn(value, key)
    ) {
      throw new ConformanceError("RUNTIME_IDENTITY_INVALID", component.key);
    }
    value[key] = property.value.value;
  }
  if (!sameValue(sorted(Object.keys(value)), ["name", "version"])) {
    throw new ConformanceError("RUNTIME_IDENTITY_INVALID", component.key);
  }
  return value;
}

function observedStringBinding(component, capturedFiles, definition) {
  const initializer = capturedBinding(component, capturedFiles, definition);
  if (typeof initializer?.value !== "string") {
    throw new ConformanceError("RUNTIME_FORMAT_BINDING_INVALID", component.key);
  }
  return initializer.value;
}

function topLevelFunction(ast, name, componentKey) {
  const matches = [];
  for (const statement of ast.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (
      declaration?.type === "FunctionDeclaration" &&
      declaration.id?.name === name
    ) {
      matches.push({ node: declaration, exported });
    }
  }
  if (matches.length !== 1) {
    throw new ConformanceError("RUNTIME_FORMAT_PRODUCER_INVALID", componentKey);
  }
  return matches.at(0);
}

function callsProducer(caller, producerName) {
  let found = false;
  walkAst(caller.node.body, (node) => {
    if (
      node !== caller.node.body &&
      new Set([
        "FunctionDeclaration",
        "FunctionExpression",
        "ArrowFunctionExpression",
      ]).has(node.type)
    ) {
      return false;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === producerName
    ) {
      found = true;
    }
    return undefined;
  });
  return found;
}

function formatValues(value, bindingValues, componentKey) {
  if (typeof value?.value === "string") return [value.value];
  if (value?.type === "Identifier" && bindingValues.has(value.name)) {
    return [bindingValues.get(value.name)];
  }
  if (value?.type === "ConditionalExpression") {
    return [
      ...formatValues(value.consequent, bindingValues, componentKey),
      ...formatValues(value.alternate, bindingValues, componentKey),
    ];
  }
  throw new ConformanceError("RUNTIME_FORMAT_PRODUCER_INVALID", componentKey);
}

function formatsInSources(component, capturedFiles) {
  const formats = new Set();
  const bindingValues = new Map();
  if (Object.hasOwn(formatBindings, component.key)) {
    for (const binding of formatBindings[component.key]) {
      bindingValues.set(
        binding.binding,
        observedStringBinding(component, capturedFiles, binding),
      );
    }
  }

  for (const definition of formatProducers[component.key]) {
    const file = capturedFiles.find((entry) => entry.path === definition.path);
    if (!file?.content) {
      throw new ConformanceError("RUNTIME_FORMAT_SOURCE_MISSING", component.key);
    }
    const ast = parseCapturedModule(file, component.key);
    const producer = topLevelFunction(ast, definition.function, component.key);
    if (definition.exported === true && producer.exported !== true) {
      throw new ConformanceError("RUNTIME_FORMAT_PRODUCER_INVALID", component.key);
    }
    if (typeof definition.called_by_export === "string") {
      const caller = topLevelFunction(
        ast,
        definition.called_by_export,
        component.key,
      );
      if (!caller.exported || !callsProducer(caller, definition.function)) {
        throw new ConformanceError("RUNTIME_FORMAT_PRODUCER_INVALID", component.key);
      }
    }

    const observed = [];
    walkAst(producer.node.body, (node) => {
      if (node.type !== "ObjectExpression") {
        return undefined;
      }
      for (const property of node.properties) {
        const key = property?.key?.name ?? property?.key?.value;
        if (
          property?.type !== "Property" ||
          property.computed ||
          property.kind !== "init" ||
          key !== "format"
        ) {
          continue;
        }
        observed.push(...formatValues(property.value, bindingValues, component.key));
      }
      return undefined;
    });
    if (
      observed.length !== definition.occurrences ||
      !sameValue(sorted(new Set(observed)), definition.formats)
    ) {
      throw new ConformanceError("RUNTIME_FORMAT_PRODUCER_INVALID", component.key);
    }
    for (const value of observed) {
      formats.add(value);
    }
  }
  return sorted(formats);
}

function packageMetadataFor(component, capturedFiles) {
  const packagePath = `${component.root}/package.json`;
  const file = capturedFiles.find((entry) => entry.path === packagePath);
  if (!file) {
    throw new ConformanceError("PACKAGE_METADATA_MISSING", component.key);
  }
  let metadata;
  try {
    metadata = JSON.parse(file.content.toString("utf8"));
  } catch {
    throw new ConformanceError("PACKAGE_METADATA_INVALID", component.key);
  }
  const target =
    component.package_interface.kind === "exports"
      ? metadata.exports
      : metadata.bin?.dubsar;
  if (
    metadata.name !== component.name ||
    metadata.version !== component.version ||
    metadata.private !== true ||
    metadata.type !== "module" ||
    metadata.engines?.node !== ">=20" ||
    target !== component.package_interface.target
  ) {
    throw new ConformanceError("PACKAGE_METADATA_MISMATCH", component.key);
  }
  return {
    name: metadata.name,
    version: metadata.version,
    interface: {
      kind: component.package_interface.kind,
      target,
    },
  };
}

async function loadCapturedRuntimeGate(policyDigest) {
  const url = new URL(policyModuleUrl.href);
  url.searchParams.set("sha256", policyDigest);
  const loaded = await import(url.href);
  if (typeof loaded.checkWorkbenchRuntime !== "function") {
    throw new ConformanceError("RUNTIME_POLICY_EXPORT_MISSING");
  }
  return loaded.checkWorkbenchRuntime;
}

async function observeRuntime(repositoryRoot, capturedFiles, policyDigest) {
  const components = [];
  for (const component of WORKBENCH_COMPONENTS) {
    const metadata = packageMetadataFor(component, capturedFiles);
    const identity = observedIdentity(component, capturedFiles);
    if (!sameValue(identity, { name: component.name, version: component.version })) {
      throw new ConformanceError("RUNTIME_IDENTITY_MISMATCH", component.key);
    }
    const formats = formatsInSources(component, capturedFiles);
    if (!sameValue(formats, component.formats)) {
      throw new ConformanceError("RUNTIME_FORMATS_MISMATCH", component.key);
    }
    components.push({ key: component.key, metadata, identity, formats });
  }
  const checkWorkbenchRuntime = await loadCapturedRuntimeGate(policyDigest);
  const runtimeGate = await checkWorkbenchRuntime(repositoryRoot);
  if (
    runtimeGate.status !== "pass" ||
    runtimeGate.findings.length !== 0 ||
    !sameValue(
      sorted(runtimeGate.roots),
      sorted([
        ...WORKBENCH_COMPONENTS.map((item) => item.root),
        ...CONFORMANCE_SUPPORT_ROOTS.map((item) => item.root),
      ]),
    )
  ) {
    throw new ConformanceError("RUNTIME_GATE_FAILED");
  }
  return {
    components,
    runtime_gate: {
      status: runtimeGate.status,
      roots: runtimeGate.roots,
      finding_count: runtimeGate.findings.length,
    },
  };
}

async function captureStableInputs(repositoryRoot, betweenCaptures) {
  const first = await captureWorkbenchFiles(repositoryRoot, { includeContent: true });
  if (betweenCaptures !== undefined) {
    await betweenCaptures();
  }
  const second = await captureWorkbenchFiles(repositoryRoot, { includeContent: true });
  if (!sameValue(comparableCapture(first), comparableCapture(second))) {
    throw new ConformanceError("SOURCE_CHANGED_BETWEEN_CAPTURES");
  }
  const firstPolicy = await captureRegularFile(defaultRepositoryRoot, POLICY_PATH);
  const secondPolicy = await captureRegularFile(defaultRepositoryRoot, POLICY_PATH);
  if (!sameValue(comparableCapture([firstPolicy]), comparableCapture([secondPolicy]))) {
    throw new ConformanceError("POLICY_CHANGED_BETWEEN_CAPTURES");
  }
  return { files: second, policy: secondPolicy };
}

async function assertStableAfterRuntime(repositoryRoot, baselineFiles, baselinePolicy) {
  const files = await captureWorkbenchFiles(repositoryRoot, { includeContent: true });
  const policy = await captureRegularFile(defaultRepositoryRoot, POLICY_PATH);
  if (!sameValue(comparableCapture(files), comparableCapture(baselineFiles))) {
    throw new ConformanceError("SOURCE_CHANGED_DURING_RUNTIME_OBSERVATION");
  }
  if (!sameValue(comparableCapture([policy]), comparableCapture([baselinePolicy]))) {
    throw new ConformanceError("POLICY_CHANGED_DURING_RUNTIME_OBSERVATION");
  }
}

export async function buildWorkingTreeManifest(
  repositoryRoot = defaultRepositoryRoot,
) {
  const resolvedRoot = path.resolve(repositoryRoot);
  const { files, policy } = await captureStableInputs(resolvedRoot);
  await observeRuntime(resolvedRoot, files, policy.sha256);
  await assertStableAfterRuntime(resolvedRoot, files, policy);
  const inventory = publicInventory(files);
  return {
    format: "dubsar.workbench-conformance/1",
    authority: "local_preparation_record",
    scope: "local_workbench_with_explicit_checkpoint",
    source: { kind: "working_tree", commit: null },
    review: { status: "pending" },
    policy: { path: POLICY_PATH, sha256: policy.sha256 },
    components: WORKBENCH_COMPONENTS,
    files: inventory,
    content_root_sha256: computeContentRoot(inventory),
  };
}

function safeFinding(error) {
  if (error instanceof ConformanceError) {
    const safeSubject =
      typeof error.subject === "string" &&
      (new Set(["cli", "codex-adapter", "continuity-runtime", "core", "launcher", "personal-memory", "report", "server", "repository"]).has(
        error.subject,
      ) || /^\d{1,3}$/u.test(error.subject))
        ? error.subject
        : null;
    return {
      code: error.code,
      state: "fail",
      ...(safeSubject === null ? {} : { subject: safeSubject }),
    };
  }
  return { code: "CONFORMANCE_CHECK_FAILED", state: "unknown" };
}

export async function checkWorkbenchConformance({
  repositoryRoot = defaultRepositoryRoot,
  mode = "development",
  manifestSource,
  betweenCaptures,
  beforeRuntimeObservation,
} = {}) {
  if (!new Set(["development", "release"]).has(mode)) {
    throw new ConformanceError("MODE_INVALID");
  }
  const resolvedRoot = path.resolve(repositoryRoot);
  let manifest = null;
  let manifestDigest = null;
  let manifestSchemaValidated = false;
  let observed = null;
  try {
    const loaded = await loadManifest(resolvedRoot, manifestSource);
    manifest = loaded.manifest;
    manifestDigest = loaded.digest;
    validateManifestSchema(manifest);
    manifestSchemaValidated = true;
    const { files, policy } = await captureStableInputs(
      resolvedRoot,
      betweenCaptures,
    );
    const inventory = publicInventory(files);
    if (!sameValue(manifest.files, inventory)) {
      throw new ConformanceError("FILE_INVENTORY_MISMATCH");
    }
    const contentRoot = computeContentRoot(inventory);
    if (manifest.content_root_sha256 !== contentRoot) {
      throw new ConformanceError("CONTENT_ROOT_MISMATCH");
    }
    if (manifest.policy.sha256 !== policy.sha256) {
      throw new ConformanceError("POLICY_DIGEST_MISMATCH");
    }
    if (beforeRuntimeObservation !== undefined) {
      await beforeRuntimeObservation();
    }
    const runtime = await observeRuntime(resolvedRoot, files, policy.sha256);
    await assertStableAfterRuntime(resolvedRoot, files, policy);
    observed = {
      content_root_sha256: contentRoot,
      policy: { path: POLICY_PATH, sha256: policy.sha256 },
      ...runtime,
    };
    const releaseFindings = [
      { code: "SOURCE_NOT_COMMITTED", state: mode === "release" ? "blocked" : "warn" },
      { code: "COMMIT_BLOB_PROOF_MISSING", state: mode === "release" ? "blocked" : "warn" },
      { code: "HUMAN_REVIEW_PENDING", state: mode === "release" ? "blocked" : "warn" },
      { code: "SOURCE_BUNDLE_PROBE_NOT_RELEASE_EVIDENCE", state: mode === "release" ? "blocked" : "warn" },
      ...(process.platform === "win32"
        ? [
            {
              code: "WINDOWS_REPARSE_ATTRIBUTES_UNPROVEN",
              state: mode === "release" ? "blocked" : "warn",
            },
          ]
        : []),
    ];
    return {
      format: "dubsar.workbench-conformance-report/1",
      mode,
      status: mode === "release" ? "blocked" : "warn",
      conformant: true,
      release_ready: false,
      findings: releaseFindings,
      manifest_sha256: manifestDigest,
      declared: {
        source: manifest.source,
        review: manifest.review,
        component_count: manifest.components.length,
        file_count: manifest.files.length,
        content_root_sha256: manifest.content_root_sha256,
      },
      observed,
    };
  } catch (error) {
    return {
      format: "dubsar.workbench-conformance-report/1",
      mode,
      status: error instanceof ConformanceError ? "fail" : "unknown",
      conformant: false,
      release_ready: false,
      findings: [safeFinding(error)],
      manifest_sha256: manifestDigest,
      declared:
        !manifestSchemaValidated
          ? null
          : {
              source: manifest.source,
              review: manifest.review,
              component_count: manifest.components.length,
              file_count: manifest.files.length,
              content_root_sha256: manifest.content_root_sha256,
            },
      observed,
    };
  }
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--write") {
    return { action: "write" };
  }
  if (argv.length !== 2 || argv[0] !== "--mode") {
    throw new ConformanceError("ARGUMENTS_INVALID");
  }
  if (!new Set(["development", "release"]).has(argv[1])) {
    throw new ConformanceError("MODE_INVALID");
  }
  return { action: "check", mode: argv[1] };
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let report;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.action === "write") {
      const manifest = await buildWorkingTreeManifest();
      const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(path.join(defaultRepositoryRoot, MANIFEST_PATH), bytes, {
        encoding: "utf8",
        flag: "w",
      });
      report = {
        format: "dubsar.workbench-conformance-write/1",
        status: "written",
        file_count: manifest.files.length,
        content_root_sha256: manifest.content_root_sha256,
      };
    } else {
      report = await checkWorkbenchConformance({ mode: options.mode });
    }
  } catch (error) {
    report = {
      format: "dubsar.workbench-conformance-report/1",
      mode: "unknown",
      status: "fail",
      conformant: false,
      release_ready: false,
      findings: [safeFinding(error)],
      manifest_sha256: null,
      declared: null,
      observed: null,
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.format === "dubsar.workbench-conformance-report/1" &&
    (!report.conformant || report.mode === "release")
  ) {
    process.exitCode = 1;
  }
}
