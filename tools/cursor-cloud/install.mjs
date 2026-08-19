import {
  CURSOR_CLOUD_INSTALL_FORMAT,
  CursorCloudError,
  REQUIRED_INSTALL_CAPABILITIES,
  REPOSITORY_ROOT,
  RUNTIME_RELATIVE_BIN,
  assertSupportedNode,
  errorDocument,
  invokeDubsar,
  isMainModule,
  parseBoundedJson,
  printJson,
  requireCapabilities,
  requireFormat,
  resolveRuntimeBin,
} from "./runtime.mjs";

export async function installEnvironment({
  repositoryRoot = REPOSITORY_ROOT,
  runtimeBin,
} = {}) {
  const node_major = assertSupportedNode();
  const bin = runtimeBin ?? await resolveRuntimeBin(repositoryRoot);
  const invoked = await invokeDubsar({
    bin,
    args: ["capabilities", "--json"],
    cwd: repositoryRoot,
  });
  if (invoked.exitCode !== 0) {
    throw new CursorCloudError("CURSOR_CLOUD_CAPABILITY_MISSING");
  }
  const capabilities = parseBoundedJson(invoked.stdout);
  requireFormat(capabilities, "dubsar.runtime-capabilities/1");
  requireCapabilities(capabilities.capabilities, REQUIRED_INSTALL_CAPABILITIES);
  if (capabilities.runtime?.minimum_node_major !== 20) {
    throw new CursorCloudError("CURSOR_CLOUD_FORMAT_INVALID");
  }
  return {
    format: CURSOR_CLOUD_INSTALL_FORMAT,
    status: "ready",
    node_major,
    runtime: RUNTIME_RELATIVE_BIN,
    producer: capabilities.producer,
    capabilities: REQUIRED_INSTALL_CAPABILITIES,
    path_resolution: "repository",
    daemons: false,
    network: false,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = printJson(await installEnvironment());
  } catch (error) {
    process.exitCode = printJson(errorDocument(error), { exitCode: 1 });
  }
}
