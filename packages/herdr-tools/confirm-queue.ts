/** One native confirmation at a time. Pi's interactive selector replaces an
 * open dialog without settling the earlier promise, so two concurrent
 * ctx.ui.confirm calls leave one of them waiting forever (the parallel
 * herdr_dispatch deadlock). Every confirmation in the extension goes through
 * one queue: a call renders only after the previous dialog has settled, and a
 * call whose signal aborts while waiting leaves the queue without rendering. */
export type ConfirmUI = {
  confirm(
    title: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
};

export class ConfirmQueue {
  private active = false;
  private waiters: Array<() => void> = [];

  /** Calls waiting behind the dialog that is currently open. */
  get waiting(): number {
    return this.waiters.length;
  }

  async confirm(
    ui: ConfirmUI,
    title: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.active) {
      const proceed = await new Promise<boolean>((resolve) => {
        const start = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        };
        const onAbort = () => {
          this.waiters = this.waiters.filter((waiter) => waiter !== start);
          resolve(false);
        };
        this.waiters.push(start);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (!proceed) return false;
    } else this.active = true;
    try {
      const behind = this.waiters.length;
      return await ui.confirm(
        behind ? `${title} (${behind} more waiting)` : title,
        message,
        signal ? { signal } : undefined,
      );
    } finally {
      // Hand the dialog slot straight to the next waiter; `active` stays set.
      const next = this.waiters.shift();
      if (next) next();
      else this.active = false;
    }
  }
}
