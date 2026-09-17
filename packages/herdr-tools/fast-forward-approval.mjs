import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Deliberately a tiny command grammar, not a shell parser or a sandbox.
// No expansions, shell tails, Git configuration flags, or symbolic revisions.
export function parseFastForward(command) {
  const match = /^(?:rtk[ \t]+(?:proxy[ \t]+)?)?git[ \t]+(?:-C[ \t]+(?:'([-\w./ :]+)'|"([-\w./ :]+)"|([-\w./:]+))[ \t]+)?merge[ \t]+--ff-only[ \t]+([a-fA-F0-9]{40}|[a-fA-F0-9]{64})[ \t]*$/.exec(command);
  if (!match) return null;
  return { cwd: match[1] ?? match[2] ?? match[3] ?? ".", commit: match[4].toLowerCase() };
}

// Returns an approval for this one tool invocation only. The caller's shell
// still executes the exact original command; no reset or alternate mutation.
export async function approveFastForward(command, context, ports) {
  const request = parseFastForward(command);
  if (!request) throw new Error("Only a standalone git merge --ff-only <full commit ID> can request approval.");
  const owner = ports.rootIdentity();
  if (!owner) throw new Error("Local integration approval requires the verified controller-mapped root.");
  if (context.mode !== "tui" || !context.hasUI)
    throw new Error("Local integration requires native TUI confirmation from the root.");
  const inputPath = resolve(context.cwd, request.cwd);
  const checkout = await realpath(inputPath);
  const git = (...args) => ports.git(["-C", checkout, ...args]);
  async function snapshot() {
    if (await realpath(inputPath) !== checkout) throw new Error("Checkout path changed during approval.");
    const top = await realpath(await git("rev-parse", "--show-toplevel"));
    if (top !== checkout) throw new Error("Use the checkout root as the integration target.");
    const branch = await git("symbolic-ref", "--quiet", "HEAD");
    const head = await git("rev-parse", "HEAD");
    const target = await git("rev-parse", "--verify", `${request.commit}^{commit}`);
    if (target !== request.commit) throw new Error("Target must be the exact commit object ID.");
    if (await git("status", "--porcelain", "--untracked-files=all"))
      throw new Error("Integration checkout must be clean, including untracked files.");
    await git("merge-base", "--is-ancestor", head, target);
    return { checkout, branch, head, target };
  }
  const before = await snapshot();
  const approved = await context.ui.confirm("Approve local fast-forward", [
    `Checkout: ${checkout}`, `Branch: ${before.branch}`,
    `From: ${before.head}`, `To: ${before.target}`,
    `Command: ${command}`, "Applies only to this invocation; no push or resource cleanup.",
  ].join("\n"));
  if (!approved) return false;
  if (ports.rootIdentity() !== owner) throw new Error("Root registration changed during approval.");
  if (JSON.stringify(await snapshot()) !== JSON.stringify(before))
    throw new Error("Checkout changed during approval; request a fresh confirmation.");
  return true;
}
