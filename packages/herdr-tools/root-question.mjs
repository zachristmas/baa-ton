/**
 * The root's own ask_user_question in an autonomous run. The goal rules say
 * "decide, don't ask", yet a root can still open a question round and wait
 * hours. With a spec loop under an acknowledged policy, a question that is
 * not about push, deploy, production or new product scope is answered after
 * ROOT_QUESTION_AUTO_ANSWER_MS with the option the root marked Recommended,
 * logged for the user's review and notified. Handled in-process by the
 * extension, never by reading the screen.
 */

export const ROOT_QUESTION_AUTO_ANSWER_MS = 5 * 60_000;

/** Decisions that stay with a person, whatever the root recommends. */
const HUMAN_ONLY =
  /\b(push(?:es|ed|ing)?|force[- ]push|deploy\w*|production|prod|go[- ]live|publish\w*|release to|ship to|merge (?:it )?(?:in)?to main|new (?:product )?scope|scope (?:change|expansion|increase)|out of scope|expand(?:ing)? (?:the )?scope|new feature)\b/i;

const RECOMMENDED = /\s*\((?:recommended)\)\s*/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionOf(value) {
  if (typeof value === "string") return { label: value.replace(RECOMMENDED, " ").trim(), recommended: RECOMMENDED.test(value) };
  if (!isRecord(value)) return undefined;
  const raw = String(value.label ?? value.title ?? value.value ?? value.text ?? "");
  if (!raw.trim()) return undefined;
  return {
    label: raw.replace(RECOMMENDED, " ").trim(),
    recommended: value.recommended === true || RECOMMENDED.test(raw) || RECOMMENDED.test(String(value.description ?? "")),
  };
}

/** Questions and options from an ask_user_question input, whatever its exact shape. */
export function parseQuestions(input) {
  const list = Array.isArray(input?.questions) ? input.questions : isRecord(input) && (input.question || input.options) ? [input] : [];
  return list
    .map((item) => {
      if (typeof item === "string") return { question: item, options: [] };
      if (!isRecord(item)) return undefined;
      const options = (Array.isArray(item.options) ? item.options : Array.isArray(item.choices) ? item.choices : []).map(optionOf).filter(Boolean);
      const named = typeof item.recommended === "string" ? item.recommended : typeof item.recommendation === "string" ? item.recommendation : undefined;
      const index = Number.isInteger(item.recommended) ? item.recommended : undefined;
      for (const [position, option] of options.entries())
        if ((named && option.label.toLowerCase() === named.replace(RECOMMENDED, " ").trim().toLowerCase()) || index === position) option.recommended = true;
      return { question: String(item.question ?? item.header ?? item.prompt ?? "").trim(), options };
    })
    .filter((item) => item && (item.question || item.options.length));
}

/**
 * Whether the question may be answered for the root, and with what. Every
 * question in the round needs exactly one Recommended option, and nothing in
 * it may concern push, deploy, production or new scope.
 */
export function autoAnswerPlan(input) {
  const questions = parseQuestions(input);
  if (!questions.length) return { eligible: false, reason: "no question found in the input" };
  const human = HUMAN_ONLY.exec(JSON.stringify(input ?? {}));
  if (human) return { eligible: false, reason: `it concerns "${human[0]}", which stays with a person` };
  const answers = [];
  for (const item of questions) {
    const recommended = item.options.filter((option) => option.recommended);
    if (recommended.length !== 1)
      return { eligible: false, reason: `${recommended.length ? "more than one" : "no"} Recommended option for "${item.question.slice(0, 80)}"` };
    answers.push({ question: item.question, answer: recommended[0].label });
  }
  return { eligible: true, answers };
}

export function autoAnswerText(plan, minutes = Math.round(ROOT_QUESTION_AUTO_ANSWER_MS / 60_000)) {
  const lines = plan.answers.map((item) => `- ${item.question || "Question"} -> ${item.answer}`);
  return [
    `[Baa-ton unattended default] Nobody answered your question within ${minutes} minutes, so the option you marked Recommended was taken:`,
    ...lines,
    "Proceed with it. It is logged for the user's review; do not ask this question again.",
  ].join("\n");
}

/**
 * One timer per open root question. `start` arms it; `settle` (the tool
 * finished: answered or cancelled) disarms it and reports whether the
 * default already fired.
 */
export function createQuestionTimers({ delayMs = ROOT_QUESTION_AUTO_ANSWER_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const open = new Map();
  const fired = new Map();
  return {
    start(id, onDue) {
      if (open.has(id)) return;
      const handle = schedule(() => {
        open.delete(id);
        fired.set(id, true);
        onDue();
      }, delayMs);
      handle?.unref?.();
      open.set(id, handle);
    },
    settle(id) {
      const handle = open.get(id);
      if (handle !== undefined) cancel(handle);
      open.delete(id);
      const was = fired.get(id) === true;
      fired.delete(id);
      return was;
    },
    pending(id) {
      return open.has(id);
    },
    clear() {
      for (const handle of open.values()) cancel(handle);
      open.clear();
      fired.clear();
    },
  };
}
