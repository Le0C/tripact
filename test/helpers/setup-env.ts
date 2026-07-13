// Runs inside every test worker (vitest `setupFiles`) before any test file. globalSetup runs in the
// main process; forks normally inherit its `process.env`, but we re-assert the built-CLI path from
// the provided context as a belt-and-suspenders guarantee so that a plain
// `process.env.TRIPACT_TEST_CLI` read in test/helpers/cli.ts is always populated.
import { inject } from "vitest";

const provided = inject("tripactTestCli");
if (provided && !process.env.TRIPACT_TEST_CLI) {
  process.env.TRIPACT_TEST_CLI = provided;
}
