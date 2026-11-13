import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  link,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Entry {
  id: string;
  created_at: string;
  text: string;
}
export interface History {
  entries: Entry[];
  warnings: string[];
}
export interface Guard {
  path: string;
  dev: string;
  ino: string;
}
export interface Intent {
  invocation: string;
  at: number;
  text: string;
  guard: Guard;
}
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const key = (text: string) =>
  text.normalize("NFC").split(/\s+/u).filter(Boolean).join(" ");
export const normalizeUser = (user: string) =>
  user
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
const validId = /^[a-f0-9]{64}$/;
const canonicalDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function owner(user: string, defaultUser: string, agentUser = "agent") {
  user = normalizeUser(user);
  defaultUser = normalizeUser(defaultUser);
  if (!user || !defaultUser)
    throw new Error("Presence needs a user and a default journal owner.");
  return user === normalizeUser(agentUser) ? defaultUser : user;
}
export function directory(
  root: string,
  user: string,
  defaultUser: string,
  agentUser = "agent",
) {
  return join(
    resolve(root),
    "users",
    owner(user, defaultUser, agentUser),
    "presence",
  );
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
export async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

// Resolve the configured root once, then reject symlinks in profile-owned paths.
// Missing journals are empty on reads; only explicit writes create directories.
export async function locate(
  root: string,
  user: string,
  defaultUser: string,
  create = false,
  agentUser = "agent",
): Promise<string> {
  root = resolve(root);
  if (create) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await syncDirectory(root);
    await syncDirectory(dirname(root));
  }
  const canonical = await realpath(root);
  let path = canonical;
  for (const component of [
    "users",
    owner(user, defaultUser, agentUser),
    "presence",
  ]) {
    path = join(path, component);
    if (create) {
      try {
        await mkdir(path, { mode: 0o700 });
        await syncDirectory(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Presence profile paths must be real directories.");
  }
  return path;
}
export async function bind(path: string): Promise<Guard> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Presence path is not a real directory.");
  return {
    path: await realpath(path),
    dev: String(info.dev),
    ino: String(info.ino),
  };
}
export async function checkGuard(guard: Guard) {
  const actual = await bind(guard.path);
  if (
    actual.path !== guard.path ||
    actual.dev !== guard.dev ||
    actual.ino !== guard.ino
  )
    throw new Error(
      "Presence directory changed; the original write is retained for recovery.",
    );
}
export async function readEntry(path: string, id: string): Promise<Entry> {
  if (!validId.test(id))
    throw new Error(
      "Invalid presence entry id; use presence_read to list entries.",
    );
  const file = await open(
    join(path, id + ".md"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let raw: string;
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Presence entries must be regular files.");
    raw = await file.readFile("utf8");
  } finally {
    await file.close();
  }
  const end = raw.indexOf("\n---\n", 4);
  if (!raw.startsWith("---\n") || end < 0)
    throw new Error("Unreadable presence metadata");
  const meta = JSON.parse(raw.slice(4, end));
  if (
    !meta ||
    meta.id !== id ||
    typeof meta.created_at !== "string" ||
    !Number.isFinite(Date.parse(meta.created_at))
  )
    throw new Error("Invalid presence metadata");
  return { id, created_at: meta.created_at, text: raw.slice(end + 5) };
}
export async function history(
  path: string,
  signal?: AbortSignal,
): Promise<History> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (missing(error)) return { entries: [], warnings: [] };
    throw error;
  }
  const entries: Entry[] = [];
  const warnings: string[] = [];
  for (const name of names.sort()) {
    signal?.throwIfAborted();
    const id = name.slice(0, -3);
    if (name !== id + ".md" || !validId.test(id)) continue;
    try {
      entries.push(await readEntry(path, id));
    } catch {
      warnings.push(`Presence entry ${id} is unreadable; it was preserved.`);
    }
  }
  signal?.throwIfAborted();
  entries.sort((a, b) => {
    if (a.created_at !== b.created_at) {
      if (canonicalDate.test(a.created_at) && canonicalDate.test(b.created_at))
        return a.created_at > b.created_at ? -1 : 1;
      const order = b.created_at.localeCompare(a.created_at);
      if (order) return order;
    }
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  return { entries, warnings };
}
export function unique(entries: Entry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const normalized = key(entry.text);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
export function listPage(found: History, limit = 10, before?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("limit must be a positive integer");
  let start = 0;
  if (before) {
    const index = found.entries.findIndex((entry) => entry.id === before);
    if (index < 0)
      throw new Error(
        "Presence cursor is unavailable; list again without before.",
      );
    start = index + 1;
  }
  const end = Math.min(found.entries.length, start + limit);
  const entries = found.entries.slice(start, end);
  return {
    entries,
    next_before:
      end < found.entries.length && entries.length ? entries.at(-1)!.id : null,
    warnings: found.warnings,
  };
}
export function contextText(found: History, limit: number) {
  if (limit === 0)
    return "Saved presence entries are not included in this context.";
  const entries = unique(found.entries);
  const lines: string[] = [];
  if (found.warnings.length)
    lines.push(
      "Some saved presence entries are temporarily unreadable; they have not been deleted.",
    );
  if (!entries.length && !found.warnings.length)
    lines.push("No presence entries saved yet.");
  for (const entry of entries.slice(0, limit))
    lines.push(
      `- ${new Date(entry.created_at).toISOString().replace(/\.\d{3}Z$/, "Z")}: ${JSON.stringify(entry.text).replaceAll("<", "\\u003c")}`,
    );
  return lines.join("\n");
}
export async function publish(intent: Intent): Promise<Entry> {
  const { guard } = intent;
  await checkGuard(guard);
  if (typeof intent.text !== "string" || !intent.text.trim())
    throw new Error("Presence text must not be empty.");
  const id = hash(intent.invocation);
  const created_at = new Date(intent.at).toISOString();
  // Retry identity is checked before content deduplication: a call cannot be
  // repurposed to write different text after its original effect completed.
  try {
    const previous = await readEntry(guard.path, id);
    if (key(previous.text) !== key(intent.text))
      throw new Error(
        "This invocation already saved different presence text; inspect the original receipt.",
      );
    await confirm(guard, previous.id);
    return previous;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const found = await history(guard.path);
  const duplicate = found.entries.find(
    (entry) => key(entry.text) === key(intent.text),
  );
  if (duplicate) {
    await confirm(guard, duplicate.id);
    return duplicate;
  }
  const text = Buffer.from(intent.text, "utf8").toString("utf8");
  const entry: Entry = { id, created_at, text };
  const data = `---\n${JSON.stringify({ id, created_at })}\n---\n${text}`;
  const temporary = join(guard.path, `.presence-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await checkGuard(guard);
    try {
      await link(temporary, join(guard.path, id + ".md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await readEntry(guard.path, id);
      if (key(previous.text) !== key(text))
        throw new Error(
          "This invocation already saved different presence text.",
        );
    }
    await confirm(guard, id);
    return await readEntry(guard.path, id);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function confirm(guard: Guard, id: string) {
  await checkGuard(guard);
  const file = await open(
    join(guard.path, id + ".md"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Presence entries must be regular files.");
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(guard.path);
  await checkGuard(guard);
}
