import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileRow, JobFinalizationPayload } from "./db.js";
import { isPersistedDeliverablePath, resolveInside } from "./paths.js";

import { PRESENTATION_SUFFIX, WEB_MAX_BYTES, PresentationValidationError, assertPresentationHint, parsePresentationDeclaration, validateWebDocument } from "./web-presentation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_NAME = "manifest.json";
export const FINALIZATION_ORPHAN_PROTECTION_MS = 24 * 60 * 60 * 1_000;

export type FinalizationFileSource = {
  row: FileRow;
  sourcePath: string;
  expectedSha256?: string;
};

export type PresentationWarning = { fileName: string; reason: string };

/** Persist warnings with the answer so reconnect/recovery cannot lose a partial delivery notice. */
export async function prepareJobFinalization(
  dataRoot: string, jobId: string, message: JobFinalizationPayload["message"], sources: FinalizationFileSource[],
): Promise<JobFinalizationPayload> {
  const { files, warnings } = await prepareFinalizationFiles(dataRoot, jobId, sources);
  const plain = (value: string) => value.replace(/[\r\n\p{C}]/gu, " ").replace(/[\\`*_{}\[\]()<>!#|]/g, "\\$&");
  const notice = warnings.length
    ? "\n\n> 附件展示提示：展示校验未通过的成品按普通附件交付，脚本不会运行；其他结果已正常交付。可修正后重新交付。\n>\n"
      + warnings.map(warning => `> - ${plain(warning.fileName)}：${plain(warning.reason)}`).join("\n")
    : "";
  return { message: { ...message, content: message.content + notice }, files };
}

type DiskManifest = {
  version: 1;
  jobId: string;
  files: Array<{ id: string; relativePath: string; size: number; sha256: string }>;
};

export async function prepareFinalizationFiles(
  dataRoot: string,
  jobId: string,
  sources: FinalizationFileSource[],
): Promise<{ files: FileRow[]; warnings: PresentationWarning[] }> {
  assertUuid(jobId, "job");
  const jobDirectory = finalizationDirectory(dataRoot, jobId);
  await fs.promises.mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  const prepared: FileRow[] = [];
  const warnings: PresentationWarning[] = [];
  const declarations = new Map<string, ReturnType<typeof parsePresentationDeclaration>>();
  const rejectedDeclarations = new Map<string, string>();
  for (const source of sources.filter(source => source.row.original_name.endsWith(PRESENTATION_SUFFIX))) {
    const name = source.row.original_name.slice(0, -PRESENTATION_SUFFIX.length);
    try {
      if (declarations.has(name) || rejectedDeclarations.has(name) || sources.filter(item => item.row.original_name === name).length !== 1) {
        throw new PresentationValidationError("展示声明缺少唯一的同次交付文件；未授予交互执行权限。");
      }
      if (source.row.size > 4096) throw new PresentationValidationError("展示声明超过限制。");
      const bytes = await fs.promises.readFile(source.sourcePath);
      if (bytes.length !== source.row.size || (source.expectedSha256 && crypto.createHash("sha256").update(bytes).digest("hex") !== source.expectedSha256)) throw new Error("展示声明回传校验失败。");
      declarations.set(name, parsePresentationDeclaration(bytes.toString("utf8")));
    } catch (error) {
      if (!(error instanceof PresentationValidationError)) throw error;
      declarations.delete(name);
      rejectedDeclarations.set(name, error.message);
    }
  }
  for (const [fileName, reason] of rejectedDeclarations) warnings.push({ fileName, reason });
  for (const source of sources.filter(source => !source.row.original_name.endsWith(PRESENTATION_SUFFIX))) {
    assertUuid(source.row.id, "file");
    if (!isPersistedDeliverablePath(source.row.relative_path)) throw new Error("Finalization target path is invalid");
    const destination = resolveInside(dataRoot, source.row.relative_path);
    const destinationDirectory = path.dirname(destination);
    const expectedParent = path.resolve(dataRoot, "deliverables");
    if (path.dirname(destinationDirectory) !== expectedParent) throw new Error("Finalization target directory is invalid");

    let result: { size: number; sha256: string };
    if (await regularFileExists(destination)) {
      result = await hashFile(destination);
    } else {
      const stagingDirectory = path.join(jobDirectory, source.row.id);
      await fs.promises.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      const temporaryPath = path.join(stagingDirectory, `${crypto.randomUUID()}.part`);
      const stagedPath = path.join(stagingDirectory, path.basename(destination));
      result = await copyAndHash(source.sourcePath, temporaryPath);
      if (result.size !== source.row.size) throw new Error(`Finalization size mismatch for ${source.row.id}`);
      if (source.expectedSha256 && !constantTimeHexEqual(result.sha256, source.expectedSha256)) {
        throw new Error(`Finalization hash mismatch for ${source.row.id}`);
      }
      await fs.promises.rename(temporaryPath, stagedPath);
      await fs.promises.mkdir(expectedParent, { recursive: true });
      try {
        await fs.promises.rename(stagingDirectory, destinationDirectory);
      } catch (error) {
        if (!(await regularFileExists(destination))) throw error;
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
        result = await hashFile(destination);
      }
    }
    if (result.size !== source.row.size) throw new Error(`Finalized file size mismatch for ${source.row.id}`);
    if (source.expectedSha256 && !constantTimeHexEqual(result.sha256, source.expectedSha256)) {
      throw new Error(`Finalized file hash mismatch for ${source.row.id}`);
    }
    const declaration = declarations.get(source.row.original_name);
    let mode = declaration?.presentation_mode ?? "reader";
    let manifest: string | null = null;
    try {
      if (declaration && declaration.sha256 !== result.sha256) throw new PresentationValidationError("展示声明与完整成品 SHA-256 不符。");
      if (declaration && mode === "reader" && /\.html?$/i.test(source.row.original_name)) {
        if (result.size > WEB_MAX_BYTES) throw new PresentationValidationError("显式展示声明的 HTML 上限为 5 MiB；较大阅读文件可省略声明。");
        assertPresentationHint(await fs.promises.readFile(destination, "utf8"), mode);
      }
      if (mode === "web") {
        if (result.size > WEB_MAX_BYTES) throw new PresentationValidationError("交互网页首版仅支持 5 MiB 以内的自包含 HTML。");
        if (!/\.html?$/i.test(source.row.original_name) || source.row.mime_type.split(";")[0] !== "text/html") throw new PresentationValidationError("交互网页只支持 HTML 成品。");
        manifest = JSON.stringify(validateWebDocument(await fs.promises.readFile(destination), source.row.original_name));
      }
    } catch (error) {
      if (!(error instanceof PresentationValidationError)) throw error;
      mode = "reader";
      manifest = null;
      warnings.push({ fileName: source.row.original_name, reason: error.message });
    }
    prepared.push({ ...source.row, sha256: result.sha256, presentation_mode: mode, presentation_manifest: manifest });
  }
  await writeManifest(jobDirectory, {
    version: 1,
    jobId,
    files: prepared.map((file) => ({ id: file.id, relativePath: file.relative_path, size: file.size, sha256: file.sha256! })),
  });
  return { files: prepared, warnings };
}

/** Resume only when every atomically-published file validates; otherwise the caller rolls back. */
export async function recoverPreparedFinalization(dataRoot: string, jobId: string, payload: JobFinalizationPayload): Promise<JobFinalizationPayload | null> {
  assertUuid(jobId, "job");
  const files: FileRow[] = [];
  for (const file of payload.files) {
    assertUuid(file.id, "file");
    if (!isPersistedDeliverablePath(file.relative_path)) return null;
    const absolute = resolveInside(dataRoot, file.relative_path);
    if (!(await regularFileExists(absolute))) return null;
    const actual = await hashFile(absolute);
    if (actual.size !== file.size || (file.sha256 && !constantTimeHexEqual(actual.sha256, file.sha256))) return null;
    files.push({ ...file, sha256: actual.sha256 });
  }
  return { ...payload, files };
}

export async function rollbackUncommittedFinalization(dataRoot: string, jobId: string, payload: JobFinalizationPayload): Promise<void> {
  assertUuid(jobId, "job");
  for (const file of payload.files) {
    if (!UUID.test(file.id) || !isPersistedDeliverablePath(file.relative_path)) continue;
    const absolute = resolveInside(dataRoot, file.relative_path);
    const directory = path.dirname(absolute);
    if (path.dirname(directory) !== path.resolve(dataRoot, "deliverables")) continue;
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
  await cleanupFinalizationDirectory(dataRoot, jobId);
}

export async function cleanupFinalizationDirectory(dataRoot: string, jobId: string): Promise<void> {
  assertUuid(jobId, "job");
  const directory = finalizationDirectory(dataRoot, jobId);
  if (path.dirname(directory) !== path.resolve(dataRoot, "finalization")) throw new Error("Finalization cleanup path is invalid");
  await fs.promises.rm(directory, { recursive: true, force: true });
}

export async function sweepFinalizationOrphans(
  dataRoot: string,
  protectedJobIds: ReadonlySet<string>,
  now = Date.now(),
  protectionMs = FINALIZATION_ORPHAN_PROTECTION_MS,
): Promise<string[]> {
  const root = path.resolve(dataRoot, "finalization");
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return removed;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name) || protectedJobIds.has(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || now - stat.mtimeMs < protectionMs) continue;
    await cleanupFinalizationDirectory(dataRoot, entry.name);
    removed.push(entry.name);
  }
  return removed;
}

function finalizationDirectory(dataRoot: string, jobId: string): string {
  const root = path.resolve(dataRoot, "finalization");
  const directory = path.resolve(root, jobId);
  if (path.dirname(directory) !== root) throw new Error("Finalization directory escapes its root");
  return directory;
}

async function copyAndHash(sourcePath: string, temporaryPath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(fs.createReadStream(sourcePath), measure, fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest("hex") };
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try { return (await fs.promises.lstat(filePath)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeManifest(directory: string, manifest: DiskManifest): Promise<void> {
  const temporary = path.join(directory, `${crypto.randomUUID()}.json.tmp`);
  await fs.promises.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.promises.rename(temporary, path.join(directory, MANIFEST_NAME));
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`Invalid ${label} finalization identifier`);
}
