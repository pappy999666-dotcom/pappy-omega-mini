export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inFlight.get(key);
    if (existing) return { promise: existing, shared: true };
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return { promise, shared: false };
  }

  size(): number {
    return this.inFlight.size;
  }
}
