type Task<T> = () => Promise<T>;

interface Slot {
  tail: Promise<unknown>;
  depth: number;
}

/** Per key serial queue. Same chat+project runs in order; different keys run in parallel. */
export class ChatQueue {
  private slots = new Map<string, Slot>();

  enqueue<T>(key: string, task: Task<T>): Promise<T> {
    const existing = this.slots.get(key);
    const previous = existing?.tail ?? Promise.resolve();
    const next = previous.then(task, task);
    this.slots.set(key, { tail: next, depth: (existing?.depth ?? 0) + 1 });
    next.finally(() => {
      const current = this.slots.get(key);
      if (!current) return;
      if (current.tail === next) this.slots.delete(key);
      else current.depth = Math.max(0, current.depth - 1);
    }).catch(() => {});
    return next;
  }

  depth(key: string): number {
    return this.slots.get(key)?.depth ?? 0;
  }
}
