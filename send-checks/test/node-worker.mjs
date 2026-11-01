// A browser-shaped Worker running the pattern worker's code in a Node thread, for tests.
import { Worker as NodeWorker } from 'node:worker_threads';
import { WORKER_SOURCE } from '../src/lib/pattern-runner.js';

/** A Worker shaped like the browser's, running WORKER_SOURCE in a Node thread. */
export function nodeWorker() {
  const code = `
const { parentPort } = require('node:worker_threads');
const self = { postMessage: (m) => parentPort.postMessage(m) };
${WORKER_SOURCE}
parentPort.on('message', (m) => self.onmessage({ data: m }));
`;
  const thread = new NodeWorker(code, { eval: true });
  const worker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (m) => thread.postMessage(m),
    terminate: () => { worker.terminated = true; return thread.terminate(); },
  };
  thread.on('message', (m) => worker.onmessage?.({ data: m }));
  thread.on('error', (e) => worker.onerror?.(e));
  return worker;
}
