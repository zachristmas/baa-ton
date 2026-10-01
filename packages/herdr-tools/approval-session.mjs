import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Resolve one trusted active Pi session path for both resolver and token binding. */
export async function resolveApprovalSessionFile(ctx, env = process.env) {
  try {
  const active = ctx?.sessionManager?.getSessionFile?.();
  const fallback = env?.PI_SESSION_FILE;
  if (active !== undefined && active !== null && typeof active !== "string")
    throw new Error("Native Pi session file is invalid.");
  if (fallback !== undefined && (typeof fallback !== "string" || !fallback))
    throw new Error("PI_SESSION_FILE fallback is invalid.");
  if (active && fallback) {
    if (!isAbsolute(active) || !isAbsolute(fallback) || await realpath(active) !== await realpath(fallback))
      throw new Error("PI_SESSION_FILE conflicts with the active native session.");
  }
  const candidate = active || fallback;
  if (!candidate || !isAbsolute(candidate)) throw new Error("A durable active Pi session file is required.");
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isFile()) throw new Error("Active Pi session is not a regular file.");
  return canonical;
  } catch {
    return undefined;
  }
}
