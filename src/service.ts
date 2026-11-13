import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bind,
  checkGuard,
  directory,
  hash,
  history,
  key,
  locate,
  normalizeUser,
  owner,
  syncDirectory,
  type Entry,
  type Intent,
} from "./store.ts";

export interface Config {
  root: string;
  user: string;
  defaultUser: string;
  agentUser?: string;
  contextMessages: number;
  contextError?: string;
}
export interface WriteReply {
  entry?: Entry;
  error?: string;
  pending?: boolean;
  warnings?: string[];
}
export type Writer = (
  intent: Intent,
  signal?: AbortSignal,
) => Promise<WriteReply>;
const expand = (path: string, base: string) =>
  resolve(
    base,
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path,
  );
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
export async function loadConfig(agentDir: string): Promise<Config> {
  const file = join(agentDir, "presence.json");
  let value: any;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Configure Presence in ${file}: ${(error as Error).message}`,
    );
  }
  if (typeof value?.user !== "string")
    throw new Error(`${file} needs a user ID.`);
  const user = normalizeUser(value.user);
  const agentUser =
    normalizeUser(
      typeof value.agentUser === "string" ? value.agentUser : "agent",
    ) || "agent";
  if (user === agentUser && value.defaultUser === undefined)
    throw new Error(
      "Set defaultUser to the journal owner for the agent alias.",
    );
  const defaultUser = normalizeUser(value.defaultUser ?? user);
  owner(user, defaultUser, agentUser);
  const root = expand(
    typeof value.root === "string" ? value.root : join(agentDir, "pi-presence"),
    agentDir,
  );
  let contextMessages = 5;
  let contextError: string | undefined;
  if (value.contextMessages !== undefined)
    contextMessages = Number(value.contextMessages);
  else {
    // Read only the journal's shared context switch, leaving other settings alone.
    try {
      const settings = JSON.parse(
        await readFile(join(root, "shared/settings.json"), "utf8"),
      );
      if (
        settings.presenceContextMessages != null &&
        Number(settings.presenceContextMessages) === 0
      )
        contextMessages = 0;
    } catch (error) {
      if (!missing(error))
        contextError =
          "Presence settings are unavailable; their enabled state is unknown.";
    }
  }
  if (!Number.isSafeInteger(contextMessages) || contextMessages < 0) {
    contextError = "contextMessages must be a nonnegative integer.";
    contextMessages = 5;
  }
  return {
    root,
    user,
    defaultUser,
    agentUser,
    contextMessages,
    ...(contextError ? { contextError } : {}),
  };
}
async function durableDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    if (!missing(error)) throw error;
    await durableDirectory(dirname(path));
    await durableDirectory(path);
  }
}
async function retain(path: string, intent: Intent): Promise<Intent> {
  await durableDirectory(dirname(path));
  const temporary = path + "." + process.pid + "." + Date.now() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(intent) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(dirname(path));
    const saved = JSON.parse(await readFile(path, "utf8")) as Intent;
    if (
      saved.invocation !== intent.invocation ||
      key(saved.text) !== key(intent.text)
    )
      throw new Error(
        "This presence invocation already belongs to different text.",
      );
    return saved;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export const writeLocked: Writer = async (intent, signal) => {
  signal?.throwIfAborted();
  await checkGuard(intent.guard);
  const lockPath = join(intent.guard.path, ".pi-presence.lock");
  const lock = await open(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await lock.stat()).isFile())
      throw new Error("Presence write lock must be a regular file.");
  } finally {
    await lock.close();
  }
  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "flock",
      [
        "--exclusive",
        lockPath,
        process.execPath,
        "--experimental-strip-types",
        worker,
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {}
      force ??= setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000);
      force.unref();
    };
    const abort = () =>
      stop(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(
              "Presence write cancelled; inspect its retained request before repeating.",
            ),
      );
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            "Presence write did not complete; its original request is retained.",
          ),
        ),
      60000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024)
        stop(
          new Error(
            "Presence reply exceeded 64 MiB; original request retained.",
          ),
        );
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      try {
        const result = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (code === 0 && (result.entry || typeof result.error === "string")) {
          resolve(result);
          return;
        }
      } catch {}
      reject(
        failure ??
          new Error(
            `Presence write worker exited ${code}: ${stderr || "no complete response"}. Linux flock is required.`,
          ),
      );
    });
    child.stdin.end(JSON.stringify(intent));
    if (signal?.aborted) abort();
  });
};
export class PresenceService {
  readonly agentDir: string;
  readonly writer: Writer;
  constructor(agentDir: string, writer: Writer = writeLocked) {
    this.agentDir = agentDir;
    this.writer = writer;
  }
  pendingDir(config: Config) {
    return join(
      this.agentDir,
      "pi-presence",
      "pending",
      hash(
        directory(
          config.root,
          config.user,
          config.defaultUser,
          config.agentUser,
        ),
      ),
    );
  }
  async write(
    config: Config,
    text: string,
    invocation: string,
    signal?: AbortSignal,
  ): Promise<WriteReply> {
    signal?.throwIfAborted();
    if (typeof text !== "string" || !text.trim())
      throw new Error("Presence text must not be empty.");
    const path = join(this.pendingDir(config), hash(invocation) + ".json");
    let intent: Intent;
    try {
      intent = JSON.parse(await readFile(path, "utf8"));
      if (intent.invocation !== invocation || key(intent.text) !== key(text))
        throw new Error(
          "This presence invocation already belongs to different text.",
        );
    } catch (error) {
      if (!missing(error)) throw error;
      const target = await locate(
        config.root,
        config.user,
        config.defaultUser,
        true,
        config.agentUser,
      );
      intent = await retain(path, {
        invocation,
        text,
        at: Date.now(),
        guard: await bind(target),
      });
    }
    const target = await locate(
      config.root,
      config.user,
      config.defaultUser,
      false,
      config.agentUser,
    );
    if (intent.guard.path !== target)
      throw new Error(
        "Retained presence write belongs to its original journal; it was not redirected.",
      );
    const reply = await this.writer(intent, signal);
    if (reply.entry && !reply.error) {
      try {
        await unlink(path);
        await syncDirectory(dirname(path));
      } catch (error) {
        if (!missing(error))
          reply.warnings = [
            ...(reply.warnings ?? []),
            "Presence is saved; local retry queue cleanup needs repair: " +
              (error as Error).message,
          ];
      }
    }
    return reply;
  }
  async recover(config: Config) {
    const warnings: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.pendingDir(config));
    } catch (error) {
      if (missing(error)) return warnings;
      throw error;
    }
    for (const name of names.filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    )) {
      try {
        const path = join(this.pendingDir(config), name);
        const intent = JSON.parse(await readFile(path, "utf8")) as Intent;
        if (
          !intent?.guard ||
          typeof intent.invocation !== "string" ||
          typeof intent.text !== "string" ||
          hash(intent.invocation) + ".json" !== name ||
          !Number.isFinite(intent.at)
        )
          throw new Error(
            "Retained presence request needs repair; it was preserved.",
          );
        const target = await locate(
          config.root,
          config.user,
          config.defaultUser,
          false,
          config.agentUser,
        );
        if (intent.guard.path !== target)
          throw new Error(
            "Retained presence write belongs to its original journal; it was not redirected.",
          );
        const reply = await this.writer(intent);
        if (reply.entry && !reply.error) {
          await unlink(path);
          await syncDirectory(dirname(path));
        } else warnings.push(reply.error ?? "Presence write is still pending.");
      } catch (error) {
        warnings.push(`${name}: ${(error as Error).message}`);
      }
    }
    return warnings;
  }
  async history(config: Config, signal?: AbortSignal) {
    try {
      return await history(
        await locate(
          config.root,
          config.user,
          config.defaultUser,
          false,
          config.agentUser,
        ),
        signal,
      );
    } catch (error) {
      if (missing(error)) return { entries: [], warnings: [] };
      throw error;
    }
  }
}
