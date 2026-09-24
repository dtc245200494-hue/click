/**
 * Capped request pool derived from the Pool concept in alexfernandez/loadtest (MIT).
 * Difference from upstream: this pool never grows beyond maxConcurrency and only
 * consumes jobs explicitly released by the campaign scheduler.
 */
export class RequestPool {
  constructor(maxConcurrency = 10) {
    this.maxConcurrency = Math.max(1, Number.parseInt(maxConcurrency, 10) || 1);
    this.active = 0;
    this.queue = [];
    this.stopped = false;
  }

  get freeSlots() {
    return Math.max(0, this.maxConcurrency - this.active);
  }

  enqueue(job) {
    if (this.stopped) return false;
    this.queue.push(job);
    this.#pump();
    return true;
  }

  clearPending() {
    const count = this.queue.length;
    this.queue.length = 0;
    return count;
  }

  stop() {
    this.stopped = true;
    this.clearPending();
  }

  #pump() {
    while (!this.stopped && this.active < this.maxConcurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          this.active -= 1;
          queueMicrotask(() => this.#pump());
        });
    }
  }
}
