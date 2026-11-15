import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT,
  DELIVERY,
  deliveries,
  prepareDelivery,
  projectPresence,
  type Delivery,
} from "../src/context.ts";
import { hash, type Entry, type History } from "../src/store.ts";

const scope = "/journal/users/person/presence";
const user = (content: string, timestamp: number): AgentMessage => ({
  role: "user",
  content,
  timestamp,
});
const entry = (text: string, timestamp: number): Entry => ({
  id: hash(text),
  text,
  created_at: new Date(timestamp).toISOString(),
});
const found = (...entries: Entry[]): History => ({ entries, warnings: [] });
const append = (
  previous: Delivery[],
  messages: AgentMessage[],
  history: History | undefined,
  limit = 5,
) => {
  const next = prepareDelivery(
    scope,
    previous,
    messages,
    history,
    limit,
    "Presence guide",
  );
  return next ? [...previous, next] : previous;
};

test("growing conversation preserves the exact prefix, with each new presence appended once", () => {
  const initial = entry("Initial presence", 1),
    newer = entry("New presence", 2);
  const firstMessages = [user("First question", 1)];
  let previous = append([], firstMessages, found(initial));
  const first = projectPresence(firstMessages, previous);
  const laterMessages = [...firstMessages, user("Second question", 2)];
  assert.equal(
    prepareDelivery(
      scope,
      previous,
      laterMessages,
      found(initial),
      5,
      "Presence guide",
    ),
    undefined,
  );
  const second = projectPresence(laterMessages, previous);
  assert.deepEqual(
    convertToLlm(second).slice(0, first.length),
    convertToLlm(first),
  );
  previous = append(previous, laterMessages, found(newer, initial));
  const third = projectPresence(laterMessages, previous);
  assert.deepEqual(
    convertToLlm(third).slice(0, second.length),
    convertToLlm(second),
  );
  assert.match(String((third.at(-1) as any).content), /New presence/);
  const moreMessages = [...laterMessages, user("Third question", 3)];
  assert.deepEqual(
    projectPresence(moreMessages, previous).slice(0, third.length),
    third,
  );
  assert.equal(previous.length, 2);
  assert.ok(convertToLlm(third).every((message) => message.role !== "system"));
});

test("projection preserves Pi's leading system message and later prompt and tool patches", () => {
  const head: AgentMessage = {
    role: "system",
    content: "Base prompt",
    timestamp: 1,
  };
  const patch: AgentMessage = {
    role: "system",
    content: "Prompt patch",
    timestamp: 3,
  };
  const messages = [head, user("Question", 2), patch];
  const previous = append([], messages, found(entry("Saved state", 1)));
  const projected = projectPresence(messages, previous);
  assert.equal(projected[0], head);
  assert.deepEqual(
    projected.filter((message) => message.role === "system"),
    [head, patch],
  );
  assert.deepEqual(
    projected.filter((message) => message.role !== "custom"),
    messages,
  );
});

test("initial limit does not evict delivered states or omit a burst of new states", () => {
  const older = entry("Older state", 1),
    initial = entry("Initial state", 2);
  let previous = append([], [], found(initial, older), 1);
  assert.deepEqual(previous[0].entries, [initial]);
  const newer = entry("New state", 3),
    newest = entry("Newest state", 4);
  previous = append(
    previous,
    [user("Continue", 1)],
    found(newest, newer, initial, older),
    1,
  );
  assert.deepEqual(previous[1].entries, [newest, newer]);
  const projected = JSON.stringify(projectPresence([], previous));
  for (const text of [initial.text, newer.text, newest.text])
    assert.ok(projected.includes(text));
  assert.ok(!projected.includes(older.text));
});

test("edits append a new observation while deletion and reordering leave the cached prefix intact", () => {
  const initial = entry("Original state", 1),
    other = entry("Other state", 2);
  let previous = append([], [], found(other, initial));
  const first = projectPresence([], previous);
  const changed = { ...initial, text: "Edited state" };
  previous = append(previous, [user("Continue", 1)], found(changed, other));
  const next = projectPresence([user("Continue", 1)], previous);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.match(JSON.stringify(next), /Original state/);
  assert.match(JSON.stringify(next), /Edited state/);
  assert.equal(
    prepareDelivery(scope, previous, [], found(other), 5, "Presence guide"),
    undefined,
  );
});

test("presence metadata is excluded from real Pi compaction and restored verbatim after repeated compactions", async () => {
  const manager = SessionManager.inMemory();
  const initial = entry("A state that must remain verbatim.", 1);
  const first = user("Earlier discussion", 1);
  manager.appendMessage(first as any);
  let previous = append([], [first], found(initial));
  manager.appendCustomEntry(DELIVERY, previous[0]);
  const latest = user("Recent discussion", 2);
  const kept = manager.appendMessage(latest as any);
  const added = entry("A later state that must also remain verbatim.", 2);
  previous = append(previous, [first, latest], found(added, initial));
  manager.appendCustomEntry(DELIVERY, previous[1]);
  const prepareModule = new URL(
    "./core/compaction/compaction.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const { prepareCompaction } = await import(prepareModule.href);
  const preparation = prepareCompaction(manager.getBranch(), {
    enabled: true,
    reserveTokens: 10,
    keepRecentTokens: 1,
  });
  assert.ok(preparation);
  assert.doesNotMatch(
    serializeConversation(
      convertToLlm([
        ...preparation.messagesToSummarize,
        ...preparation.turnPrefixMessages,
      ]),
    ),
    /must.*remain verbatim/,
  );
  for (let index = 0; index < 2; index++) {
    manager.appendCompaction("Conversation summary", kept, 100);
    const restored = deliveries(manager.getBranch(), scope);
    assert.equal(restored.length, 2);
    const raw = manager.buildSessionContext().messages;
    assert.doesNotMatch(JSON.stringify(raw), /must.*remain verbatim/);
    const projected = projectPresence(raw, restored);
    for (const row of previous)
      assert.equal(
        projected.filter(
          (message) =>
            message.role === "custom" &&
            message.customType === CONTEXT &&
            message.content === row.content,
        ).length,
        1,
      );
  }
});

test("resume reconstructs deliveries from the active branch, including entries before compaction", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage(user("Start", 1) as any);
  const original = append([], [], found(entry("Branch presence", 1)))[0];
  manager.appendCustomEntry(DELIVERY, original);
  const saved = JSON.parse(JSON.stringify(manager.getBranch()));
  assert.deepEqual(deliveries(saved, scope), [original]);
  assert.deepEqual(deliveries(saved, "/another/profile"), []);
  manager.branch(root);
  assert.deepEqual(deliveries(manager.getBranch(), scope), []);
});

test("unavailable storage preserves delivered states and emits an outage notice only once", () => {
  let previous = append([], [], found(entry("Keep this state", 1)));
  previous = append(previous, [user("Continue", 1)], undefined);
  assert.match(
    JSON.stringify(projectPresence([], previous)),
    /Keep this state/,
  );
  assert.match(
    JSON.stringify(projectPresence([], previous)),
    /temporarily unavailable/,
  );
  assert.equal(
    prepareDelivery(scope, previous, [], undefined, 5, "Presence guide"),
    undefined,
  );
});
