import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { ConfirmQueue } = await jiti.import("../confirm-queue.ts");

/** Models Pi's interactive selector: a new dialog replaces the open one and
 * the replaced dialog's promise never settles. */
function piLikeUI() {
  const shown = [];
  let open;
  return {
    shown,
    get open() {
      return open;
    },
    confirm(title, message, opts) {
      return new Promise((resolve) => {
        const dialog = { title, message, answer: (value) => {
          if (open === dialog) open = undefined;
          resolve(value);
        } };
        opts?.signal?.addEventListener("abort", () => dialog.answer(false), { once: true });
        open = dialog;
        shown.push(title);
      });
    },
  };
}

const settled = (promise) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);

test("the fake reproduces the deadlock: unqueued concurrent confirms orphan the first dialog", async () => {
  const ui = piLikeUI();
  const first = ui.confirm("Dispatch A", "");
  const second = ui.confirm("Dispatch B", "");
  assert.equal(ui.open.title, "Dispatch B");
  ui.open.answer(true);
  assert.equal(await second, true);
  assert.equal(ui.open, undefined, "no dialog left to answer");
  assert.equal(await settled(first), false, "first confirm can never settle");
});

test("queued confirms render one at a time and both settle", async () => {
  const ui = piLikeUI();
  const queue = new ConfirmQueue();
  const first = queue.confirm(ui, "Dispatch A", "a");
  const second = queue.confirm(ui, "Dispatch B", "b");
  await new Promise(setImmediate);
  assert.deepEqual(ui.shown, ["Dispatch A"]);
  assert.equal(queue.waiting, 1);
  ui.open.answer(true);
  assert.equal(await first, true);
  await new Promise(setImmediate);
  assert.deepEqual(ui.shown, ["Dispatch A", "Dispatch B"]);
  ui.open.answer(false);
  assert.equal(await second, false);
  assert.equal(queue.waiting, 0);
});

test("a dialog's title counts the callers already waiting behind it", async () => {
  const ui = piLikeUI();
  const queue = new ConfirmQueue();
  const calls = ["A", "B", "C"].map((title) => queue.confirm(ui, title, ""));
  for (let index = 0; index < calls.length; index += 1) {
    await new Promise(setImmediate);
    ui.open.answer(true);
    assert.equal(await calls[index], true);
  }
  assert.deepEqual(ui.shown, ["A", "B (1 more waiting)", "C"]);
});

test("a waiter whose signal aborts leaves the queue without rendering", async () => {
  const ui = piLikeUI();
  const queue = new ConfirmQueue();
  const controller = new AbortController();
  const first = queue.confirm(ui, "A", "");
  const second = queue.confirm(ui, "B", "", controller.signal);
  const third = queue.confirm(ui, "C", "");
  await new Promise(setImmediate);
  controller.abort();
  assert.equal(await second, false);
  assert.equal(queue.waiting, 1);
  ui.open.answer(true);
  assert.equal(await first, true);
  await new Promise(setImmediate);
  assert.equal(ui.open.title, "C");
  ui.open.answer(true);
  assert.equal(await third, true);
  assert.deepEqual(ui.shown, ["A", "C"]);
});

test("an already-aborted signal never renders", async () => {
  const ui = piLikeUI();
  const queue = new ConfirmQueue();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await queue.confirm(ui, "A", "", controller.signal), false);
  assert.deepEqual(ui.shown, []);
});

test("aborting the open dialog passes the slot to the next caller", async () => {
  const ui = piLikeUI();
  const queue = new ConfirmQueue();
  const controller = new AbortController();
  const first = queue.confirm(ui, "A", "", controller.signal);
  const second = queue.confirm(ui, "B", "");
  await new Promise(setImmediate);
  controller.abort();
  assert.equal(await first, false);
  await new Promise(setImmediate);
  assert.equal(ui.open.title, "B");
  ui.open.answer(true);
  assert.equal(await second, true);
});

test("a throwing dialog releases the slot", async () => {
  const queue = new ConfirmQueue();
  const failing = { confirm: async () => { throw new Error("tui gone"); } };
  const ui = piLikeUI();
  const first = queue.confirm(failing, "A", "");
  const second = queue.confirm(ui, "B", "");
  await assert.rejects(first, /tui gone/);
  await new Promise(setImmediate);
  assert.equal(ui.open.title, "B");
  ui.open.answer(true);
  assert.equal(await second, true);
});
