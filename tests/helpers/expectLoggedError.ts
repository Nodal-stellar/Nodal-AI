/**
 * tests/helpers/expectLoggedError.ts
 *
 * Global afterEach that fails a test if the logger (backend/utils/logger.ts)
 * emitted an error/fatal entry during that test which wasn't explicitly
 * allowed with `expectLoggedError()` (Issue #1006).
 *
 * Without this, errors logged by a broken code path (e.g. a persistence-mock
 * throwing) don't fail anything on their own — they just scroll by in the
 * test output — so a regression that only manifests as a swallowed error can
 * hide behind an otherwise-green run.
 *
 * ## Usage
 *
 * Call `expectLoggedError(pattern)` *before* exercising the code path that is
 * expected to log a matching error/fatal message, e.g.:
 *
 *   it('logs and swallows the persistence error', async () => {
 *     expectLoggedError(/failed to persist/i);
 *     await doSomethingThatLogsAndSwallows();
 *   });
 *
 * Any error/fatal logged during the test that matches no expected pattern
 * fails the test in its afterEach, naming the unmatched message(s). Expected
 * patterns are scoped to a single test and reset automatically afterward.
 *
 * Registered as a global setup file (vitest.config.ts), so this runs for
 * every test file without an explicit import — only `expectLoggedError`
 * itself needs importing, and only in tests that expect an error log.
 */

import { afterEach } from 'vitest';
import * as loggerModule from '../../backend/utils/logger';

let expectedPatterns: RegExp[] = [];

/**
 * Allow an error/fatal log matching `pattern` during the current test,
 * so the global afterEach below doesn't fail it over an expected log.
 */
export function expectLoggedError(pattern: RegExp): void {
  expectedPatterns.push(pattern);
}

afterEach(() => {
  // Some test files replace backend/utils/logger entirely with
  // `vi.mock(...)` (e.g. to stub createLogger() with no-op spies). Their mock
  // factory won't export `testErrorLogCapture`, so there is nothing to check
  // for that file — this hook is then a no-op rather than a crash.
  const capture = loggerModule.testErrorLogCapture;
  if (!capture) return;

  const unexpected = capture.filter(
    (entry) => !expectedPatterns.some((pattern) => pattern.test(entry.msg))
  );

  capture.length = 0;
  expectedPatterns = [];

  if (unexpected.length > 0) {
    throw new Error(
      'Unexpected error/fatal log(s) during test — if this is expected, call ' +
        'expectLoggedError(/pattern/) before the code path that logs it:\n' +
        unexpected.map((entry) => `  [level ${entry.level}] ${entry.msg}`).join('\n')
    );
  }
});
