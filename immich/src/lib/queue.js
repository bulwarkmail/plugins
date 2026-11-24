// Thumbnails load a few at a time: the webmail's proxy lets one user run
// only a handful of requests at once and refuses the rest as rate limited.

/** Run at most `limit` tasks at once. `run(task)` resolves like the task. */
export function createQueue(limit = 4) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= limit || waiting.length === 0) return;
    const { task, resolve, reject } = waiting.shift();
    running++;
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      running--;
      next();
    });
  };
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        next();
      });
    },
    /** Drop tasks that haven't started (the list they were for is gone). */
    clear() {
      waiting.splice(0).forEach(({ reject }) => reject(new Error('cancelled')));
    },
  };
}
