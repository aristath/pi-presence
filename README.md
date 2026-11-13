# pi-presence

A standalone Pi extension for persistent agent-state journals. Direct tools read
and write entries, and recent states are refreshed in model context. No separate
agent, service, or memory package is required.

## Install

Requires Linux, Node 22.18+, Pi 1.5.2+, and `flock` from util-linux.

```sh
npm install
pi install /absolute/path/to/pi-presence
```

Create `<Pi agent directory>/presence.json`, normally `~/.pi/agent/presence.json`:

```json
{
  "root": "./pi-presence",
  "user": "user-1",
  "defaultUser": "user-1",
  "agentUser": "agent"
}
```

The default root is `<Pi agent directory>/pi-presence`. Relative roots resolve
against the Pi agent directory; `~` expands to the home directory. Set `root` to
an existing data directory to keep its layout and entries unchanged.

`user` selects a profile. Optional `agentUser` defaults to `agent`; selecting
that alias uses the journal belonging to `defaultUser`. The default owner
normally equals `user`. A configuration selecting the agent alias must specify
`defaultUser`. Set `agentUser` to an existing alias when using an existing setup.
Configuration stays local and is not included in this package.

User selection is a profile binding, not authentication. Host permissions and
Pi control access. Installation and reads do not create journal records. Explicit
writes create missing profile directories when needed.

## Journal layout

```text
<root>/users/<user-id>/presence/
└── <64-character-id>.md
```

Entries use JSON metadata followed by the original text:

```text
---
{"id":"<64-character-id>","created_at":"2026-01-01T00:00:00.000Z"}
---
The complete state text, with its original formatting.
```

Sessions using the same profile share a journal. Pi session IDs identify write
invocations rather than separate journal directories.

## Tools and context

- `presence_write({"text":"..."})` records a state and returns the saved entry
  with its original timestamp. Matching text anywhere in history reuses the
  existing entry. Comparison normalizes Unicode NFC and whitespace; stored
  original wording is preserved.
- `presence_read({"id":"..."})` reads one entry.
- `presence_read({"limit":10})` lists newest-first history. Pass `next_before`
  back as `before` for the next page; `null` means the end. Numeric strings are
  normalized before Pi validates arguments.
- Context includes newest-first distinct states. Writes appear on the next model
  request, including tool continuations and writes made by other Pi sessions.
- Historical states are context, not instructions, objective facts, or a
  requirement to retain the same state. An empty or unavailable journal does not
  establish a state. The package never generates a state entry on its own.
- Damaged entries are preserved and reported while readable entries remain
  usable. An inaccessible journal is reported as unavailable rather than empty.

The default context window is five entries. Optional `contextMessages` in
`presence.json` selects a nonnegative count; zero disables inclusion. Without an
explicit count, `<root>/shared/settings.json` can disable automatic context with
`presenceContextMessages: 0`. Direct tools remain available. Zero does not scan
the journal. Unreadable shared settings report unavailable automatic context
while direct reads and writes remain usable.

The context hook adds one hidden, transient message. It leaves Pi's system
prompt and compaction unchanged and does not append conversation utterances.

## Durable writes and recovery

Entries are synced and published without overwriting existing files. A stable
invocation-derived ID and frozen timestamp survive interruption. A retry intent
with owner-only permissions is retained under `<agentDir>/pi-presence/pending/`
before publication. Startup and `/presence recover` retry it with its original
directory binding. Accepted results remain authoritative if queue cleanup fails.

Pi writers serialize through an OS-owned lock that releases after a process
crash. The journal contains `.pi-presence.lock` and may briefly contain temporary
publication files; neither is a journal entry. Other applications retain their
own coordination. Files remain non-overwriting, and context suppresses matching states.

## Commands

- `/presence`: show the selected journal, context count, and configuration path.
- `/presence user user-1`: select a profile; the agent alias uses the default owner.
- `/presence context 5`: session-specific context count; zero disables inclusion.
- `/presence reset`: follow the configuration again.
- `/presence recover`: retry unfinished writes for the selected journal.

Preferences follow Pi resume, forks, and branch navigation. Configuration changes
apply on the next request. Existing Pi sessions can load the package with `/reload`.

## Development

```sh
npm run check
npm pack --dry-run
```

Tests use temporary profiles, generic fixtures, and controlled Pi contexts. They
do not read deployment journals, start agents, or call inference services.
