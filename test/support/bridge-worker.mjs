import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { Bridge } from "../../dist/bridge.js";

// Speaks the worker protocol without ShellCheck, to exercise the bridge alone: each lint
// arg is "<op> <path>", and stdout is the JSON list of what the bridge returned for each.
let shared;
parentPort.on("message", (message) => {
  if (message.type === "init") {
    shared = message.shared;
    return;
  }
  const bridge = new Bridge(shared, (reply) => parentPort.postMessage(reply));
  const results = message.args.map((request) => {
    const [op, path] = request.split(" ");
    const result = bridge[op](path);
    if (typeof result === "number") return { errno: result };
    if (result instanceof Uint8Array) {
      const sha256 = createHash("sha256").update(result).digest("hex");
      return { size: result.byteLength, sha256 };
    }
    return { value: result };
  });
  parentPort.postMessage({
    type: "done",
    stdout: JSON.stringify(results),
    stderr: "",
    exitCode: 0,
  });
});
