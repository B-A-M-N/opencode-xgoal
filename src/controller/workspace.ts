/**
 * Workspace-relative path and content-hash helpers.
 *
 * Shared by the verifier and the plugin entry so a relative path cannot resolve
 * against one base in one place and a different base in another. The session
 * workspace is authoritative; `sessionWorkspace()` is only the fallback for
 * hosts that cannot report a session location.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Resolve a captured path against the session workspace, never the cwd. */
export function resolveWorkspacePath(ref: string, workspace: string): string {
  if (isAbsolute(ref)) return ref;
  const base = workspace && workspace.length > 0 ? workspace : process.cwd();
  return resolve(base, ref);
}

/** The workspace the current session is operating in, if known. */
export function sessionWorkspace(): string {
  return String(process.env.XGOAL_WORKSPACE ?? process.env.PWD ?? "");
}

/** Content hash, so file evidence can be checked for staleness. */
export function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    return "";
  }
}
