import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["docs/design-studies/experiments/ds02-direct-tool-order.test.ts"],
  },
});
