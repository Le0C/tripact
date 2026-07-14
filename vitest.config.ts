import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // globalSetup builds the CLI once and exports its path; setupFiles re-asserts that path
    // inside each worker. Together they let every spawn run the prebuilt dist/cli.js via plain
    // node instead of recompiling src through tsx per call — see test/helpers/*.
    globalSetup: ["./test/helpers/global-setup.ts"],
    setupFiles: ["./test/helpers/setup-env.ts"],
    testTimeout: 30_000,
    // Bounded parallelism. Files run across a small fork pool: each fork mostly blocks in
    // synchronous spawnSync waiting on child tripact/git processes, so a couple of forks overlap
    // that wall-clock without saturating cores. The cap comes from measured reporter-IPC timeout
    // analysis (maxForks:2 fully green, higher stalls) for a suite that spawns child processes this
    // way. Do not raise without re-measuring.
    pool: "forks",
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    fileParallelism: true,
  },
});
