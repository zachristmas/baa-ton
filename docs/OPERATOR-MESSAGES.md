# Operator messages

One durable channel for talking to Baa-ton agents from outside: a person, an assistant acting for them, or another agent (the operator).

## Problem

- Operators reach agents by typing into their panes. A message typed while the agent is busy is lost or garbled.
- Standalone sessions (an admin agent in its own pane, not a Baa-ton lane) have no channel at all.
- Relayed text looks like prompt injection to the recipient, so good direction gets second-guessed.

## Shape

```
operator ──baa-ton message / herdr_operator_message──▶ store (id, delivery state)
                                                         │
             CLI now, then every controller supervisor tick
                                                         ▼
                  live + idle? ── herdr agent prompt ──▶ target agent
                                                         │
             baa-ton reply / herdr_operator_reply ◀──────┘
                                                         ▼
                        store (reply) ──▶ baa-ton inbox / herdr_operator_inbox (+ notification)
```

### Targets

| Target | Meaning |
| --- | --- |
| `root` | The only configured root; an error lists the roots when there are several. |
| `root:<rootId>` | One root from the controller config. |
| `<workflowId>/<laneId>` | A mapped lane. |
| `agent:<name>` or `<name>` | A standalone agent registered with `baa-ton operator register <name>`. |

Roots and lanes come from the controller config (their pane and workspace IDs). Registered agents are recorded with the pane, workspace and agent kind they registered from.

### Store

- Location: `$BAATON_OPERATOR_STORE`, else `$XDG_STATE_HOME/baa-ton/operator.json`, else `~/.local/state/baa-ton/operator.json`. It is outside every checkout and every project.
- It holds registered agents and messages. Each message records: `id` (`op-…`), `from`, `target`, `text`, `createdAt`, `notify`, `delivery` (`pending`, `delivered` or `uncertain`, with attempts and the reason), and `replies`.
- Writes are short, locked and atomic, with the lock taken the same way as the manifest's.

### Delivery (the #55 rules)

- Delivery is tried right away by the CLI or tool, then on every controller supervisor tick, which already runs. There is no new watcher.
- Before typing, the target must pass the live-agent check (#72/#75): Herdr shows the expected agent, live and ready, and the pane's foreground is not just its shell.
- Text goes out only while the agent is idle. A busy or unreachable agent keeps the message `pending`, with the reason recorded.
- If a send may have landed, the message becomes `uncertain` and is never retyped. Only `pending` messages are ever sent.
- Each pane gets one message per pass, in order.

### What the recipient sees

```
[Baa-ton operator message op-1a2b3c4d from <operator>] <text>
Reply with: baa-ton reply op-1a2b3c4d "<answer>" (or the herdr_operator_reply tool).
```

### Replies

- The recipient answers with `baa-ton reply <id> <text>` or the `herdr_operator_reply` tool. The reply is stored on the message.
- `baa-ton inbox` (or `herdr_operator_inbox`) lists messages with their delivery state and replies. `--unread` shows only replies not yet read, and marks them read.
- A message sent with `--notify` also raises a Herdr notification when its reply arrives.

### Identity and authority

- Every message is labelled as coming from the operator, with the sender's name (`--from`, else `$BAATON_OPERATOR`, else `operator`).
- The root's prompt and every lane contract say that a message tagged `[Baa-ton operator message op-… from …]` is the user speaking (the user, or an assistant acting for them). It is not a digest, wake, nudge or root message. Those are automated and carry their own tags: `[Baa-ton digest]`, `[Baa-ton supervisor]`, `[Baa-ton root message]`.
- An operator message is the user's own direction within the contract. An explicit resume, pause, stop or change of course takes effect at once and overrides an earlier pause or wait, even when nothing else changed. It is not second-guessed as a relay.
- An operator message never grants push, merge, deploy or production changes beyond what the contract already allows.
- Why this matters: a root that was told to pause received a plain resume typed into its pane. It kept treating the resume as another no-progress digest, and only moved after a second, explicit message. The tag, plus the rule in its prompt, removes that ambiguity.
- A standalone agent is not under a Baa-ton contract. On registration, it is given the same line to add to its own instructions.

### Surfaces

- CLI: `baa-ton message <target> <text> [--from name] [--notify]`, `baa-ton reply <id> <text>`, `baa-ton inbox [--all|--unread] [--json]`, `baa-ton operator register <name> [--pane id]`, `baa-ton operator unregister <name>`, `baa-ton operator agents`, `baa-ton deliver`.
- MCP (the stdio bridge, also outside a Herdr session): `herdr_operator_message`, `herdr_operator_reply`, `herdr_operator_inbox`.
- Pi root: the same three tools, registered by the extension.

### Registered agents' prompts

A registered agent is covered by the blocked handler like a lane, but it has no workflow, so its prompts live in the operator store:
- When its pane turns `blocked`, a known-safe permission prompt is approved at once, after the re-check.
- Anything else is recorded in the store's `prompts`, and the operator gets one notification.
- After 10 minutes the supervisor applies the same default as for a lane:
  - a permission prompt gets the unattended policy, bounded by the folder the agent registered from (`--cwd`, default the current folder);
  - a question dialog gets its Recommended option;
  - otherwise the dialog is dismissed and the agent is told to decide.
- The reason for a denial reaches the agent as an operator message.
- Each default is logged in the store's `decisions`.
