export class LifecycleResources {
  #cleanups: Array<() => void | Promise<void>> = [];
  #stopped = false;

  add(cleanup: () => void | Promise<void>): void {
    if (this.#stopped) {
      void cleanup();
      return;
    }
    this.#cleanups.push(cleanup);
  }

  addTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
    this.add(() => clearTimeout(timer));
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const cleanups = this.#cleanups.splice(0).reverse();
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "One or more bridge cleanup operations failed");
  }
}
