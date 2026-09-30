import { parentPort } from "node:worker_threads";
import { startWorker } from "../../dist/worker.js";

// Fails on demand before ShellCheck sees the lint: `--test-exit` ends the thread and
// `--test-throw` raises an uncaught exception.
startWorker({
  postMessage: (message) => parentPort.postMessage(message),
  onMessage: (listener) =>
    parentPort.on("message", (message) => {
      if (message.type === "lint" && message.args[0] === "--test-exit") process.exit(7);
      if (message.type === "lint" && message.args[0] === "--test-throw") {
        throw new Error("injected worker failure");
      }
      listener(message);
    }),
});
