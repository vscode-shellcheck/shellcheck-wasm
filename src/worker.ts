import { Bridge } from "./bridge.js";
import { createReadOnlyPreopen } from "./preopen.js";
import type { FromWorker, ToWorker } from "./protocol.js";
import { run } from "./runner.js";

/**
 * The worker's end of its channel to the thread that created it: Node's `parentPort`, or
 * a dedicated Worker's global scope with `onMessage` unwrapping `MessageEvent.data`.
 */
export interface ParentPort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

// ignoreBOM keeps a leading U+FEFF in the output instead of silently dropping it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Serves `createShellCheck` from inside a Worker; call it once from the Worker's entry
 * module. Each lint runs synchronously on a fresh `WebAssembly.Instance`, blocking this
 * thread while the caller's thread answers file-system requests.
 */
export function startWorker(port: ParentPort): void {
  let module: WebAssembly.Module | undefined;
  let shared: SharedArrayBuffer | undefined;
  const post = (message: FromWorker): void => port.postMessage(message);

  port.onMessage((data) => {
    const request = data as ToWorker;
    if (request.type === "init") {
      ({ module, shared } = request);
      return;
    }
    try {
      if (module === undefined || shared === undefined) {
        throw new Error("received a lint before init");
      }
      const result = run(module, {
        args: request.args,
        stdin: request.stdin,
        env: request.env,
        preopens: request.mounted ? [createReadOnlyPreopen(new Bridge(shared, post))] : [],
      });
      post({
        type: "done",
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        exitCode: result.exitCode,
      });
    } catch (error) {
      const { name = "Error", message = String(error) } = (error ?? {}) as Partial<Error>;
      post({ type: "failed", name, message });
    }
  });
}
