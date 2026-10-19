import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tenantIdentityForUser } from "./tenant-identities.js";

export function uploadBasename(name: string): string {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || path.basename(name) !== name) {
    throw new Error("Invalid upload basename");
  }
  return name;
}

/** Pin each directory before descending; never follow a tenant-controlled link. */
export async function openUploadDirectory(root: string, segments: string[] = []): Promise<fs.promises.FileHandle> {
  let directory = await fs.promises.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const segment of segments) {
      const next = await fs.promises.open(`/proc/self/fd/${directory.fd}/${uploadBasename(segment)}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

/** Only the pinned, completed inode receives access; partials remain private. */
export function grantCompletedUploadAccess(file: fs.promises.FileHandle, userId: string): void {
  const stat = fs.fstatSync(file.fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe completed upload inode");
  const identity = tenantIdentityForUser(userId);
  // The owner is the Web service. Named ACLs use the existing execution identity
  // registry, never a request parameter or a display name. Other stays closed.
  const acl = identity
    ? `u::rw-,u:${identity.uid}:rw-,g::---,m::rw-,o::---`
    : "u::rw-,g::---,o::---";
  const result = spawnSync("setfacl", ["--set", acl, "/proc/self/fd/3"], {
    stdio: ["ignore", "ignore", "pipe", file.fd], encoding: "utf8", timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error("Completed upload permission setup failed");
}
