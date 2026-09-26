#!/usr/bin/env node
/**
 * baa-ton: the operator channel from the command line
 * (docs/OPERATOR-MESSAGES.md).
 *
 *   baa-ton message <target> <text...> [--from <name>] [--notify] [--json]
 *   baa-ton reply <id> <text...> [--from <name>]
 *   baa-ton inbox [--all|--unread] [--json]
 *   baa-ton operator register <name> [--pane <id>] [--workspace <id>] [--kind <agent>]
 *   baa-ton operator unregister <name>
 *   baa-ton operator agents
 *   baa-ton deliver
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deliverOperatorNow,
  formatInbox,
  listAgents,
  readOperatorInbox,
  registerAgent,
  replyToOperator,
  sendOperatorMessage,
  unregisterAgent,
} from "./operator-api.mjs";

const USAGE = `Usage:
  baa-ton message <target> <text...> [--from <name>] [--notify] [--json]
      target: root | root:<id> | <workflowId>/<laneId> | <registered agent>
  baa-ton reply <id> <text...> [--from <name>]
  baa-ton inbox [--all | --unread] [--json]
  baa-ton operator register <name> [--pane <id>] [--workspace <id>] [--kind <agent>]
  baa-ton operator unregister <name>
  baa-ton operator agents
  baa-ton deliver`;

/** Split argv into positionals and --flags (a flag takes the next word unless boolean). */
export function parseArgs(argv, booleans = new Set(["notify", "json", "all", "unread"])) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (word.startsWith("--")) {
      const name = word.slice(2);
      if (booleans.has(name)) flags[name] = true;
      else flags[name] = argv[++index];
    } else positional.push(word);
  }
  return { positional, flags };
}

export async function runOperatorCli(argv, { env = process.env, out = (text) => process.stdout.write(`${text}\n`) } = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "message": {
      const [target, ...words] = positional;
      if (!target || !words.length) throw new Error(USAGE);
      const message = await sendOperatorMessage({ target, text: words.join(" "), from: flags.from, notify: flags.notify, env });
      out(flags.json ? JSON.stringify(message) : `${message.id} -> ${message.resolved.label}: ${message.delivery.status}${message.delivery.reason ? ` (${message.delivery.reason})` : ""}`);
      return message;
    }
    case "reply": {
      const [id, ...words] = positional;
      if (!id || !words.length) throw new Error(USAGE);
      const result = await replyToOperator({ id, text: words.join(" "), from: flags.from, env });
      out(`reply stored on ${result.id}`);
      return result;
    }
    case "inbox": {
      const messages = await readOperatorInbox({ all: flags.all, unread: flags.unread, env });
      out(flags.json ? JSON.stringify(messages) : formatInbox(messages));
      return messages;
    }
    case "deliver": {
      const changed = await deliverOperatorNow({ env });
      out(changed.length ? `delivery changed: ${changed.join(", ")}` : "nothing delivered");
      return changed;
    }
    case "operator": {
      const [sub, name] = positional;
      if (sub === "register" && name) {
        const agent = await registerAgent({ name, paneId: flags.pane, workspaceId: flags.workspace, agentKind: flags.kind, env });
        out(`registered ${name} at pane ${agent.paneId}. Add this to the agent's own instructions:\n${agent.instructions}`);
        return agent;
      }
      if (sub === "unregister" && name) {
        const existed = await unregisterAgent({ name, env });
        out(existed ? `unregistered ${name}` : `${name} was not registered`);
        return existed;
      }
      if (sub === "agents") {
        const agents = await listAgents({ env });
        out(Object.keys(agents).length ? Object.entries(agents).map(([key, agent]) => `${key}: pane ${agent.paneId}${agent.agentKind ? ` (${agent.agentKind})` : ""}`).join("\n") : "No registered agents.");
        return agents;
      }
      throw new Error(USAGE);
    }
    default:
      throw new Error(USAGE);
  }
}

let direct = false;
try {
  direct = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  direct = false;
}
if (direct)
  runOperatorCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`baa-ton: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
