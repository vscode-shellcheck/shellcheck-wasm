import { describe, expect, it } from "vitest";
import { isArtifactSupported } from "../src/support.js";

describe("isArtifactSupported", () => {
  // Every engine in `engines` has tail calls and SIMD, so a false here is a broken probe.
  it("is true on Node", () => {
    expect(isArtifactSupported()).toBe(true);
  });
});
