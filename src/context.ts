import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  contextText,
  hash,
  key,
  unique,
  type Entry,
  type History,
} from "./store.ts";

export const CONTEXT = "pi-presence:context";
export const DELIVERY = "pi-presence:delivery";

interface Anchor {
  fingerprint: string;
  occurrence: number;
}
export interface Delivery {
  version: 1;
  scope: string;
  after: Anchor | null;
  observed: string[];
  entries: Entry[];
  content: string;
  initialized?: boolean;
  limit?: number;
}

const fingerprint = (message: AgentMessage) => hash(JSON.stringify(message));
const revision = (entry: Entry) => hash(JSON.stringify(entry));
export const withoutPresence = (messages: AgentMessage[]) =>
  messages.filter(
    (message) => message.role !== "custom" || message.customType !== CONTEXT,
  );

// These are metadata entries, never custom messages in the stored conversation.
// Reading the active branch also finds deliveries preceding a compaction.
export function deliveries(
  branch: readonly { type: string; customType?: string; data?: unknown }[],
  scope: string,
): Delivery[] {
  return branch.flatMap((row) => {
    if (row.type !== "custom" || row.customType !== DELIVERY) return [];
    const data = row.data as Delivery | undefined;
    return data?.version === 1 &&
      data.scope === scope &&
      Array.isArray(data.entries) &&
      Array.isArray(data.observed) &&
      typeof data.content === "string"
      ? [data]
      : [];
  });
}

function anchor(messages: AgentMessage[]): Anchor | null {
  if (!messages.length) return null;
  const last = fingerprint(messages.at(-1)!);
  return {
    fingerprint: last,
    occurrence: messages.filter((message) => fingerprint(message) === last)
      .length,
  };
}

export function prepareDelivery(
  scope: string,
  previous: Delivery[],
  messages: AgentMessage[],
  found: History | undefined,
  limit: number,
  guide: string,
): Delivery | undefined {
  const initialized = previous.some((row) => row.initialized);
  const observed = new Set(previous.flatMap((row) => row.observed));
  const texts = new Set(
    previous.flatMap((row) => row.entries.map((entry) => key(entry.text))),
  );
  const priorLimit = previous.reduce(
    (count, row) => Math.max(count, row.limit ?? 0),
    0,
  );
  const fresh =
    found?.entries.filter((entry) => !observed.has(revision(entry))) ?? [];
  const candidates =
    !initialized || limit > priorLimit
      ? unique(found?.entries ?? [])
          .slice(0, limit)
          .concat(initialized ? fresh : [])
      : fresh;
  const entries = candidates.filter((entry) => {
    const text = key(entry.text);
    if (texts.has(text)) return false;
    texts.add(text);
    return true;
  });
  let text = "";
  if (!found) text = "Saved presence is temporarily unavailable.";
  else if (!initialized)
    text = contextText({ entries, warnings: found.warnings }, limit);
  else if (entries.length || found.warnings.length)
    text = contextText(
      { entries, warnings: found.warnings },
      entries.length || limit,
    );
  if (
    !entries.length &&
    previous.some((row) => row.content.includes(text)) &&
    text
  )
    text = "";
  const content = text
    ? `${previous.some((row) => row.content) ? "" : guide + "\n\n"}<presence_context>\n${text}\n</presence_context>`
    : "";
  const newlyObserved = fresh.map(revision);
  if (
    !content &&
    !newlyObserved.length &&
    (initialized || !found) &&
    limit <= priorLimit
  )
    return;
  if (!content && !found) return;
  return {
    version: 1,
    scope,
    after: previous.length ? anchor(messages) : null,
    observed: newlyObserved,
    entries,
    content,
    ...(found ? { initialized: true, limit } : {}),
  };
}

export function projectPresence(
  messages: AgentMessage[],
  previous: Delivery[],
): AgentMessage[] {
  const positions = new Map<string, number[]>();
  messages.forEach((message, index) => {
    const id = fingerprint(message);
    const indices = positions.get(id) ?? [];
    indices.push(index + 1);
    positions.set(id, indices);
  });
  const slots = new Map<number, AgentMessage[]>();
  const head = messages[0]?.role === "system" ? 1 : 0;
  let position = head;
  for (const row of previous) {
    if (!row.content) continue;
    // Compaction removes old anchors. Their original text is restored before
    // the summary; anchors in the retained tail keep their relative position.
    const target = row.after
      ? (positions.get(row.after.fingerprint)?.[row.after.occurrence - 1] ?? 0)
      : 0;
    position = Math.max(position, target);
    const slot = slots.get(position) ?? [];
    slot.push({
      role: "custom",
      customType: CONTEXT,
      display: false,
      timestamp: 0,
      content: row.content,
    });
    slots.set(position, slot);
  }
  return Array.from({ length: messages.length + 1 }, (_, index) => [
    ...(slots.get(index) ?? []),
    ...(index < messages.length ? [messages[index]] : []),
  ]).flat();
}
