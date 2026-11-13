import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension, CONTEXT, prepareRead } from "../src/index.ts";
import { PresenceService, loadConfig, type Config } from "../src/service.ts";
import { locate, directory, hash } from "../src/store.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-presence-extension-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  const config: Config = {
    root: join(root, "data"),
    user: "user-1",
    defaultUser: "user-1",
    contextMessages: 5,
  };
  await writeFile(join(agent, "presence.json"), JSON.stringify(config));
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const state = {
    session: "session-A",
    branch: [] as any[],
    signal: undefined as AbortSignal | undefined,
  };
  const service = new PresenceService(agent);
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) =>
      state.branch.push({ type: "custom", customType, data }),
  };
  const ctx = {
    get signal() {
      return state.signal;
    },
    ui: {
      setStatus: () => {},
      notify: (message: string) => notices.push(message),
    },
    sessionManager: {
      getSessionId: () => state.session,
      getBranch: () => state.branch,
    },
  } as unknown as ExtensionContext;
  createExtension({ agentDir: agent, service })(pi as unknown as ExtensionAPI);
  const event = (name: string, data: any = {}) => handlers.get(name)(data, ctx);
  return {
    root,
    agent,
    config,
    tools,
    handlers,
    commands,
    state,
    ctx,
    service,
    notices,
    event,
  };
}
const visible = (result: any) =>
  result.messages
    .filter((message: any) => message.customType === CONTEXT)
    .map((message: any) => message.content)
    .join("\n");

test("direct tools use the existing journal; writes refresh on the next model call", async () => {
  const f = await fixture();
  const message = { role: "user", content: "hello", timestamp: 1 };
  const external = {
    role: "custom",
    customType: "pi-songya:guide",
    content: "other extension",
    timestamp: 0,
  };
  assert.equal(f.tools.size, 2);
  assert.ok(f.tools.has("presence_write"));
  assert.ok(f.tools.has("presence_read"));
  const before = await f.event("context", { messages: [external, message] });
  assert.match(visible(before), /No presence entries saved yet/);
  assert.equal(f.state.branch.length, 0);
  const saved = await f.tools
    .get("presence_write")
    .execute(
      "call-1",
      { text: "Ready for the next request." },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(saved.isError, false);
  assert.equal(
    saved.structuredContent.entry.text,
    "Ready for the next request.",
  );
  const after = await f.event("context", { messages: before.messages });
  assert.match(visible(after), /Ready for the next request/);
  assert.equal(
    after.messages.filter((m: any) => m.customType === CONTEXT).length,
    1,
  );
  assert.ok(after.messages.includes(external));
  const read = await f.tools
    .get("presence_read")
    .execute("read", { limit: 10 }, undefined, undefined, f.ctx);
  assert.equal(read.structuredContent.entries.length, 1);
  assert.equal(f.state.branch.length, 0);
});
test("a configured agent alias reads and writes the existing owner journal", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agent, "presence.json"),
    JSON.stringify({
      ...f.config,
      user: "assistant",
      agentUser: "assistant",
    }),
  );
  const saved = await f.tools
    .get("presence_write")
    .execute(
      "alias-write",
      { text: "Example retained state" },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(saved.isError, false);
  const id = saved.structuredContent.entry.id;
  const read = await f.tools
    .get("presence_read")
    .execute("alias-read", { id }, undefined, undefined, f.ctx);
  assert.equal(read.structuredContent.entry.text, "Example retained state");
  assert.match(
    visible(await f.event("context", { messages: [] })),
    /Example retained state/,
  );
  assert.equal((await f.service.history(f.config)).entries[0].id, id);
  const loaded = await loadConfig(f.agent);
  assert.equal(loaded.root, f.config.root);
  assert.equal(loaded.agentUser, "assistant");
  await f.commands.get("presence").handler("status", f.ctx);
  assert.ok(
    f.notices.at(-1)?.includes(directory(f.config.root, "user-1", "user-1")),
  );
  await writeFile(
    join(f.agent, "presence.json"),
    JSON.stringify({ user: "user-1" }),
  );
  assert.equal((await loadConfig(f.agent)).root, join(f.agent, "pi-presence"));
});
test("disabled automatic context does not scan storage and direct tools stay available", async () => {
  const f = await fixture();
  await f.commands.get("presence").handler("context 0", f.ctx);
  // Throw if automatic context attempts to read anything from the journal.
  f.service.history = async () => {
    throw new Error("journal must not be scanned");
  };
  const result = await f.event("context", { messages: [] });
  assert.match(visible(result), /not included/);
  assert.doesNotMatch(visible(result), /temporarily unavailable/);
  assert.equal(f.tools.size, 2);
});
test("profile preferences persist in Pi’s branch and reset without changing other profiles", async () => {
  const f = await fixture();
  await f.service.write(f.config, "Profile one state", "user-1");
  await f.service.write(
    { ...f.config, user: "user-2" },
    "Profile two state",
    "user-2",
  );
  await f.commands.get("presence").handler("user user-2", f.ctx);
  const branch = structuredClone(f.state.branch);
  const secondProfile = await f.event("context", { messages: [] });
  assert.match(visible(secondProfile), /Profile two state/);
  assert.doesNotMatch(visible(secondProfile), /Profile one state/);
  f.state.branch = [];
  const firstProfile = await f.event("context", { messages: [] });
  assert.match(visible(firstProfile), /Profile one state/);
  assert.doesNotMatch(visible(firstProfile), /Profile two state/);
  f.state.branch = branch;
  f.state.session = "forked-session";
  const fork = await f.event("context", { messages: [] });
  assert.match(visible(fork), /Profile two state/);
  await f.commands.get("presence").handler("reset", f.ctx);
  const reset = await f.event("context", { messages: [] });
  assert.match(visible(reset), /Profile one state/);
});
test("other sessions’ writes are refreshed without a cache or another model turn", async () => {
  const f = await fixture();
  const first = await f.event("context", { messages: [] });
  assert.match(visible(first), /No presence entries/);
  const other = new PresenceService(f.agent);
  await other.write(f.config, "A shift from another session.", "other-session");
  const next = await f.event("context", { messages: [] });
  assert.match(visible(next), /A shift from another session/);
});
test("configuration preserves existing foreground defaults and the shared zero switch", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agent, "presence.json"),
    JSON.stringify({ root: f.config.root, user: "user-1" }),
  );
  await mkdir(join(f.config.root, "shared"), { recursive: true });
  await writeFile(
    join(f.config.root, "shared/settings.json"),
    JSON.stringify({ presenceContextMessages: 12 }),
  );
  assert.equal((await loadConfig(f.agent)).contextMessages, 5);
  await writeFile(
    join(f.config.root, "shared/settings.json"),
    JSON.stringify({ presenceContextMessages: 0 }),
  );
  assert.equal((await loadConfig(f.agent)).contextMessages, 0);
  await writeFile(
    join(f.config.root, "shared/settings.json"),
    JSON.stringify({ presenceContextMessages: "0" }),
  );
  assert.equal((await loadConfig(f.agent)).contextMessages, 0);
  await writeFile(join(f.config.root, "shared/settings.json"), "{damaged");
  assert.match(
    (await loadConfig(f.agent)).contextError ?? "",
    /enabled state is unknown/,
  );
  await writeFile(
    join(f.agent, "presence.json"),
    JSON.stringify({ ...f.config, contextMessages: "12" }),
  );
  assert.equal((await loadConfig(f.agent)).contextMessages, 12);
  assert.deepEqual(prepareRead({ limit: "3", before: "unchanged" }), {
    limit: 3,
    before: "unchanged",
  });
});
test("unavailable history does not create or invent an agent state", async () => {
  const f = await fixture();
  f.service.history = async () => {
    throw new Error("temporary storage outage");
  };
  const result = await f.event("context", { messages: [] });
  assert.match(visible(result), /temporarily unavailable/);
  assert.doesNotMatch(visible(result), /No presence entries saved yet/);
  await assert.rejects(readdir(f.config.root), { code: "ENOENT" });
});
test("late history cannot enter a switched session", async () => {
  const f = await fixture();
  let finish!: (value: any) => void;
  let started!: (value?: unknown) => void;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.service.history = async () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = f.event("context", { messages: [] });
  await ready;
  f.state.session = "session-B";
  finish({
    entries: [
      {
        id: hash("old"),
        created_at: "2026-11-13T00:00:00.000Z",
        text: "Old session state",
      },
    ],
    warnings: [],
  });
  assert.equal(await pending, undefined);
});
test("Pi SDK loads the isolated package without starting a model request", async () => {
  const { DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const agent = await mkdtemp(join(tmpdir(), "pi-presence-loader-"));
  const loader = new DefaultResourceLoader({
    cwd: agent,
    agentDir: agent,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    additionalExtensionPaths: [join(import.meta.dirname, "../src/index.ts")],
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].tools.size, 2);
});

test("damaged context settings do not disable healthy direct tools", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agent, "presence.json"),
    JSON.stringify({ root: f.config.root, user: "user-1" }),
  );
  await mkdir(join(f.config.root, "shared"), { recursive: true });
  await writeFile(join(f.config.root, "shared/settings.json"), "{damaged");
  const saved = await f.tools
    .get("presence_write")
    .execute(
      "still-useful",
      { text: "A meaningful shift." },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(saved.isError, false);
  assert.equal(saved.structuredContent.entry.text, "A meaningful shift.");
  const read = await f.tools
    .get("presence_read")
    .execute("read", { limit: 10 }, undefined, undefined, f.ctx);
  assert.equal(read.isError, false);
  assert.equal(read.structuredContent.entries.length, 1);
  const context = await f.event("context", { messages: [] });
  assert.match(visible(context), /temporarily unavailable/);
  assert.doesNotMatch(visible(context), /A meaningful shift/);
});
