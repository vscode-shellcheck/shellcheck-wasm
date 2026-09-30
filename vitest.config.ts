import { defineConfig } from "vitest/config";
import { buildConstants } from "./scripts/build-constants.ts";

export default defineConfig({
  define: buildConstants(),
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
