import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension, CONTEXT, prepareRead } from "../src/index.ts";
import { DELIVERY } from "../src/context.ts";
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
  await writeFile(join(agent, "settings.json"), JSON.stringify({ presence: config }));
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
    getSettings: () => JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) =>
      state.branch.push({
        id: `entry-${state.branch.length + 1}`,
        type: "custom",
        customType,
        data,
      }),
  };
  const ctx = {
    cwd: agent,
    get signal() {
      return state.signal;
    },
    ui: {
      setStatus: () => {},
      notify: (message: string) => notices.push(message),
    },
    sessionManager: {
      getSessionId: () => state.session,
      getLeafId: () => state.branch.at(-1)?.id ?? null,
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
    pi,
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
  const before = await f.event("context_with_system", {
    messages: [external, message],
  });
  assert.match(visible(before), /No presence entries saved yet/);
  assert.equal(f.state.branch.length, 1);
  assert.equal(f.state.branch[0].customType, DELIVERY);
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
  const after = await f.event("context_with_system", {
    messages: before.messages,
  });
  assert.match(visible(after), /Ready for the next request/);
  assert.equal(
    after.messages.filter((m: any) => m.customType === CONTEXT).length,
    2,
  );
  assert.ok(after.messages.includes(external));
  const read = await f.tools
    .get("presence_read")
    .execute("read", { limit: 10 }, undefined, undefined, f.ctx);
  assert.equal(read.structuredContent.entries.length, 1);
  assert.equal(f.state.branch.length, 2);
});
test("a configured agent alias reads and writes the existing owner journal", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agent, "settings.json"),
    JSON.stringify({ presence: {
      ...f.config,
      user: "assistant",
      agentUser: "assistant",
    } }),
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
    visible(await f.event("context_with_system", { messages: [] })),
    /Example retained state/,
  );
  assert.equal((await f.service.history(f.config)).entries[0].id, id);
  const loaded = await loadConfig(f.agent, f.agent);
  assert.equal(loaded.root, f.config.root);
  assert.equal(loaded.agentUser, "assistant");
  await f.commands.get("presence").handler("status", f.ctx);
  assert.ok(
    f.notices.at(-1)?.includes(directory(f.config.root, "user-1", "user-1")),
  );
  await writeFile(
    join(f.agent, "settings.json"),
    JSON.stringify({ presence: { user: "user-1" } }),
  );
  assert.equal((await loadConfig(f.agent, f.agent)).root, f.agent);
});
test("disabled automatic context does not scan storage and direct tools stay available", async () => {
  const f = await fixture();
  await f.commands.get("presence").handler("context 0", f.ctx);
  // Throw if automatic context attempts to read anything from the journal.
  f.service.history = async () => {
    throw new Error("journal must not be scanned");
  };
  const result = await f.event("context_with_system", { messages: [] });
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
  const secondProfile = await f.event("context_with_system", { messages: [] });
  assert.match(visible(secondProfile), /Profile two state/);
  assert.doesNotMatch(visible(secondProfile), /Profile one state/);
  f.state.branch = [];
  const firstProfile = await f.event("context_with_system", { messages: [] });
  assert.match(visible(firstProfile), /Profile one state/);
  assert.doesNotMatch(visible(firstProfile), /Profile two state/);
  f.state.branch = branch;
  f.state.session = "forked-session";
  const fork = await f.event("context_with_system", { messages: [] });
  assert.match(visible(fork), /Profile two state/);
  await f.commands.get("presence").handler("reset", f.ctx);
  const reset = await f.event("context_with_system", { messages: [] });
  assert.match(visible(reset), /Profile one state/);
});
test("other sessions’ writes appear on the next model request", async () => {
  const f = await fixture();
  const first = await f.event("context_with_system", { messages: [] });
  assert.match(visible(first), /No presence entries/);
  const other = new PresenceService(f.agent);
  await other.write(f.config, "A shift from another session.", "other-session");
  const next = await f.event("context_with_system", { messages: [] });
  assert.match(visible(next), /A shift from another session/);
});

test("unchanged requests reuse journal history and retain the exact model prefix", async () => {
  const f = await fixture();
  await f.service.write(f.config, "Initial saved state", "initial");
  const history = f.service.history.bind(f.service);
  let reads = 0;
  f.service.history = async (...args) => {
    reads++;
    return history(...args);
  };
  const head = { role: "system", content: "Pi prompt", timestamp: 1 };
  const firstInput = { role: "user", content: "First question", timestamp: 2 };
  const first = await f.event("context_with_system", {
    messages: [head, firstInput],
  });
  const nextInput = { role: "user", content: "Next question", timestamp: 3 };
  const second = await f.event("context_with_system", {
    messages: [head, firstInput, nextInput],
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    second.messages.slice(0, first.messages.length),
    first.messages,
  );
  assert.equal(f.state.branch.length, 1);
  const other = new PresenceService(f.agent);
  await other.write(f.config, "State from another session", "external");
  const third = await f.event("context_with_system", {
    messages: [head, firstInput, nextInput],
  });
  assert.equal(reads, 2);
  assert.deepEqual(
    third.messages.slice(0, second.messages.length),
    second.messages,
  );
  const fourth = await f.event("context_with_system", {
    messages: third.messages,
  });
  assert.deepEqual(fourth.messages, third.messages);
  assert.equal(f.state.branch.length, 2);
  await f.tools
    .get("presence_read")
    .execute("read", { limit: 10 }, undefined, undefined, f.ctx);
  assert.equal(reads, 3);
  await f.event("session_shutdown");
});

test("reload warms history once and resumes persisted placements without another delivery", async () => {
  const f = await fixture();
  await f.service.write(f.config, "Saved before reload", "initial");
  const input = { role: "user", content: "Question", timestamp: 1 };
  const first = await f.event("context_with_system", { messages: [input] });
  f.state.branch = JSON.parse(JSON.stringify(f.state.branch));
  await f.event("session_shutdown");
  createExtension({ agentDir: f.agent, service: f.service })(
    f.pi as unknown as ExtensionAPI,
  );
  const history = f.service.history.bind(f.service);
  let reads = 0;
  f.service.history = async (...args) => {
    reads++;
    return history(...args);
  };
  await f.event("session_start");
  const resumed = await f.event("context_with_system", { messages: [input] });
  assert.deepEqual(resumed.messages, first.messages);
  assert.equal(f.state.branch.length, 1);
  assert.equal(reads, 1);
  await f.event("session_shutdown");
});

test("a presence write appends after its tool result and stays there on later requests", async () => {
  const f = await fixture();
  await f.service.write(f.config, "Initial state", "initial");
  const question = { role: "user", content: "Continue", timestamp: 1 };
  const first = await f.event("context_with_system", { messages: [question] });
  const saved = await f.tools
    .get("presence_write")
    .execute("write", { text: "A changed state" }, undefined, undefined, f.ctx);
  const assistant = {
    role: "assistant",
    timestamp: 2,
    content: [
      {
        type: "toolCall",
        id: "write",
        name: "presence_write",
        arguments: { text: "A changed state" },
      },
    ],
  };
  const receipt = {
    role: "toolResult",
    timestamp: 3,
    toolCallId: "write",
    toolName: "presence_write",
    content: saved.content,
    isError: false,
  };
  const second = await f.event("context_with_system", {
    messages: [question, assistant, receipt],
  });
  assert.deepEqual(
    second.messages.slice(0, first.messages.length),
    first.messages,
  );
  assert.equal(
    second.messages.indexOf(receipt) + 1,
    second.messages.length - 1,
  );
  assert.match(String(second.messages.at(-1).content), /A changed state/);
  const next = { role: "user", content: "Another question", timestamp: 4 };
  const third = await f.event("context_with_system", {
    messages: [question, assistant, receipt, next],
  });
  assert.deepEqual(
    third.messages.slice(0, second.messages.length),
    second.messages,
  );
  assert.equal(f.state.branch.length, 2);
  await f.event("session_shutdown");
});
test("context settings accept numeric values and zero directly in Pi settings", async () => {
  const f = await fixture();
  for (const [value, expected] of [[undefined, 5], [0, 0], ["0", 0], ["12", 12]]) {
    await writeFile(join(f.agent, "settings.json"), JSON.stringify({ presence: { ...f.config, contextMessages: value } }));
    assert.equal((await loadConfig(f.agent, f.agent)).contextMessages, expected);
  }
  assert.deepEqual(prepareRead({ limit: "3", before: "unchanged" }), { limit: 3, before: "unchanged" });
});
test("unavailable history does not create or invent an agent state", async () => {
  const f = await fixture();
  f.service.history = async () => {
    throw new Error("temporary storage outage");
  };
  const result = await f.event("context_with_system", { messages: [] });
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
  const pending = f.event("context_with_system", { messages: [] });
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

test("late history cannot append delivery metadata to another branch of the same session", async () => {
  const f = await fixture();
  let finish!: (value: any) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.service.history = async () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = f.event("context_with_system", { messages: [] });
  await ready;
  f.state.branch = [
    {
      id: "different-leaf",
      type: "custom",
      customType: "another-extension",
      data: {},
    },
  ];
  finish({
    entries: [
      {
        id: hash("old"),
        created_at: new Date(0).toISOString(),
        text: "State from the old branch",
      },
    ],
    warnings: [],
  });
  assert.equal(await pending, undefined);
  assert.equal(f.state.branch.length, 1);
  await f.event("session_shutdown");
});
test("Pi SDK loads the isolated package without starting a model request", async () => {
  const { DefaultResourceLoader, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const agent = await mkdtemp(join(tmpdir(), "pi-presence-loader-"));
  const loader = new DefaultResourceLoader({
    cwd: agent,
    agentDir: agent,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    additionalExtensionPaths: [join(import.meta.dirname, "..")],
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].tools.size, 2);
});

test("damaged context settings do not disable healthy direct tools", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agent, "settings.json"),
    JSON.stringify({ presence: { root: f.config.root, user: "user-1", contextMessages: "invalid" } }),
  );
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
  const context = await f.event("context_with_system", { messages: [] });
  assert.match(visible(context), /temporarily unavailable/);
  assert.doesNotMatch(visible(context), /A meaningful shift/);
});
