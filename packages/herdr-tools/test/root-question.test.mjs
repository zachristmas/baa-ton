import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_QUESTION_AUTO_ANSWER_MS, autoAnswerPlan, autoAnswerText, createQuestionTimers, parseQuestions } from "../root-question.mjs";

const round = (question, options) => ({ questions: [{ question, header: "Choice", options }] });

test("the Recommended option is found in the common question shapes", () => {
  assert.deepEqual(parseQuestions(round("Which fixture layout?", [{ label: "One file per item (Recommended)", description: "x" }, { label: "One shared file" }]))[0].options, [
    { label: "One file per item", recommended: true },
    { label: "One shared file", recommended: false },
  ]);
  assert.equal(parseQuestions({ question: "Order?", options: ["A first", "B first (Recommended)"] })[0].options[1].recommended, true);
  assert.equal(parseQuestions({ questions: [{ question: "Order?", options: ["A", "B"], recommended: "B" }] })[0].options[1].recommended, true);
  assert.equal(parseQuestions({ questions: [{ question: "Order?", options: [{ label: "A", recommended: true }, { label: "B" }] }] })[0].options[0].recommended, true);
});

test("eligible only with one Recommended option per question and nothing a person must decide", () => {
  const plan = autoAnswerPlan(round("Which fixture layout?", ["One file per item (Recommended)", "One shared file"]));
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.answers, [{ question: "Which fixture layout?", answer: "One file per item" }]);
  assert.match(autoAnswerText(plan), /One file per item/);
  assert.match(autoAnswerText(plan), /logged for the user's review/);

  const firstByDefault = autoAnswerPlan(round("Which layout?", ["A", "B"]));
  assert.deepEqual(firstByDefault.answers, [{ question: "Which layout?", answer: "A", byDefault: true }], "no Recommended option: the first option is the policy default");
  assert.match(autoAnswerPlan(round("Which layout?", ["A (Recommended)", "B (Recommended)"])).reason, /more than one/);
  for (const [question, options] of [
    ["Which of these fits? [unclear-requirements]", ["A (Recommended)", "B"]],
    ["Deploy the preview?", ["Yes (Recommended)", "No"]],
    ["Run the migration against production?", ["Yes (Recommended)", "No"]],
    ["Add bulk export while we are here?", ["Yes, new scope (Recommended)", "No"]],
  ])
    assert.equal(autoAnswerPlan(round(question, options)).eligible, false, question);
  assert.equal(autoAnswerPlan(round("Name the product module?", ["core (Recommended)", "base"])).eligible, true, "product is not prod");
  assert.equal(autoAnswerPlan({}).eligible, false);
});

test("the timer fires once after the wait; an answer first disarms it", () => {
  const scheduled = [];
  const timers = createQuestionTimers({
    schedule: (callback, ms) => {
      scheduled.push({ callback, ms, cancelled: false });
      return scheduled.length - 1;
    },
    cancel: (handle) => {
      scheduled[handle].cancelled = true;
    },
  });
  let due = 0;
  timers.start("call-1", () => due++);
  timers.start("call-1", () => due++);
  assert.equal(scheduled.length, 1, "one timer per question");
  assert.equal(scheduled[0].ms, ROOT_QUESTION_AUTO_ANSWER_MS);
  assert.equal(ROOT_QUESTION_AUTO_ANSWER_MS, 5 * 60_000);
  scheduled[0].callback();
  assert.equal(due, 1);
  assert.equal(timers.settle("call-1"), true, "the default already fired");

  timers.start("call-2", () => due++);
  assert.equal(timers.settle("call-2"), false, "answered in time");
  assert.equal(scheduled[1].cancelled, true);
  assert.equal(timers.pending("call-2"), false);
});
