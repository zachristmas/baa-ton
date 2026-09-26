/**
 * Blocked lanes, handled from Herdr's own events. When a mapped lane turns
 * `blocked`, the controller reads only that pane's visible screen (about 30
 * lines), classifies what it shows and either approves a known-safe
 * permission prompt with keys, or opens a lane request for the root with a
 * bounded default. The supervisor's existing tick applies the root's answer,
 * or the default once it is due. Nothing polls and no session transcript is
 * read, except at most its last 256 KB when a command box is truncated.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Loaded on first use: the supervisor and every other hook run without it.
let knownSafe;
const loadKnownSafe = async () => (knownSafe ??= await import("../herdr-tools/known-safe.mjs"));

export const SCREEN_LINES = 30;
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** How long the root has to answer a screen prompt before the default applies. */
export const SCREEN_PROMPT_DEFAULT_MS = 10 * 60_000;
const DECISION_LOG_MAX = 200;

const BOX = /[│┃║╭╮╰╯─━═┌┐└┘╔╗╚╝]/g;
const OPTION = /^\s*([❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const PERMISSION_QUESTION =
  /^\s*(Do you want to (?:proceed|make this edit|create|allow|run|fetch)[^?]*\?|Would you like to (?:run|make|allow)[^?]*\?|Allow (?:this|the following)[^?]*\?)\s*$/i;
const TOOL_HEADERS = [
  [/^\s*Bash(?: command)?\s*$/i, "Bash"],
  [/^\s*(?:Edit|Update) file\s*$/i, "Edit"],
  [/^\s*(?:Create|Write) file\s*$/i, "Write"],
  [/^\s*Fetch\s*$/i, "WebFetch"],
];
const TRUNCATED = /…|\.\.\.\s*$|\(ctrl\+[a-z] to expand\)|\+\d+ (?:more )?lines?/i;

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The last SCREEN_LINES lines of a screen read, box drawing removed. */
export function screenLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(BOX, " ").replace(/\s+$/, ""))
    .slice(-SCREEN_LINES);
}

const FOOTER = /Enter to (?:select|confirm)|Esc to cancel|↑\/↓ to navigate|Tab\/Arrow keys|arrow keys to navigate/i;
/** Free-text and chat entries Claude adds to every question; never an answer. */
const FREE_TEXT = /^(?:Type something\.?|Chat about this|Other)$/i;

/**
 * Numbered options from `from` on, numbered 1, 2, 3... Lines between them
 * (the option descriptions Claude's question dialog shows, separators) are
 * skipped; the footer or a non-consecutive number ends the list.
 */
function parseOptions(lines, from) {
  const options = [];
  for (let index = from; index < lines.length; index += 1) {
    if (FOOTER.test(lines[index])) break;
    const match = OPTION.exec(lines[index]);
    const expected = options.length ? options.at(-1).number + 1 : 1;
    if (!match || Number(match[2]) !== expected) {
      // Before the first option only blank lines may come.
      if (!options.length && lines[index].trim()) break;
      continue;
    }
    const label = match[3].trim();
    options.push({
      number: Number(match[2]),
      label,
      selected: Boolean(match[1]),
      ...(/\(recommended\)/i.test(label) ? { recommended: true } : {}),
      ...(FREE_TEXT.test(label) ? { freeText: true } : {}),
    });
  }
  return options;
}

/**
 * What a blocked lane's screen shows: a permission prompt (tool, command
 * when shown, options), a question dialog (question, options, the
 * Recommended one), or unknown. `fingerprint` identifies the prompt so a
 * send can re-check that the same one is still on screen.
 */
export function classifyScreen(text) {
  const lines = screenLines(text);
  const questionAt = lines.findLastIndex((line) => PERMISSION_QUESTION.test(line));
  if (questionAt >= 0) {
    const options = parseOptions(lines, questionAt + 1);
    const yes = options.find((option) => /^yes\b/i.test(option.label));
    if (yes) {
      let headerAt = -1;
      let toolName;
      for (let index = questionAt - 1; index >= 0 && headerAt < 0; index -= 1)
        for (const [pattern, name] of TOOL_HEADERS)
          if (pattern.test(lines[index])) {
            headerAt = index;
            toolName = name;
            break;
          }
      const body = headerAt >= 0 ? lines.slice(headerAt + 1, questionAt).map((line) => line.trim()).filter(Boolean) : [];
      // Claude shows the command, then its own one-line description.
      const commandLines = toolName === "Bash" && body.length > 1 ? body.slice(0, -1) : body;
      const command = toolName === "Bash" ? commandLines.join("\n") : undefined;
      const truncated = Boolean(command) && commandLines.some((line) => TRUNCATED.test(line));
      const block = lines.slice(Math.max(0, headerAt), questionAt + 1 + options.length + 1).join("\n");
      return {
        kind: "permission",
        toolName: toolName ?? "unknown",
        ...(toolName === "Bash" ? { command, truncated } : {}),
        ...(toolName && toolName !== "Bash" && body[0] ? { target: body[0] } : {}),
        question: lines[questionAt].trim(),
        options,
        approveKeys: [String(yes.number)],
        denyKeys: ["esc"],
        fingerprint: sha(block),
      };
    }
  }
  // A question dialog: the newest "1." option list with at least two real
  // options, under the question text (which may wrap over lines and need
  // not end in "?"), with the dialog footer, a cursor or a "?" to tell it
  // from an ordinary numbered list in the output.
  const footer = lines.some((line) => FOOTER.test(line));
  for (let first = lines.length - 1; first >= 0; first -= 1) {
    const match = OPTION.exec(lines[first]);
    if (!match || match[2] !== "1") continue;
    const options = parseOptions(lines, first);
    if (options.filter((option) => !option.freeText).length < 2) continue;
    let end = first - 1;
    while (end >= 0 && !lines[end].trim()) end -= 1;
    let start = end;
    while (start > 0 && end - start < 3 && lines[start - 1].trim() && !OPTION.test(lines[start - 1])) start -= 1;
    const questionLines = lines.slice(Math.max(0, start), end + 1).map((line) => line.trim()).filter((line) => line && !/[←→]|✔ Submit/.test(line));
    const question = questionLines.join(" ");
    if (!question || !(footer || options.some((option) => option.selected) || /\?/.test(question))) continue;
    const recommended = options.find((option) => option.recommended && !option.freeText);
    const block = [question, ...options.map((option) => `${option.number}. ${option.label}`)].join("\n");
    return {
      kind: "question",
      question,
      options,
      ...(recommended ? { recommended: recommended.number } : {}),
      denyKeys: ["esc"],
      fingerprint: sha(block),
    };
  }
  // An unnumbered option list (some dialogs mark only the cursor): a block
  // of short sibling lines around a cursor line. Too ambiguous to act on
  // unless exactly one option is marked Recommended.
  const cursorAt = lines.findLastIndex((line) => /^\s*[❯›▶]\s+\S/.test(line));
  if (cursorAt >= 0) {
    const indent = /^(\s*)/.exec(lines[cursorAt].replace(/[❯›▶]/, " "))[1].length;
    const sibling = (line) => line.trim() && !FOOTER.test(line) && (/^\s*[❯›▶]\s+\S/.test(line) || /^(\s*)/.exec(line)[1].length === indent);
    let first = cursorAt;
    while (first > 0 && sibling(lines[first - 1])) first -= 1;
    let last = cursorAt;
    while (last < lines.length - 1 && sibling(lines[last + 1])) last += 1;
    const labels = lines.slice(first, last + 1).map((line) => line.replace(/^\s*[❯›▶]?\s*/, "").trim());
    const options = labels.map((label, index) => ({
      number: index + 1,
      label,
      selected: first + index === cursorAt,
      ...(/\(recommended\)/i.test(label) ? { recommended: true } : {}),
      ...(FREE_TEXT.test(label) ? { freeText: true } : {}),
    }));
    let end = first - 1;
    while (end >= 0 && !lines[end].trim()) end -= 1;
    let start = end;
    while (start > 0 && end - start < 3 && lines[start - 1].trim()) start -= 1;
    const question = lines.slice(Math.max(0, start), end + 1).map((line) => line.trim()).filter((line) => line && !/[←→]|✔ Submit/.test(line)).join(" ");
    if (question && options.length >= 2 && options.filter((option) => option.recommended).length === 1 && labels.every((label) => label.length <= 120)) {
      const recommended = options.find((option) => option.recommended);
      return {
        kind: "question",
        unnumbered: true,
        question,
        options,
        recommended: recommended.number,
        denyKeys: ["esc"],
        fingerprint: sha([question, ...labels].join("\n")),
      };
    }
  }
  return { kind: "unknown", fingerprint: sha(lines.join("\n")) };
}

const DIRECTION_CUE =
  /\b(should I|shall I|do you want|would you like|want me to|which (?:one|option|approach)|how (?:should|do you want)|let me know|please confirm|your call|ok to proceed|okay to proceed|go ahead\?|approve)\b/i;
const INPUT_LINE = /^\s*(?:[>❯›]\s*|\? for shortcuts|esc to interrupt|⏵⏵|bypass permissions|accept edits)/i;

/**
 * An idle lane whose last output asks for direction in plain text (not a
 * dialog). Returns the question block, or undefined.
 */
export function classifyIdleScreen(text) {
  const lines = screenLines(text);
  let end = lines.length - 1;
  // Skip the input box and status footer below the agent's last output.
  while (end >= 0 && (!lines[end].trim() || INPUT_LINE.test(lines[end]))) end -= 1;
  for (let index = end; index >= Math.max(0, end - 8); index -= 1) {
    const line = lines[index];
    if (!DIRECTION_CUE.test(line) || !(/\?\s*$/.test(line) || /let me know|please confirm/i.test(line))) continue;
    let start = index;
    while (start > 0 && index - start < 6 && lines[start - 1].trim()) start -= 1;
    const question = lines.slice(start, end + 1).map((item) => item.trim()).filter(Boolean).join("\n");
    return { kind: "idle-question", question, fingerprint: sha(question) };
  }
  return undefined;
}

/**
 * On `done` for a mapped lane without a receipt: a plain-text question for
 * direction becomes a lane request for the root, with a default message
 * after the bounded wait.
 */
export async function handleIdleLane({ herdr, workflow, laneId, paneId, target = paneId, timestamp }) {
  const lane = (workflow.lanes ?? []).find((item) => item.id === laneId);
  if (lane?.completionReceipt) return { status: "has-receipt" };
  let text;
  try {
    text = await readScreen(herdr, target, paneId);
  } catch (error) {
    return { status: "unread", reason: error instanceof Error ? error.message : String(error) };
  }
  const screen = classifyIdleScreen(text);
  if (!screen) return { status: "no-question" };
  const requests = (workflow.laneRequests ??= []);
  const existing = requests.find((request) => request.laneId === laneId && request.screenPrompt?.fingerprint === screen.fingerprint);
  if (existing) return { status: "already-open", requestId: existing.id };
  const id = `req-idle-${screen.fingerprint.slice(0, 10)}`;
  const defaultAt = new Date(Date.parse(timestamp) + SCREEN_PROMPT_DEFAULT_MS).toISOString();
  requests.push({
    id,
    workflowId: workflow.id,
    laneId,
    kind: "approval",
    payload: { text: screen.question },
    summary: `lane stopped with a question: ${screen.question.replace(/\s+/g, " ").slice(0, 200)}`,
    status: "open",
    requestedAt: timestamp,
    note: `answer with herdr_request grant and the answer in the note (it reaches the lane). Default at ${defaultAt}: the lane decides under its goal rules`,
    screenPrompt: {
      kind: "idle-question",
      paneId,
      fingerprint: screen.fingerprint,
      defaultAt,
      default: {
        decision: "granted",
        reason: "no answer; the lane decides under its goal rules",
        text: "Nobody answered your question in time. Decide it yourself under your goal rules: take the option you recommended, or else the most conservative one that stays inside your item's scope. Say which one in your receipt, and carry on without asking again.",
      },
    },
  });
  (workflow.evidence ??= []).push({ at: timestamp, kind: "idle-question-routed", text: `${id} ${laneId}: ${screen.question.replace(/\s+/g, " ").slice(0, 200)}` });
  return { status: "routed", requestId: id };
}

/** Claude Code's transcript for a session in a worktree. */
export function claudeTranscriptPath(worktree, sessionId, home = os.homedir()) {
  return join(home, ".claude", "projects", String(worktree).replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** At most the last TRANSCRIPT_TAIL_BYTES of a file; undefined when unreadable. */
export async function readTail(path, bytes = TRANSCRIPT_TAIL_BYTES) {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/**
 * The full command of the newest Bash tool call in a transcript tail whose
 * first line starts like the truncated one on screen.
 */
export function commandFromTail(tail, shownCommand) {
  const prefix = String(shownCommand ?? "").split("\n")[0].replace(TRUNCATED, "").replace(/….*$/, "").trim().slice(0, 60);
  if (!tail || !prefix) return undefined;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"tool_use"')) continue;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue; // the first line of the tail is usually cut
    }
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const part of [...content].reverse())
      if (part?.type === "tool_use" && part.name === "Bash" && typeof part.input?.command === "string" && part.input.command.trim().startsWith(prefix))
        return part.input.command;
  }
  return undefined;
}

function laneWorktree(workflow, lane) {
  return lane?.sessionLog?.worktree ?? lane?.worktree ?? workflow?.worktree ?? workflow?.cwd;
}

export async function readScreen(herdr, target, paneId) {
  const result = await herdr.request("agent.read", { target, source: "visible", lines: SCREEN_LINES, strip_ansi: true });
  const read = result?.read;
  if (result?.type !== "pane_read" || !read || read.pane_id !== paneId || typeof read.text !== "string")
    throw new Error("Herdr agent.read returned an invalid response.");
  return read.text;
}

const execFileAsync = promisify(execFile);

/** `herdr agent send-keys <pane> <key>...`; tests pass herdr.sendKeys. */
export async function sendKeys(herdr, paneId, keys) {
  if (typeof herdr.sendKeys === "function") return herdr.sendKeys(paneId, keys);
  return execFileAsync("herdr", ["agent", "send-keys", paneId, ...keys], { timeout: 5_000 });
}

/**
 * Right before any keys: the same agent is live in the pane, still blocked,
 * and the same prompt is still on screen.
 */
async function recheck(herdr, { paneId, agentKind, fingerprint }) {
  let agent;
  try {
    const result = await herdr.request("agent.get", { target: paneId });
    const info = result?.result ?? result;
    agent = info?.type === "agent_info" ? info.agent : undefined;
  } catch (error) {
    return { ok: false, reason: `agent check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!agent?.agent || agent.pane_id !== paneId) return { ok: false, reason: "no agent in the pane" };
  if (agentKind && agent.agent !== agentKind) return { ok: false, reason: `the pane now runs ${agent.agent}` };
  if (agent.agent_status !== "blocked") return { ok: false, reason: `the agent is ${agent.agent_status ?? "in an unknown state"}, not blocked` };
  let screen;
  try {
    screen = classifyScreen(await readScreen(herdr, paneId, paneId));
  } catch (error) {
    return { ok: false, reason: `screen read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (screen.fingerprint !== fingerprint) return { ok: false, reason: "the prompt is no longer on screen" };
  return { ok: true };
}

export function recordUnattendedDecision(manifest, entry) {
  const log = (manifest.unattendedDecisions ??= []);
  log.push({ ...entry, reviewed: false });
  if (log.length > DECISION_LOG_MAX) log.splice(0, log.length - DECISION_LOG_MAX);
}

function summaryFor(screen) {
  if (screen.kind === "permission")
    return `permission prompt on screen: ${screen.toolName}${screen.command ? ` ${screen.command.replace(/\s+/g, " ").slice(0, 160)}` : screen.target ? ` ${screen.target}` : ""}`;
  return `question dialog on screen: ${screen.question.slice(0, 140)} [${screen.options.map((option) => `${option.number}. ${option.label}`).join(" / ").slice(0, 200)}]`;
}

/** The bounded default for a prompt nobody answers. */
function defaultFor(screen, worktree, { laneConfinedVerdict }) {
  if (screen.kind === "question") {
    const recommended = screen.options.find((option) => option.number === screen.recommended);
    return recommended
      ? { decision: "granted", keys: [String(recommended.number)], reason: `took the Recommended option: ${recommended.label}` }
      : {
          decision: "denied",
          keys: screen.denyKeys,
          reason: "no Recommended option; dismissed",
          text: "Nobody answered your question in time. Decide it yourself under your goal rules: take the most conservative option that stays inside your item's scope, say which one in your receipt, and carry on.",
        };
  }
  const input = screen.toolName === "Bash" ? { command: screen.command ?? "" } : { file_path: screen.target ?? "" };
  const verdict = screen.truncated ? { allow: false, reason: "the full command could not be read" } : laneConfinedVerdict(screen.toolName, input, { cwd: worktree });
  return verdict.allow
    ? { decision: "granted", keys: screen.approveKeys, reason: `policy default: ${verdict.reason}` }
    : {
        decision: "denied",
        keys: screen.denyKeys,
        reason: `policy default: ${verdict.reason}`,
        text: `That step was denied by the unattended policy: ${verdict.reason}. Find a way that stays inside your worktree and scratch, or ask the root with herdr_request.`,
      };
}

/**
 * On `blocked` for a mapped lane. Returns what it did; never throws for
 * a read or send failure (the event is still recorded as blocked).
 */
export async function handleBlockedLane({ herdr, manifest, workflow, laneId, paneId, target = paneId, agentKind, timestamp, readTranscriptTail = readTail, home }) {
  let text;
  try {
    text = await readScreen(herdr, target, paneId);
  } catch (error) {
    return { status: "skipped", reason: `screen read failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const screen = classifyScreen(text);
  if (screen.kind === "unknown") return { status: "none", reason: "no permission prompt or question dialog on the visible screen", lines: screenLines(text).length };
  let rules;
  try {
    rules = await loadKnownSafe();
  } catch (error) {
    return { status: "skipped", reason: `known-safe rules could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lane = (workflow.lanes ?? []).find((item) => item.id === laneId);
  const worktree = laneWorktree(workflow, lane);
  if (screen.kind === "permission" && screen.toolName === "Bash" && screen.truncated) {
    const session = lane?.sessionLog?.sessionRef;
    if (worktree && session?.provider === "claude" && session.sessionId) {
      const full = commandFromTail(await readTranscriptTail(claudeTranscriptPath(worktree, session.sessionId, home)), screen.command);
      if (full) {
        screen.command = full;
        screen.truncated = false;
      }
    }
  }
  const requests = (workflow.laneRequests ??= []);
  const existing = requests.find((request) => request.laneId === laneId && request.screenPrompt?.fingerprint === screen.fingerprint && !request.screenPrompt.applied);
  if (existing) return { status: "routed", reason: "request already open for this prompt", requestId: existing.id, kind: screen.kind };
  if (screen.kind === "permission" && screen.toolName === "Bash" && !screen.truncated && screen.command) {
    const verdict = rules.classifyCommand(screen.command, { cwd: worktree });
    if (verdict.decision === "allow") {
      const check = await recheck(herdr, { paneId, agentKind, fingerprint: screen.fingerprint });
      if (!check.ok) return { status: "skipped", reason: check.reason };
      try {
        await sendKeys(herdr, paneId, screen.approveKeys);
      } catch (error) {
        return { status: "skipped", reason: `send-keys failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      (workflow.evidence ??= []).push({ at: timestamp, kind: "screen-prompt-approved", text: `${laneId}: known-safe (${verdict.rules.join(", ")}): ${screen.command.replace(/\s+/g, " ").slice(0, 200)}` });
      return { status: "approved", rules: verdict.rules };
    }
  }
  const id = `req-screen-${screen.fingerprint.slice(0, 10)}`;
  const fallback = defaultFor(screen, worktree, rules);
  const request = {
    id,
    workflowId: workflow.id,
    laneId,
    kind: screen.kind === "permission" ? "permission" : "approval",
    payload:
      screen.kind === "permission"
        ? { toolName: screen.toolName, input: screen.command ? { command: screen.command } : { file_path: screen.target ?? "" } }
        : { text: `${screen.question}\n${screen.options.map((option) => `${option.number}. ${option.label}`).join("\n")}` },
    summary: summaryFor(screen),
    status: "open",
    requestedAt: timestamp,
    note:
      screen.kind === "question"
        ? `grant with the option number (or label) in the note; deny to dismiss it. Default at ${new Date(Date.parse(timestamp) + SCREEN_PROMPT_DEFAULT_MS).toISOString()}: ${fallback.reason}`
        : `grant approves it on screen, deny dismisses it. Default at ${new Date(Date.parse(timestamp) + SCREEN_PROMPT_DEFAULT_MS).toISOString()}: ${fallback.reason}`,
    screenPrompt: {
      kind: screen.kind,
      paneId,
      ...(agentKind ? { agentKind } : {}),
      fingerprint: screen.fingerprint,
      options: screen.options,
      approveKeys: screen.approveKeys,
      denyKeys: screen.denyKeys,
      defaultAt: new Date(Date.parse(timestamp) + SCREEN_PROMPT_DEFAULT_MS).toISOString(),
      default: fallback,
    },
  };
  requests.push(request);
  (workflow.evidence ??= []).push({ at: timestamp, kind: "screen-prompt-routed", text: `${id} ${laneId}: ${request.summary}` });
  return { status: "routed", requestId: id, kind: screen.kind };
}

function optionFromNote(note, options) {
  const text = String(note ?? "").trim();
  const number = /^(?:option\s*)?#?(\d{1,2})\b/i.exec(text)?.[1];
  if (number && options.some((option) => option.number === Number(number))) return Number(number);
  const lower = text.toLowerCase();
  const byLabel = options.find((option) => lower && option.label.toLowerCase().replace(/\s*\(recommended\)\s*/i, "").startsWith(lower.slice(0, 40)));
  return byLabel?.number;
}

/**
 * Supervisor tick: apply the root's answer to each screen prompt, or the
 * bounded default once it is due. Returns whether the manifest changed.
 */
export async function resolveScreenPrompts({ herdr, manifest, workflow, timestamp }) {
  let changed = false;
  for (const request of Array.isArray(workflow?.laneRequests) ? workflow.laneRequests : []) {
    const prompt = request?.screenPrompt;
    if (!prompt || prompt.applied) continue;
    if (request.status === "open") {
      if (Date.parse(timestamp) < Date.parse(prompt.defaultAt)) continue;
      request.status = prompt.default.decision;
      request.answeredBy = "policy";
      request.answeredAt = timestamp;
      request.note = `unattended default after ${Math.round(SCREEN_PROMPT_DEFAULT_MS / 60_000)} min with no answer: ${prompt.default.reason}`;
      if (prompt.default.keys) prompt.keys = prompt.default.keys;
      if (prompt.default.text) request.answerDelivery = { status: "pending", updatedAt: timestamp, text: `[Baa-ton request answer] ${request.id}: ${request.status}. ${prompt.default.text}` };
      recordUnattendedDecision(manifest, { at: timestamp, kind: `lane-${prompt.kind}`, workflowId: workflow.id, laneId: request.laneId, requestId: request.id, summary: request.summary, decision: request.status, reason: prompt.default.reason });
      (workflow.evidence ??= []).push({ at: timestamp, kind: "unattended-default", text: `${request.id} ${request.laneId}: ${request.status}: ${prompt.default.reason}` });
      changed = true;
    }
    if (prompt.kind === "idle-question") {
      // Answered by message, never by keys: the root's answer went out with
      // herdr_request, the default through the lane queue.
      prompt.applied = { at: timestamp, via: request.answeredBy === "policy" ? "default-message" : "root-answer" };
      changed = true;
      continue;
    }
    if (!prompt.keys) {
      if (request.status === "granted") {
        const option = prompt.kind === "question" ? optionFromNote(request.note, prompt.options ?? []) : undefined;
        prompt.keys = prompt.kind === "question" ? (option ? [String(option)] : prompt.denyKeys) : prompt.approveKeys;
      } else prompt.keys = prompt.denyKeys;
      changed = true;
    }
    const check = await recheck(herdr, { paneId: prompt.paneId, agentKind: prompt.agentKind, fingerprint: prompt.fingerprint });
    if (!check.ok) {
      // Only a prompt that is gone ends this; a transient check failure retries next tick.
      if (/no longer on screen|not blocked|no agent|now runs/.test(check.reason)) {
        prompt.applied = { at: timestamp, skipped: check.reason };
        changed = true;
      }
      continue;
    }
    try {
      await sendKeys(herdr, prompt.paneId, prompt.keys);
      prompt.applied = { at: timestamp, keys: prompt.keys };
    } catch (error) {
      prompt.applied = { at: timestamp, keys: prompt.keys, uncertain: error instanceof Error ? error.message : String(error) };
    }
    changed = true;
  }
  return changed;
}
