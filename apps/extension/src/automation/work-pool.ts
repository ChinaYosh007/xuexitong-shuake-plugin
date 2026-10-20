/** Bounded in-memory queue. Cancellation is checked by the caller before doing work. */
export class WorkPool {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly concurrency: number) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.active--;
          this.drain();
        });
      });
      this.drain();
    });
  }
  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) this.queue.shift()!();
  }
}
