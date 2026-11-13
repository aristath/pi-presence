import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  symlink,
  mkdir,
  rename,
  chmod,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresenceService, writeLocked, type Config } from "../src/service.ts";
import {
  hash,
  history,
  readEntry,
  contextText,
  bind,
  locate,
  type Entry,
} from "../src/store.ts";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "pi-presence-store-"));
  const agent = join(base, "agent");
  await mkdir(agent);
  const config: Config = {
    root: join(base, "data"),
    user: "user-1",
    defaultUser: "user-1",
    contextMessages: 5,
  };
  const service = new PresenceService(agent);
  return { base, agent, config, service };
}
async function seed(
  path: string,
  text: string,
  invocation: string,
  created_at: string,
): Promise<Entry> {
  const id = hash(invocation);
  await writeFile(
    join(path, id + ".md"),
    `---\n${JSON.stringify({ id, created_at })}\n---\n${text}`,
    { mode: 0o600 },
  );
  return { id, created_at, text };
}
const ids = async (path: string) =>
  (await readdir(path)).filter((name) => /^[a-f0-9]{64}\.md$/.test(name));

test("writes preserve the existing entry format and old-state deduplication", async () => {
  const f = await fixture();
  const path = await locate(f.config.root, "user-1", "user-1", true);
  const old = await seed(
    path,
    "Café\n  ready",
    "old",
    "2026-10-01T10:00:00.000Z",
  );
  const bytes = await readFile(join(path, old.id + ".md"));
  const reply = await f.service.write(
    f.config,
    "Cafe\u0301 ready",
    "different invocation",
  );
  assert.deepEqual(reply.entry, old);
  assert.deepEqual(await readFile(join(path, old.id + ".md")), bytes);
  assert.equal((await ids(path)).length, 1);
  const fresh = await f.service.write(
    f.config,
    "A different state.\nExact formatting.",
    "new invocation",
  );
  assert.ok(fresh.entry);
  const raw = await readFile(join(path, fresh.entry!.id + ".md"), "utf8");
  assert.equal(
    raw,
    `---\n${JSON.stringify({ id: fresh.entry!.id, created_at: fresh.entry!.created_at })}\n---\nA different state.\nExact formatting.`,
  );
  assert.equal(
    (await lstat(join(path, fresh.entry!.id + ".md"))).mode & 0o777,
    0o600,
  );
});
test("independent concurrent writers reuse one normalized state", async () => {
  const f = await fixture();
  const another = new PresenceService(f.agent);
  const results = await Promise.all([
    f.service.write(f.config, "Café\nready", "one"),
    another.write(f.config, "Cafe\u0301 ready", "two"),
    f.service.write(f.config, "Café ready", "three"),
  ]);
  assert.ok(results.every((result) => result.entry && !result.error));
  assert.equal(new Set(results.map((result) => result.entry!.id)).size, 1);
  assert.equal(
    (await ids(await locate(f.config.root, "user-1", "user-1"))).length,
    1,
  );
});
test("a lost reply recovers the exact published ID and timestamp", async () => {
  const f = await fixture();
  f.config.user = "assistant";
  f.config.agentUser = "assistant";
  let accepted: Entry | undefined;
  const lost = new PresenceService(f.agent, async (intent) => {
    const result = await writeLocked(intent);
    accepted = result.entry;
    throw new Error("lost after publication");
  });
  await assert.rejects(
    lost.write(f.config, "A state worth carrying forward.", "original"),
    /lost after/,
  );
  assert.ok(accepted);
  const pending = await readdir(lost.pendingDir(f.config));
  assert.equal(pending.length, 1);
  const frozen = JSON.parse(
    await readFile(join(lost.pendingDir(f.config), pending[0]), "utf8"),
  );
  assert.equal(new Date(frozen.at).toISOString(), accepted!.created_at);
  assert.deepEqual(await f.service.recover(f.config), []);
  assert.deepEqual(await f.service.history(f.config), {
    entries: [accepted],
    warnings: [],
  });
  assert.deepEqual(await readdir(lost.pendingDir(f.config)), []);
});
test("profile separation and the agent’s alias retain current ownership", async () => {
  const f = await fixture();
  const firstProfile = await f.service.write(
    f.config,
    "Profile one state",
    "user-1",
  );
  assert.deepEqual(
    (await f.service.history({ ...f.config, user: "agent" })).entries,
    [firstProfile.entry],
  );
  assert.deepEqual(
    (await f.service.history({ ...f.config, user: "user-2" })).entries,
    [],
  );
  await f.service.write(
    { ...f.config, user: "user-2" },
    "Profile two state",
    "user-2",
  );
  assert.deepEqual((await f.service.history(f.config)).entries, [
    firstProfile.entry,
  ]);
});
test("history pagination uses newest-first timestamps and cursor IDs", async () => {
  const f = await fixture();
  const path = await locate(f.config.root, "user-1", "user-1", true);
  const first = await seed(
    path,
    "earlier",
    "earlier",
    "2026-10-01T00:00:00.000Z",
  );
  const second = await seed(path, "later", "later", "2026-11-01T00:00:00.000Z");
  const { listPage } = await import("../src/store.ts");
  const found = await history(path);
  const page = listPage(found, 1);
  assert.deepEqual(page.entries, [second]);
  assert.equal(page.next_before, second.id);
  assert.deepEqual(listPage(found, 1, page.next_before!).entries, [first]);
  assert.equal(listPage(found, 10, page.next_before!).next_before, null);
  assert.throws(
    () => listPage(found, 1, hash("missing")),
    /cursor is unavailable/,
  );
});
test("damaged records and symlinks stay preserved while healthy entries work", async () => {
  const f = await fixture();
  const path = await locate(f.config.root, "user-1", "user-1", true);
  const good = await seed(
    path,
    "Healthy stored state",
    "good",
    "2026-11-01T00:00:00.000Z",
  );
  const damaged = join(path, hash("damaged") + ".md");
  await writeFile(damaged, "---\nnot valid JSON\n---\nPreserved words");
  const privateFile = join(f.base, "outside.md");
  await writeFile(privateFile, "Never follow this link");
  await symlink(privateFile, join(path, hash("link") + ".md"));
  const found = await history(path);
  assert.deepEqual(found.entries, [good]);
  assert.equal(found.warnings.length, 2);
  assert.match(contextText(found, 5), /temporarily unreadable/);
  assert.match(contextText(found, 5), /Healthy stored state/);
  assert.match(await readFile(damaged, "utf8"), /Preserved words/);
  assert.equal(await readFile(privateFile, "utf8"), "Never follow this link");
});
test("accepted legacy timestamps remain readable and contextualized in UTC", async () => {
  const f = await fixture();
  const path = await locate(f.config.root, "user-1", "user-1", true);
  const entry = await seed(
    path,
    "An earlier state",
    "legacy",
    "October 1, 2026 10:30:00 GMT",
  );
  assert.deepEqual(await readEntry(path, entry.id), entry);
  assert.match(contextText(await history(path), 5), /2026-10-01T10:30:00Z/);
});
test("an unavailable journal is not reported as empty and a replacement directory cannot receive an old write", async () => {
  const f = await fixture();
  let intent: any;
  const interrupted = new PresenceService(f.agent, async (input) => {
    intent = input;
    throw new Error("interrupted");
  });
  await assert.rejects(
    interrupted.write(f.config, "Pending state", "same"),
    /interrupted/,
  );
  const path = intent.guard.path;
  await rename(path, path + ".original");
  await mkdir(path);
  const warnings = await f.service.recover(f.config);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /directory changed/);
  assert.deepEqual(await ids(path), []);
  assert.equal((await readdir(interrupted.pendingDir(f.config))).length, 1);
  await rename(path, path + ".replacement");
  await symlink(path + ".original", path);
  await assert.rejects(f.service.history(f.config), /real directories/);
});
test("malformed pending work does not block a healthy retained request", async () => {
  const f = await fixture();
  const interrupted = new PresenceService(f.agent, async () => {
    throw new Error("interrupted");
  });
  await assert.rejects(
    interrupted.write(f.config, "Keep this state", "healthy"),
  );
  const bad = join(interrupted.pendingDir(f.config), hash("broken") + ".json");
  await writeFile(bad, "{unfinished");
  const warnings = await f.service.recover(f.config);
  assert.equal(warnings.length, 1);
  assert.equal((await f.service.history(f.config)).entries.length, 1);
  assert.equal(await readFile(bad, "utf8"), "{unfinished");
});
test("cancellation before admission creates no journal or pending intent", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.service.write(
      f.config,
      "Cancelled state",
      "cancelled",
      controller.signal,
    ),
  );
  await assert.rejects(readdir(f.config.root), { code: "ENOENT" });
  await assert.rejects(readdir(f.service.pendingDir(f.config)), {
    code: "ENOENT",
  });
});
test("an invocation cannot be reused for different state text", async () => {
  const f = await fixture();
  const first = await f.service.write(f.config, "First state", "same-call");
  const changed = await f.service.write(
    f.config,
    "Different state",
    "same-call",
  );
  assert.match(changed.error ?? "", /different presence text/);
  assert.equal(changed.pending, true);
  assert.deepEqual((await f.service.history(f.config)).entries, [first.entry]);
});
