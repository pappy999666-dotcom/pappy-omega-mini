import { configDefaults, defineConfig } from "vitest/config";

// Stale deploy/rollback copies of this project ship their own compiled test
// suites; without these excludes `vitest run` re-executes dozens of outdated
// duplicates and hides real failures in noise.
export default defineConfig({
  test: {
    setupFiles: ["./tests/test-env.setup.ts"],
    exclude: [
      ...configDefaults.exclude,
      "**/.dist.previous*/**",
      "**/.dist-backup*/**",
      "**/.dist.pre*/**",
      "**/.dist*/**",
      "**/.deploy*/**",
      "**/.rollback*/**",
      "**/dist.prev/**",
      "**/dist/**",
    ],
  },
});
