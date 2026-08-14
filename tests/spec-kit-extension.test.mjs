import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildExtensionArtifact } from "../tools/build-spec-kit-extension.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION = path.join(REPOSITORY_ROOT, "integrations", "spec-kit", "dubsar-memory");
const RUNTIME = path.join(REPOSITORY_ROOT, "packages", "dubsar-project-continuity", "bin", "dubsar.mjs");
const STATUS = path.join(EXTENSION, "scripts", "dubsar-speckit-status.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The status script resolves its runtime at <extension>/runtime/bin/dubsar.mjs.
 * In the working tree that directory does not exist — the packaging step
 * creates it — so tests run the script from a staged copy that links the
 * repository runtime into place.
 */
async function stageExtension(t) {
  const staged = await mkdtemp(path.join(os.tmpdir(), "dubsar-ext-"));
  t.after(() => rm(staged, { recursive: true, force: true }));
  await mkdir(path.join(staged, "scripts"), { recursive: true });
  await mkdir(path.join(staged, "runtime", "bin"), { recursive: true });
  await mkdir(path.join(staged, "runtime", "runtime"), { recursive: true });
  await writeFile(
    path.join(staged, "scripts", "dubsar-speckit-status.mjs"),
    await readFile(STATUS, "utf8"),
    "utf8",
  );
  // Mirror the packaged layout exactly: the script imports DUBSAR's own
  // safe-capture and path-safety modules from runtime/runtime/.
  const packageRoot = path.join(REPOSITORY_ROOT, "packages", "dubsar-project-continuity");
  await writeFile(
    path.join(staged, "runtime", "bin", "dubsar.mjs"),
    await readFile(path.join(packageRoot, "bin", "dubsar.mjs"), "utf8"),
    "utf8",
  );
  for (const name of await readdir(path.join(packageRoot, "runtime"))) {
    if (!name.endsWith(".mjs")) continue;
    await writeFile(
      path.join(staged, "runtime", "runtime", name),
      await readFile(path.join(packageRoot, "runtime", name)),
    );
  }
  return path.join(staged, "scripts", "dubsar-speckit-status.mjs");
}

function status(script, projectRoot) {
  const result = spawnSync(process.execPath, [script, projectRoot], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { exitCode: result.status, value: JSON.parse(result.stdout) };
}

function dubsar(argv) {
  const result = spawnSync(process.execPath, [RUNTIME, ...argv], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    value: result.stdout ? JSON.parse(result.stdout) : JSON.parse(result.stderr || "{}"),
  };
}

async function specKitProject(t, { feature = "specs/003-auth", pointer = true, files = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-speckit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".specify"), { recursive: true });
  if (feature !== null) {
    await mkdir(path.join(root, feature), { recursive: true });
    const contents = files ?? {
      "spec.md": "# Specification\n",
      "plan.md": "# Plan\n",
      "tasks.md": "# Tasks\n\n- [ ] first\n",
    };
    for (const [name, body] of Object.entries(contents)) {
      await writeFile(path.join(root, feature, name), body, "utf8");
    }
  }
  if (pointer !== false) {
    await writeFile(
      path.join(root, ".specify", "feature.json"),
      typeof pointer === "string" ? pointer : JSON.stringify({ feature_directory: feature }),
      "utf8",
    );
  }
  return root;
}

async function initialiseMemory(t, root, { workId = "w-auth" } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "dubsar-prop-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(temp, name);
    await writeFile(file, JSON.stringify(value), "utf8");
    return file;
  };
  const apply = async (argv, file) => {
    const preview = dubsar([...argv, "--proposal", file, "--json"]);
    assert.equal(preview.exitCode, 0, JSON.stringify(preview.value));
    const applied = dubsar([
      ...argv, "--proposal", file, "--apply",
      "--expected-change", preview.value.change_sha256, "--json",
    ]);
    assert.equal(applied.exitCode, 0, JSON.stringify(applied.value));
  };

  await apply(["init", "--start", root], await write("init.json", {
    format: "dubsar.memory-init-proposal/1",
    project_id: "speckit-project",
    title: "Spec Kit project",
  }));
  await apply(["work", "create", "--start", root], await write("work.json", {
    format: "dubsar.memory-change-proposal/1",
    project_id: "speckit-project",
    operation: "work_create",
    payload: {
      work: {
        format: "dubsar.work/1",
        work_id: workId,
        title: "Authentication",
        status: "open",
        scope: "bounded",
        objective: "Ship the authentication feature.",
        acceptance_criteria: ["The feature is specified."],
        knowledge_ids: [],
        references: [],
      },
      body: "Advisory notes.\n",
    },
  }));
  const select = dubsar(["work", "select", "--start", root, "--work", workId, "--json"]);
  dubsar([
    "work", "select", "--start", root, "--work", workId,
    "--apply", "--expected-change", select.value.change_sha256, "--json",
  ]);
  return { temp, write, apply };
}

async function linkDocument(t, root, helpers, relativePath, checkpointId = "cp-linked") {
  const bytes = await readFile(path.join(root, relativePath));
  const file = await helpers.write(`${checkpointId}.json`, {
    format: "dubsar.memory-change-proposal/1",
    project_id: "speckit-project",
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: checkpointId,
        work_id: "w-auth",
        kind: "decision",
        summary: "Specification accepted for the authentication feature.",
        references: [{ path: relativePath.replaceAll("\\", "/"), sha256: sha256(bytes) }],
        validation: ["Reviewed with the human operator"],
        limitations: ["Task state remains owned by Spec Kit"],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: "Specification accepted.",
          blockers: [],
          next_action: "Begin the first recorded task.",
        },
      },
    },
  });
  await helpers.apply(["checkpoint", "--start", root], file);
  return file;
}

test("a valid Spec Kit project is detected with its three canonical documents", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const { value } = status(script, root);

  assert.equal(value.status, "ok");
  assert.equal(value.spec_kit.detected, true);
  assert.equal(value.spec_kit.feature_directory, "specs/003-auth");
  assert.equal(value.spec_kit.feature_source, ".specify/feature.json");
  assert.deepEqual(value.documents.map((item) => item.role),
    ["specification", "plan", "tasks"]);
  assert.equal(value.documents.every((item) => item.referenceable), true);
  // The digest is captured through DUBSAR's safe path, and no content travels.
  assert.equal(value.documents.every((item) => /^[0-9a-f]{64}$/u.test(item.captured_sha256)), true);
  assert.equal(JSON.stringify(value).includes("# Specification"), false,
    "document content must never appear in the status output");
  // No completion percentage is ever derived from tasks.md checkboxes.
  assert.equal(value.progress, null);
});

test("a project without Spec Kit stops cleanly and is not an error state", async (t) => {
  const script = await stageExtension(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "dubsar-plain-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { exitCode, value } = status(script, root);
  assert.equal(exitCode, 0, "a missing Spec Kit project is not a failure");
  assert.equal(value.status, "no_spec_kit_project");
  assert.deepEqual(await readdir(root), [], "nothing was created");
});

test("a malformed or absent feature pointer is reported, never guessed", async (t) => {
  const script = await stageExtension(t);

  const missing = await specKitProject(t, { pointer: JSON.stringify({ feature_directory: "specs/999-gone" }) });
  assert.equal(status(script, missing).value.spec_kit.feature_issue, "FEATURE_DIRECTORY_MISSING");

  const unsafe = await specKitProject(t, { pointer: JSON.stringify({ feature_directory: "../escape" }) });
  assert.equal(status(script, unsafe).value.spec_kit.feature_issue, "FEATURE_POINTER_UNSAFE");

  const broken = await specKitProject(t, { pointer: "{ not json" });
  const brokenValue = status(script, broken).value;
  assert.equal(brokenValue.spec_kit.feature_directory, "specs/003-auth",
    "a single unambiguous feature is still resolvable without the pointer");

  const ambiguous = await specKitProject(t, { pointer: false });
  await mkdir(path.join(ambiguous, "specs", "004-billing"), { recursive: true });
  assert.equal(status(script, ambiguous).value.spec_kit.feature_issue, "FEATURE_AMBIGUOUS");
  assert.deepEqual(status(script, ambiguous).value.documents, []);
});

test("a document present but never recorded is unlinked, never fresh", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  await initialiseMemory(t, root);

  const { value } = status(script, root);
  assert.equal(value.dubsar.present, true);
  for (const document of value.documents) {
    assert.equal(document.status, "unlinked", `${document.role} must not claim freshness`);
    assert.deepEqual(document.linked_by, []);
  }
});

test("a recorded document is fresh, then stale when changed, then missing when removed", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const helpers = await initialiseMemory(t, root);
  const relative = "specs/003-auth/spec.md";
  await linkDocument(t, root, helpers, relative);

  const specification = () => status(script, root).value.documents
    .find((item) => item.role === "specification");

  const fresh = specification();
  assert.equal(fresh.status, "fresh");
  assert.deepEqual(fresh.linked_by, ["cp-linked"]);
  // The other two were never recorded and must stay unlinked.
  assert.equal(status(script, root).value.documents
    .filter((item) => item.status === "unlinked").length, 2);

  await writeFile(path.join(root, relative), "# Specification (revised)\n", "utf8");
  assert.equal(specification().status, "stale");

  await rm(path.join(root, relative), { force: true });
  assert.equal(specification().status, "missing");
});

test("reading the status writes nothing into the project", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const helpers = await initialiseMemory(t, root);
  await linkDocument(t, root, helpers, "specs/003-auth/spec.md");

  const fingerprint = async () => {
    const seen = [];
    const walk = async (directory) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
        (left, right) => (left.name < right.name ? -1 : 1),
      )) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(absolute); continue; }
        seen.push(`${path.relative(root, absolute).replaceAll("\\", "/")}:${sha256(await readFile(absolute))}`);
      }
    };
    await walk(root);
    return seen.join("\n");
  };

  const before = await fingerprint();
  status(script, root);
  status(script, root);
  assert.equal(await fingerprint(), before, "no file changed while reading");
});

test("a checkpoint is refused without the exact confirmed digest", async (t) => {
  const root = await specKitProject(t);
  const helpers = await initialiseMemory(t, root);
  const relative = "specs/003-auth/spec.md";
  const bytes = await readFile(path.join(root, relative));
  const proposal = await helpers.write("refused.json", {
    format: "dubsar.memory-change-proposal/1",
    project_id: "speckit-project",
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: "cp-refused",
        work_id: "w-auth",
        kind: "progress",
        summary: "An unconfirmed record must not land.",
        references: [{ path: relative, sha256: sha256(bytes) }],
        validation: ["Reviewed"],
        limitations: ["None"],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: "State recorded.",
          blockers: [],
          next_action: "Continue.",
        },
      },
    },
  });

  const preview = dubsar(["checkpoint", "--start", root, "--proposal", proposal, "--json"]);
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.value.status, "preview");

  const forged = dubsar([
    "checkpoint", "--start", root, "--proposal", proposal,
    "--apply", "--expected-change", "0".repeat(64), "--json",
  ]);
  assert.equal(forged.exitCode, 1);
  assert.equal(forged.value.code, "MEMORY_CHANGE_CONFIRMATION_MISMATCH");

  const history = dubsar(["history", "--start", root, "--json"]);
  assert.equal(history.value.entries.some((item) => item.evidence_id === "cp-refused"), false,
    "the refused checkpoint was never recorded");
});

test("the extension declares no hook, server, MCP, or local path", async (t) => {
  const manifest = await readFile(path.join(EXTENSION, "extension.yml"), "utf8");

  // Hooks are the mechanism that would make DUBSAR run on a Spec Kit event.
  assert.equal(/^hooks:/mu.test(manifest), false, "no hooks section");
  for (const event of ["before_specify", "after_plan", "after_tasks", "after_implement"]) {
    assert.equal(manifest.includes(event), false, `no ${event} hook`);
  }
  assert.match(manifest, /^extension:\n  id: dubsar$/mu);
  assert.match(manifest, /license: MIT/u);

  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      files.push(absolute);
    }
  };
  await walk(EXTENSION);
  assert.ok(files.length >= 5);

  for (const file of files) {
    if (file.endsWith("LICENSE")) continue;
    const text = await readFile(file, "utf8");
    const name = path.relative(EXTENSION, file);
    assert.equal(/[A-Za-z]:\\{1,2}Users/u.test(text), false, `${name} leaks a Windows path`);
    assert.equal(/\/home\/[a-z]|\/Users\/[A-Za-z]/u.test(text), false, `${name} leaks a home path`);
    assert.equal(/mcpServers|listen\(|createServer|http:\/\/(?!127)/u.test(text), false,
      `${name} must not introduce a server or MCP`);
  }
});

test("every declared command file exists and carries the required frontmatter", async () => {
  const manifest = await readFile(path.join(EXTENSION, "extension.yml"), "utf8");
  const declared = [...manifest.matchAll(/- name: (speckit\.[a-z0-9.-]+)\n\s+file: (\S+)/gu)]
    .map(([, name, file]) => ({ name, file }));

  assert.equal(declared.length, 2, "the prototype ships exactly two commands");
  for (const { name, file } of declared) {
    // Spec Kit enforces speckit.{extension-id}.{command}.
    assert.match(name, /^speckit\.dubsar\.[a-z0-9-]+$/u);
    const body = await readFile(path.join(EXTENSION, file), "utf8");
    assert.match(body, /^---\ndescription: .+\n---\n/u, `${file} needs description frontmatter`);
    assert.match(body, /\$ARGUMENTS/u, `${file} must accept user input`);
    // The runtime is always resolved from the extension, never from PATH.
    assert.match(body, /extension-root/u);
    assert.equal(/\bPATH\b(?![^.]*[Nn]ever)/u.test(body.replace(/Never resolve[^.]*\./gu, "")), false,
      `${file} must not suggest resolving through PATH`);
  }
});

test("the packaged artifact is deterministic and carries no accidental file", async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "dubsar-dist-"));
  t.after(() => rm(target, { recursive: true, force: true }));

  const first = await buildExtensionArtifact({ outputDirectory: target });
  const second = await buildExtensionArtifact({ outputDirectory: target });
  assert.equal(first.artifact_sha256, second.artifact_sha256, "two builds must be identical");
  assert.equal(first.runtime_files > 0, true, "the sealed runtime travels with the extension");

  const archive = (await readFile(path.join(target, "dubsar-memory-extension.zip")))
    .toString("latin1");
  for (const expected of [
    "extension.yml",
    "commands/speckit.dubsar.resume.md",
    "commands/speckit.dubsar.checkpoint.md",
    "scripts/dubsar-speckit-status.mjs",
    "runtime/bin/dubsar.mjs",
    "runtime/runtime/memory-vnext-freshness.mjs",
  ]) {
    assert.ok(archive.includes(expected), `${expected} must ship`);
  }
  for (const forbidden of [
    "node_modules", "PROVENANCE.json", ".test.mjs", ".claude-plugin", ".codex-plugin",
  ]) {
    assert.equal(archive.includes(forbidden), false, `${forbidden} must not ship`);
  }
});

test("SPECIFY_FEATURE_DIRECTORY takes priority over .specify/feature.json", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  await mkdir(path.join(root, "specs", "004-billing"), { recursive: true });
  await writeFile(path.join(root, "specs", "004-billing", "spec.md"), "# Billing\n", "utf8");

  const pointed = status(script, root).value;
  assert.equal(pointed.spec_kit.feature_source, ".specify/feature.json");
  assert.equal(pointed.spec_kit.feature_directory, "specs/003-auth");

  const overridden = spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SPECIFY_FEATURE_DIRECTORY: "specs/004-billing" },
  });
  const value = JSON.parse(overridden.stdout);
  assert.equal(value.spec_kit.feature_source, "SPECIFY_FEATURE_DIRECTORY");
  assert.equal(value.spec_kit.feature_directory, "specs/004-billing");

  // An unsafe value in the environment is refused, not honoured.
  const escaped = spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SPECIFY_FEATURE_DIRECTORY: "../elsewhere" },
  });
  assert.equal(JSON.parse(escaped.stdout).spec_kit.feature_issue, "FEATURE_POINTER_UNSAFE");
});

test("the first journey runs init, work, selection, and checkpoint as four separate writes", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const temp = await mkdtemp(path.join(os.tmpdir(), "dubsar-first-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(temp, name);
    await writeFile(file, JSON.stringify(value), "utf8");
    return file;
  };

  // 1. No workspace at all.
  const initial = status(script, root).value;
  assert.equal(initial.dubsar.present, false);
  assert.equal(initial.dubsar.reason, "WORKSPACE_NOT_FOUND");

  const initFile = await write("init.json", {
    format: "dubsar.memory-init-proposal/1",
    project_id: "first-journey",
    title: "First journey",
  });
  const initPreview = dubsar(["init", "--start", root, "--proposal", initFile, "--json"]);
  assert.equal(initPreview.value.status, "preview");
  dubsar(["init", "--start", root, "--proposal", initFile,
    "--apply", "--expected-change", initPreview.value.change_sha256, "--json"]);

  // 2. Workspace exists but holds no Work: a checkpoint is impossible.
  const empty = status(script, root).value;
  assert.equal(empty.dubsar.present, true);
  assert.equal(empty.dubsar.next_action, "record_work");
  assert.equal(empty.dubsar.readiness, "not_ready");

  const premature = await write("premature.json", {
    format: "dubsar.memory-change-proposal/1",
    project_id: "first-journey",
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: "cp-too-early",
        work_id: "w-missing",
        kind: "progress",
        summary: "A checkpoint without a Work must be refused.",
        references: [],
        validation: ["None"],
        limitations: ["None"],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active", summary: "State.", blockers: [], next_action: "Continue.",
        },
      },
    },
  });
  const refused = dubsar(["checkpoint", "--start", root, "--proposal", premature, "--json"]);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.value.code, "MEMORY_WORK_NOT_FOUND");

  // 3. Create the Work — its own preview and apply.
  const workFile = await write("work.json", {
    format: "dubsar.memory-change-proposal/1",
    project_id: "first-journey",
    operation: "work_create",
    payload: {
      work: {
        format: "dubsar.work/1",
        work_id: "w-auth",
        title: "Authentication",
        status: "open",
        scope: "bounded",
        objective: "Ship the authentication feature.",
        acceptance_criteria: ["The specification is accepted."],
        knowledge_ids: [],
        references: [],
      },
      body: "Advisory notes.\n",
    },
  });
  const workPreview = dubsar(["work", "create", "--start", root, "--proposal", workFile, "--json"]);
  dubsar(["work", "create", "--start", root, "--proposal", workFile,
    "--apply", "--expected-change", workPreview.value.change_sha256, "--json"]);

  // 4. The Work exists but nothing selected it: DUBSAR never chooses.
  const unselected = status(script, root).value;
  assert.equal(unselected.dubsar.active_work, null);
  assert.equal(unselected.dubsar.next_action, "choose_work");

  const selectPreview = dubsar(["work", "select", "--start", root, "--work", "w-auth", "--json"]);
  dubsar(["work", "select", "--start", root, "--work", "w-auth",
    "--apply", "--expected-change", selectPreview.value.change_sha256, "--json"]);

  // 5. Only now can a checkpoint reference the specification.
  const selected = status(script, root).value;
  assert.equal(selected.dubsar.active_work, "w-auth");
  const specification = selected.documents.find((item) => item.role === "specification");
  assert.equal(specification.referenceable, true);
  assert.equal(specification.status, "unlinked");

  const checkpointFile = await write("cp.json", {
    format: "dubsar.memory-change-proposal/1",
    project_id: "first-journey",
    operation: "checkpoint_append",
    payload: {
      entry: {
        checkpoint_id: "cp-first",
        work_id: "w-auth",
        kind: "decision",
        summary: "The specification is accepted for the authentication feature.",
        // Only the captured digest is ever used.
        references: [{ path: specification.path, sha256: specification.captured_sha256 }],
        validation: ["Reviewed with the human operator"],
        limitations: ["Task state remains owned by Spec Kit"],
        resolves: null,
        attempt: null,
        resulting_state: {
          status: "active",
          summary: "Specification accepted.",
          blockers: [],
          next_action: "Begin the first recorded task.",
        },
      },
    },
  });
  const preview = dubsar(["checkpoint", "--start", root, "--proposal", checkpointFile, "--json"]);
  assert.equal(preview.value.status, "preview");
  dubsar(["checkpoint", "--start", root, "--proposal", checkpointFile,
    "--apply", "--expected-change", preview.value.change_sha256, "--json"]);

  const final = status(script, root).value;
  const linked = final.documents.find((item) => item.role === "specification");
  assert.equal(linked.status, "fresh");
  assert.deepEqual(linked.linked_by, ["cp-first"]);
  assert.equal(final.dubsar.capsule_format, "dubsar.resume-capsule/4");
});

test("the most recent checkpoint speaks for a reference", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const helpers = await initialiseMemory(t, root);
  const relative = "specs/003-auth/spec.md";

  await linkDocument(t, root, helpers, relative, "cp-older");
  await writeFile(path.join(root, relative), "# Specification (second revision)\n", "utf8");
  await linkDocument(t, root, helpers, relative, "cp-newer");

  const specification = status(script, root).value.documents
    .find((item) => item.role === "specification");
  // The newest checkpoint recorded the current bytes, so the document is fresh
  // even though an older checkpoint recorded a digest that no longer matches.
  assert.equal(specification.status, "fresh");
  assert.equal(specification.linked_by.at(0), "cp-newer");
  assert.equal(specification.linked_by.includes("cp-older"), true);
});

test("an aliased path is refused rather than captured", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const relative = "specs/003-auth/spec.md";
  const target = path.join(root, relative);

  let aliased = false;
  try {
    const { linkSync } = await import("node:fs");
    await rm(target, { force: true });
    await writeFile(path.join(root, "specs", "003-auth", "origin.md"), "# Aliased\n", "utf8");
    linkSync(path.join(root, "specs", "003-auth", "origin.md"), target);
    aliased = true;
  } catch {
    aliased = false;
  }

  if (!aliased) {
    // Windows refuses hardlink and symlink creation without elevation, so this
    // case cannot be exercised here. The refusal itself is covered by DUBSAR's
    // own safe-capture tests.
    t.skip("hardlink creation is not permitted on this host");
    return;
  }
  const specification = status(script, root).value.documents
    .find((item) => item.role === "specification");
  assert.equal(specification.referenceable, false, "an aliased file must not be referenceable");
  assert.equal(specification.captured_sha256, null);
  assert.equal(specification.capture_refused, "FILE_UNSAFE");
});

test("reading never modifies .specify, specs, or .dubsar", async (t) => {
  const script = await stageExtension(t);
  const root = await specKitProject(t);
  const helpers = await initialiseMemory(t, root);
  await linkDocument(t, root, helpers, "specs/003-auth/spec.md");

  const fingerprint = async () => {
    const seen = [];
    const walk = async (directory) => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
        (left, right) => (left.name < right.name ? -1 : 1),
      )) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(absolute); continue; }
        seen.push(`${path.relative(root, absolute).replaceAll("\\", "/")}:${sha256(await readFile(absolute))}`);
      }
    };
    for (const scope of [".specify", "specs", ".dubsar"]) {
      await walk(path.join(root, scope));
    }
    return seen.join("\n");
  };

  const before = await fingerprint();
  status(script, root);
  status(script, root);
  spawnSync(process.execPath, [script, root], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SPECIFY_FEATURE_DIRECTORY: "specs/003-auth" },
  });
  assert.equal(await fingerprint(), before, "no file under any of the three roots changed");
});

test("no project file is read outside DUBSAR's safe-capture path", async () => {
  const source = await readFile(STATUS, "utf8");

  // The only filesystem imports allowed are opendir, which is used solely to
  // prove a directory is openable, and the safe primitives from the runtime.
  const imports = [...source.matchAll(/import \{([^}]+)\} from "node:fs(?:\/promises)?"/gu)]
    .flatMap(([, names]) => names.split(",").map((name) => name.trim()));
  assert.deepEqual(imports, ["opendir"],
    "node:fs may only contribute opendir; every file read goes through captureRegularFile");

  for (const forbidden of ["readFile", "readFileSync", "existsSync", "statSync", "createReadStream"]) {
    assert.equal(source.includes(forbidden), false,
      `${forbidden} would bypass safe capture`);
  }
  // Content is parsed from the captured bytes, never re-read by path.
  assert.match(source, /captured\.content\.toString\("utf8"\)/u);
  assert.equal(/readFile\(path\.join\(root/u.test(source), false);
});

test("the embedded write contracts match the runtime's closed key lists", async () => {
  const reference = await readFile(
    path.join(EXTENSION, "docs", "contracts", "write-operations.md"), "utf8");
  const contracts = await readFile(
    path.join(REPOSITORY_ROOT, "packages", "dubsar-project-continuity",
      "runtime", "memory-vnext-contracts.mjs"), "utf8");

  // dubsar.work/1 is closed over exactly these nine keys. If the runtime gains
  // or loses one, this test fails and the reference must be updated with it.
  const declared = contracts.match(
    /assertMemoryWork[\s\S]*?exactKeys\(value, \[([\s\S]*?)\]\)/u)?.at(1);
  assert.equal(typeof declared, "string");
  const keys = [...declared.matchAll(/"([a-z_]+)"/gu)].map(([, key]) => key).sort();
  assert.deepEqual(keys, [
    "acceptance_criteria", "format", "knowledge_ids", "objective",
    "references", "scope", "status", "title", "work_id",
  ]);
  for (const key of keys) {
    assert.ok(reference.includes(`\`${key}\``), `the reference must document ${key}`);
  }

  // The allowed values are stated, not left to inference.
  for (const value of ["bounded", "multi_step", "multi_session", "open", "paused", "complete"]) {
    assert.ok(reference.includes(value), `the reference must state ${value}`);
  }
  // work select is flag-built and must be documented as refusing --proposal.
  assert.match(reference, /takes no `--proposal`/u);
  // Each mutation is separate.
  assert.match(reference, /separate mutation/u);
});

test("the contract reference ships in the artifact and reaches every integration", async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "dubsar-contract-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const built = await buildExtensionArtifact({ outputDirectory: target });
  const archive = (await readFile(path.join(target, "dubsar-memory-extension.zip")))
    .toString("latin1");

  // Both documents travel: the extension's own, and the canonical one copied
  // from the sealed package.
  assert.ok(archive.includes("docs/contracts/write-operations.md"));
  assert.ok(archive.includes("docs/contracts/checkpoint-append.md"));
  assert.equal(built.file_count > 40, true);

  // The copied contract has a single source: the sealed package. Verified by
  // digest against the package inventory rather than by scanning the compressed
  // archive, so the check proves provenance instead of mere presence.
  const packageRoot = path.join(REPOSITORY_ROOT, "packages", "dubsar-project-continuity");
  const canonicalPath = "skills/checkpoint-project-context/references/checkpoint-append.md";
  const canonical = await readFile(path.join(packageRoot, ...canonicalPath.split("/")));
  const inventory = JSON.parse(await readFile(path.join(packageRoot, "FILES.sha256.json"), "utf8"));
  const declared = inventory.files.find((item) => item.path === canonicalPath);
  assert.equal(typeof declared?.sha256, "string", "the canonical contract is inventoried");
  assert.equal(sha256(canonical), declared.sha256,
    "packaging copies the sealed contract rather than maintaining a second copy");
  assert.match(canonical.toString("utf8"), /dubsar\.memory-change-proposal\/1/u);

  // Both installed commands point at the contracts.
  for (const name of ["speckit.dubsar.resume.md", "speckit.dubsar.checkpoint.md"]) {
    const body = await readFile(path.join(EXTENSION, "commands", name), "utf8");
    assert.match(body, /docs\/contracts\/write-operations\.md/u,
      `${name} must point at the write contracts`);
  }
  const checkpoint = await readFile(
    path.join(EXTENSION, "commands", "speckit.dubsar.checkpoint.md"), "utf8");
  assert.match(checkpoint, /docs\/contracts\/checkpoint-append\.md/u);
  // The corrected boundary: four distinct mutations, not one file.
  assert.match(checkpoint, /Each mutation is separate, previewed, and confirmed on its own/u);
  assert.match(checkpoint, /work select` writes `\.dubsar\/local\.json/u);
});
