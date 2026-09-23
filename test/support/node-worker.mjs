import { parentPort } from "node:worker_threads";
import { startWorker } from "../../dist/worker.js";

startWorker({
  postMessage: (message) => parentPort.postMessage(message),
  onMessage: (listener) => parentPort.on("message", listener),
});
