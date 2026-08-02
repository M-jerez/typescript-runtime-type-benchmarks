// Anti-dead-code-elimination sink (a "blackhole").
//
// Every benchmark body calls a library's validate/parse function and then
// DISCARDS the result. A JIT is free to notice that nothing observes the
// returned value and delete the computation that produced it, so the harness
// ends up timing an empty loop instead of the library.
//
// SCOPE — this fixes the `parse*` benchmarks only.
//
// It works when the discarded value CARRIES the work: `parseSafe` /
// `parseStrict` return a freshly built object, so making that object escape
// forces the allocation (and the validation feeding it) to actually happen.
// Measured with benny, node v22: typia's parseSafe reports 65.7M ops/s
// discarded vs 37.2M sunk — a 1.76x overstatement. ts-runtypes' reports 26.7M
// vs 21.1M on node and 36.8M vs 26.2M on bun.
//
// It does NOT fix `assertLoose` / `assertStrict`. Those case functions end in
// `return true` — a literal. Sinking a constant carries no evidence that the
// validation ran, so the JIT is just as free to fold it away. Measured on bun,
// ts-runtime-checks assertLoose: 217.0M ops/s discarded vs 223.1M sunk, both
// with a ~50% error margin — the sink changed nothing. That artifact comes
// from validating one frozen constant input, and is addressed separately by
// the rotating input pool in `../parseSafe.ts` (`nextInput`).
//
// COST: the store is not free (~3ns/iteration on V8, ~0.5ns on JSC). Every
// case pays it equally, so comparisons between libraries stay fair, but
// absolute ops/s are not comparable across the change. Use `BENCHMARK_SINK=0`
// to reproduce the old, unsunk numbers — see `dce-evidence.ts`.

import { envEnabled } from './env';

/**
 * When `BENCHMARK_SINK=0`, `consume` becomes a no-op so the benchmark bodies
 * behave exactly as they did before the sink existed (an empty function is
 * inlined away, leaving the result discarded). This exists so the two modes can
 * be measured against each other.
 */
const sinkEnabled = envEnabled('BENCHMARK_SINK');

let hole: unknown;

/**
 * Consume a benchmark result so it cannot be dead-code-eliminated.
 *
 * The never-taken guard reads `hole`, so the optimizer cannot prove the store
 * is dead: it cannot know the stored value is never the `sink` function itself.
 * That keeps the sink self-contained — no cooperation from the runner needed.
 */
export function sink(value: unknown): void {
  hole = value;

  if (hole === sink) {
    throw new Error('unreachable');
  }
}

/** No-op twin used when the sink is disabled via `BENCHMARK_SINK=0`. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function passthrough(_value: unknown): void {}

/**
 * The function benchmark bodies actually call. Bound once at module load, not
 * per iteration, so the hot loop contains no branch on the flag.
 */
export const consume: (value: unknown) => void = sinkEnabled
  ? sink
  : passthrough;

/** Whether the sink is active. Reported by `dce-evidence.ts`. */
export const isSinkEnabled = sinkEnabled;

/**
 * Test-only accessor for the last value passed to `sink`. Lets the unit tests
 * assert that each benchmark body really routes its result through the sink,
 * without resorting to timing (which would be flaky in CI).
 */
export function readSinkHole(): unknown {
  return hole;
}
