/*! SPDX-License-Identifier: GPL-3.0-or-later */

export * from "./client-entry.js";

/** URL of the bundled shellcheck.wasm, resolved relative to this module. */
export const wasmUrl: URL = new URL("./shellcheck.wasm", import.meta.url);
