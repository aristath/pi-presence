import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryCache } from "../src/history-cache.ts";
import { PresenceService } from "../src/service.ts";
import { locate } from "../src/store.ts";

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "presence-cache-"));
  const agent = join(base, "agent");
  await mkdir(agent);
  const config = {
    root: join(base, "journal"),
    user: "person",
    defaultUser: "person",
    contextMessages: 5,
  };
  const service = new PresenceService(agent);
  let reads = 0,
    failure = false;
  const cache = new HistoryCache(async (...args) => {
    reads++;
    if (failure) throw new Error("Storage unavailable");
    return service.history(...args);
  });
  t.after(async () => {
    cache.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    config,
    service,
    cache,
    reads: () => reads,
    fail: (value: boolean) => {
      failure = value;
    },
  };
}

test("missing journals, profile switches and directory replacement cannot leave cached history stale", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cache.read(f.config)).entries.length, 0);
  await f.service.write(f.config, "Original state", "original");
  assert.equal(
    (await f.cache.read(f.config)).entries[0].text,
    "Original state",
  );
  const reads = f.reads();
  await f.cache.read(f.config);
  assert.equal(f.reads(), reads);
  const path = await locate(f.config.root, "person", "person");
  await rename(path, path + ".old");
  await f.service.write(f.config, "Replacement state", "replacement");
  assert.equal(
    (await f.cache.read(f.config)).entries[0].text,
    "Replacement state",
  );
  const other = { ...f.config, user: "other" };
  await f.service.write(other, "Other profile", "other");
  assert.equal((await f.cache.read(other)).entries[0].text, "Other profile");
  assert.equal(
    (await f.cache.read(f.config)).entries[0].text,
    "Replacement state",
  );
});

test("filesystem notifications refresh in-place edits without a directory timestamp change", async (t) => {
  const f = await fixture(t);
  const saved = await f.service.write(f.config, "Before the edit", "saved");
  await f.cache.read(f.config);
  const path = await locate(f.config.root, "person", "person");
  const observer = watch(path, { persistent: false });
  t.after(() => observer.close());
  const changed = once(observer, "change");
  const file = join(path, saved.entry!.id + ".md");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace("Before the edit", "After the edit"),
  );
  await changed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    (await f.cache.read(f.config)).entries[0].text,
    "After the edit",
  );
});

test("failed and cancelled reads are retried instead of becoming authoritative cache entries", async (t) => {
  const f = await fixture(t);
  await f.service.write(f.config, "Saved state", "saved");
  await f.cache.read(f.config);
  f.cache.invalidate();
  f.fail(true);
  await assert.rejects(f.cache.read(f.config), /Storage unavailable/);
  f.fail(false);
  assert.equal((await f.cache.read(f.config)).entries[0].text, "Saved state");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.cache.read(f.config, controller.signal), {
    name: "AbortError",
  });
  assert.equal((await f.cache.read(f.config)).entries[0].text, "Saved state");
});
