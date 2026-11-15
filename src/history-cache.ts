import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import type { Config } from "./service.ts";
import { locate, type History } from "./store.ts";

interface CachedHistory {
  identity: string;
  stamp: string;
  generation: number;
  dirty: boolean;
  watcher?: FSWatcher;
  found?: History;
}

// Direct reads always go to storage. Automatic context only rereads the journal
// after a local write, a directory change, or a watcher notification.
export class HistoryCache {
  private cached?: CachedHistory;
  private readonly reader: (
    config: Config,
    signal?: AbortSignal,
  ) => Promise<History>;
  constructor(
    reader: (config: Config, signal?: AbortSignal) => Promise<History>,
  ) {
    this.reader = reader;
  }

  invalidate() {
    if (this.cached) {
      this.cached.dirty = true;
      this.cached.generation++;
    }
  }

  close() {
    this.cached?.watcher?.close();
    this.cached = undefined;
  }

  async read(config: Config, signal?: AbortSignal): Promise<History> {
    signal?.throwIfAborted();
    let path: string;
    try {
      path = await locate(
        config.root,
        config.user,
        config.defaultUser,
        false,
        config.agentUser,
      );
    } catch (error) {
      this.close();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Missing storage can become available later; it is never cached forever.
      return this.reader(config, signal);
    }
    const info = await lstat(path, { bigint: true });
    const identity = `${path}:${info.dev}:${info.ino}`;
    const stamp = `${info.mtimeNs}:${info.ctimeNs}`;
    if (this.cached?.identity !== identity) {
      this.close();
      const cached: CachedHistory = {
        identity,
        stamp,
        generation: 0,
        dirty: true,
      };
      this.cached = cached;
      try {
        cached.watcher = watch(path, { persistent: false }, () => {
          cached.dirty = true;
          cached.generation++;
        });
        cached.watcher.on("error", () => {
          cached.dirty = true;
          cached.watcher?.close();
          cached.watcher = undefined;
        });
      } catch {
        // Without a working watcher, fall back to fresh reads.
      }
    }
    const cached = this.cached!;
    if (!cached.dirty && cached.stamp === stamp && cached.found)
      return cached.found;
    const generation = cached.generation;
    try {
      const found = await this.reader(config, signal);
      signal?.throwIfAborted();
      cached.found = found;
      cached.stamp = stamp;
      cached.dirty = generation !== cached.generation || !cached.watcher;
      return found;
    } catch (error) {
      cached.dirty = true;
      throw error;
    }
  }
}
