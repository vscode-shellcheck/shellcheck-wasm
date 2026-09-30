/*! SPDX-License-Identifier: GPL-3.0-or-later */

import { startWorker } from "./worker.js";

interface DedicatedWorkerSelf {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

declare const self: DedicatedWorkerSelf;

startWorker({
  postMessage: (message) => self.postMessage(message),
  onMessage: (listener) => self.addEventListener("message", (event) => listener(event.data)),
});
