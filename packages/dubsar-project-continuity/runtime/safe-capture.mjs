import { open } from "node:fs/promises";
import { WorkbenchError, sha256Bytes } from "./contracts.mjs";
import {
  assertNoSymbolicComponents,
  lstatBigInt,
  resolveSafeChild,
  sameIdentity,
} from "./path-safety.mjs";

async function readAtMost(handle, maxBytes) {
  const output = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < output.length) {
    const { bytesRead } = await handle.read(
      output,
      offset,
      output.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new WorkbenchError("FILE_SIZE_LIMIT_EXCEEDED");
  }
  return output.subarray(0, offset);
}

export async function captureRegularFile(root, relativePath, maxBytes) {
  const { portable, candidate } = resolveSafeChild(root, relativePath);
  await assertNoSymbolicComponents(candidate);
  const beforePath = await lstatBigInt(candidate, "REQUIRED_FILE_MISSING");
  if (
    beforePath.isSymbolicLink() ||
    !beforePath.isFile() ||
    beforePath.nlink > 1n
  ) {
    throw new WorkbenchError("FILE_UNSAFE");
  }
  if (beforePath.size > BigInt(maxBytes)) {
    throw new WorkbenchError("FILE_SIZE_LIMIT_EXCEEDED");
  }

  let handle;
  try {
    handle = await open(candidate, "r");
    const beforeHandle = await handle.stat({ bigint: true });
    if (
      !beforeHandle.isFile() ||
      beforeHandle.nlink > 1n ||
      !sameIdentity(beforePath, beforeHandle)
    ) {
      throw new WorkbenchError("FILE_CHANGED_DURING_SNAPSHOT");
    }
    const content = await readAtMost(handle, maxBytes);
    const afterHandle = await handle.stat({ bigint: true });
    if (
      !sameIdentity(beforeHandle, afterHandle) ||
      beforeHandle.size !== afterHandle.size ||
      beforeHandle.mtimeNs !== afterHandle.mtimeNs ||
      BigInt(content.length) !== afterHandle.size
    ) {
      throw new WorkbenchError("FILE_CHANGED_DURING_SNAPSHOT");
    }
    const afterPath = await lstatBigInt(candidate, "FILE_CHANGED_DURING_SNAPSHOT");
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink > 1n ||
      !sameIdentity(afterPath, afterHandle)
    ) {
      throw new WorkbenchError("FILE_CHANGED_DURING_SNAPSHOT");
    }
    await assertNoSymbolicComponents(candidate);
    return {
      path: portable,
      size: content.length,
      sha256: sha256Bytes(content),
      content,
      identity: `${afterHandle.dev}:${afterHandle.ino}`,
    };
  } catch (error) {
    if (error instanceof WorkbenchError) {
      throw error;
    }
    throw new WorkbenchError("FILE_READ_FAILED");
  } finally {
    await handle?.close();
  }
}
