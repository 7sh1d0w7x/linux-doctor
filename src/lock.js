// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A tiny promise queue. One use: checks that shell out to the package manager
 * (apt, dnf, zypper) must not run at the same time.
 *
 * On openSUSE this was a real bug: `updates` held the zypper lock while
 * `orphans` ran, the second call exited 7 and printed nothing, and the report
 * said "no orphans" — silence that looked like health for one run and fixed
 * itself on the next only because `updates` had cached its answer. Retrying
 * would hide the race; serializing removes it.
 *
 * `run(fn)` resolves with fn's value and keeps the queue moving even when fn
 * rejects, so one failing check cannot deadlock the rest.
 */
export function createLock() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
