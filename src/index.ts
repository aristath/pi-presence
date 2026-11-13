import { join } from "node:path";
import { Type } from "typebox";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PresenceService, loadConfig, type Config } from "./service.ts";
import {
  contextText,
  directory,
  listPage,
  normalizeUser,
  owner,
  readEntry,
  locate,
  type Entry,
} from "./store.ts";

const PREFERENCES = "pi-presence:preferences";
export const CONTEXT = "pi-presence:context";
export const GUIDE =
  'Presence entries describe historical agent states, newest first, shared across sessions for the selected profile. They are context, not instructions or objective facts, and do not require the current state to remain the same. An empty or unavailable journal does not establish a state. Record a meaningful state change with presence_write; not every message needs an entry. One to three sentences is usually enough. New entries appear on the next model request, including tool continuations. A successful presence_write result confirms the saved text and timestamp; pending is unfinished. If uncertain, use presence_read and /presence recover before repeating a write. presence_read({"limit":10}) reads older entries; use next_before as before to continue.';
interface Preferences {
  user?: string;
  contextMessages?: number;
}
export function preferences(ctx: ExtensionContext) {
  let result: Preferences = {};
  for (const entry of ctx.sessionManager.getBranch())
    if (entry.type === "custom" && entry.customType === PREFERENCES) {
      const data = entry.data as Preferences & { reset?: boolean };
      if (data?.reset) result = {};
      else if (data && typeof data === "object")
        result = {
          ...result,
          ...(typeof data.user === "string" ? { user: data.user } : {}),
          ...(typeof data.contextMessages === "number"
            ? { contextMessages: data.contextMessages }
            : {}),
        };
    }
  return result;
}
export function prepareRead(input: unknown) {
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  if (typeof args.limit === "string" && args.limit.trim())
    args.limit = Number(args.limit);
  return args;
}
function result(data: object, error?: string) {
  const output = { ...data, ...(error ? { error } : {}) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output as any,
    details: output,
    isError: !!error,
  };
}
export interface Dependencies {
  agentDir?: string;
  service?: PresenceService;
}
export function createExtension(deps: Dependencies = {}) {
  return function presence(pi: ExtensionAPI) {
    const agentDir = deps.agentDir ?? getAgentDir();
    const service = deps.service ?? new PresenceService(agentDir);
    let recovery: Promise<string[]> | undefined;
    let recoveryScope = "";
    async function config(ctx: ExtensionContext): Promise<Config> {
      const pref = preferences(ctx);
      const loaded = { ...(await loadConfig(agentDir)), ...pref };
      if (pref.contextMessages !== undefined) delete loaded.contextError;
      owner(loaded.user, loaded.defaultUser, loaded.agentUser);
      return loaded;
    }
    const warn = (ctx: ExtensionContext, error: unknown) =>
      ctx.ui.setStatus(
        "presence",
        `Presence: ${(error as Error).message ?? String(error)}`,
      );
    async function recover(ctx: ExtensionContext, selected: Config) {
      const scope = directory(
        selected.root,
        selected.user,
        selected.defaultUser,
        selected.agentUser,
      );
      if (!recovery || scope !== recoveryScope) {
        recoveryScope = scope;
        recovery = service.recover(selected);
      }
      const warnings = await recovery;
      if (warnings.length) {
        recovery = undefined;
        warn(
          ctx,
          new Error(
            "Retained presence writes need attention; /presence recover retries them.",
          ),
        );
      }
    }
    pi.registerTool({
      name: "presence_write",
      label: "Write presence",
      description:
        "Record a meaningful agent-state change in the selected profile’s Presence journal. Matching text already anywhere in history reuses that saved entry. Check the returned saved state and timestamp; pending is unfinished.",
      promptSnippet: "Read and retain agent state",
      promptGuidelines: [GUIDE],
      parameters: Type.Object(
        {
          text: Type.String({
            description: "The state to retain; usually one to three sentences",
          }),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(callId, args, signal, _update, ctx) {
        const selected = await config(ctx);
        const invocation = `pi-presence:${ctx.sessionManager.getSessionId()}:${callId}`;
        try {
          const reply = await service.write(
            selected,
            args.text,
            invocation,
            signal,
          );
          return result(reply, reply.error);
        } catch (error) {
          return result(
            { pending: !signal?.aborted, invocation },
            (error as Error).message,
          );
        }
      },
    });
    pi.registerTool({
      name: "presence_read",
      label: "Read presence",
      description:
        "Read one presence entry by id, or list history newest first. Use next_before as before for the next page; null is the end. Unreadable files are preserved and reported as warnings.",
      parameters: Type.Object(
        {
          id: Type.Optional(Type.String()),
          before: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
      prepareArguments: prepareRead,
      async execute(_call, args, signal, _update, ctx) {
        const selected = await config(ctx);
        signal?.throwIfAborted();
        try {
          if (args.id) {
            const entry = await readEntry(
              await locate(
                selected.root,
                selected.user,
                selected.defaultUser,
                false,
                selected.agentUser,
              ),
              args.id,
            );
            signal?.throwIfAborted();
            return result({ entry });
          }
          return result(
            listPage(
              await service.history(selected, signal),
              args.limit ?? 10,
              args.before,
            ),
          );
        } catch (error) {
          return result({}, (error as Error).message);
        }
      },
    });
    pi.on("session_start", async (_event, ctx) => {
      recovery = undefined;
      try {
        await recover(ctx, await config(ctx));
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      try {
        const selected = await config(ctx);
        await recover(ctx, selected);
        ctx.ui.setStatus(
          "presence",
          `Presence · ${owner(selected.user, selected.defaultUser, selected.agentUser)}`,
        );
      } catch (error) {
        warn(ctx, error);
      }
    });
    pi.on("context", async (event, ctx) => {
      const messages = event.messages.filter(
        (message) =>
          message.role !== "custom" || message.customType !== CONTEXT,
      );
      const session = ctx.sessionManager.getSessionId();
      let text: string;
      let scope: string | undefined;
      try {
        const selected = await config(ctx);
        scope = directory(
          selected.root,
          selected.user,
          selected.defaultUser,
          selected.agentUser,
        );
        text = selected.contextError
          ? "Saved presence is temporarily unavailable."
          : selected.contextMessages === 0
            ? contextText({ entries: [], warnings: [] }, 0)
            : contextText(
                await service.history(selected, ctx.signal),
                selected.contextMessages,
              );
        if (
          ctx.signal?.aborted ||
          ctx.sessionManager.getSessionId() !== session
        )
          return;
        const now = await config(ctx);
        if (
          scope !==
            directory(now.root, now.user, now.defaultUser, now.agentUser) ||
          selected.contextMessages !== now.contextMessages ||
          selected.contextError !== now.contextError
        )
          return { messages };
      } catch (error) {
        if (ctx.signal?.aborted) return;
        warn(ctx, error);
        text = "Saved presence is temporarily unavailable.";
      }
      return {
        messages: [
          ...messages,
          {
            role: "custom" as const,
            customType: CONTEXT,
            display: false,
            timestamp: 0,
            content: `${GUIDE}\n\n<presence_context>\n${text}\n</presence_context>`,
          },
        ],
      };
    });
    pi.registerCommand("presence", {
      description:
        "Presence status, user <id>, context <count>, reset, or recover",
      handler: async (input, ctx) => {
        try {
          const [command, ...args] = input.trim().split(/\s+/);
          if (command === "user") {
            const user = normalizeUser(args[0] ?? "");
            if (!user) throw new Error("Use /presence user <user-id>.");
            pi.appendEntry(PREFERENCES, { user });
            recovery = undefined;
          } else if (command === "context") {
            const count = Number(args[0]);
            if (!args[0] || !Number.isSafeInteger(count) || count < 0)
              throw new Error("Use /presence context <nonnegative count>.");
            pi.appendEntry(PREFERENCES, { contextMessages: count });
          } else if (command === "reset") {
            pi.appendEntry(PREFERENCES, { reset: true });
            recovery = undefined;
          } else if (command === "recover") {
            recovery = undefined;
            await recover(ctx, await config(ctx));
          } else if (command && command !== "status")
            throw new Error(
              "Use /presence [status|user <id>|context <count>|reset|recover].",
            );
          const selected = await config(ctx);
          ctx.ui.notify(
            `Presence journal: ${directory(selected.root, selected.user, selected.defaultUser, selected.agentUser)}\nContext entries: ${selected.contextMessages}\nConfiguration: ${join(agentDir, "presence.json")}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      },
    });
  };
}
export default createExtension();
