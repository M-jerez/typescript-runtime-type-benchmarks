import { test, describe, expect } from 'vitest';
import {
  sink,
  consume,
  isSinkEnabled,
  readSinkHole,
} from '../benchmarks/helpers/sink';
import {
  ParseSafe,
  validateData,
  nextInput,
  inputPoolForTests,
} from '../benchmarks/parseSafe';
import { ParseStrict } from '../benchmarks/parseStrict';
import { AssertLoose } from '../benchmarks/assertLoose';
import { AssertStrict } from '../benchmarks/assertStrict';

// These tests are deliberately NOT timing-based. Asserting "the sunk version is
// slower" would be flaky on shared CI runners. Instead they pin the structural
// property the sink depends on: every benchmark body must hand its result to
// the sink, so the JIT cannot prove the result is unobservable. The timing
// evidence lives in `dce-evidence.ts`, which is run on demand.

describe('sink', () => {
  test('is enabled by default (no BENCHMARK_SINK=0 in the test env)', () => {
    expect(isSinkEnabled).toBe(true);
    expect(consume).toBe(sink);
  });

  test('makes the value escape, so it is observable afterwards', () => {
    const value = { fresh: 'object' };

    sink(value);

    expect(readSinkHole()).toBe(value);
  });

  test('accepts every result shape the benchmarks produce', () => {
    for (const value of [true, false, 0, '', null, undefined, { a: 1 }]) {
      expect(() => sink(value)).not.toThrow();
      expect(readSinkHole()).toBe(value);
    }
  });

  test('its never-taken guard only fires for the sentinel', () => {
    // The guard exists so the store cannot be proven dead. It is unreachable
    // for any real benchmark result, which is exactly what makes it safe.
    expect(() => sink(sink)).toThrow('unreachable');
  });
});

describe('rotating input pool', () => {
  // The sink cannot fix assert*, whose case fns return a literal. Rotating the
  // input is what stops the JIT folding those away, so the pool's properties
  // are worth pinning: same shape, all valid, actually rotating.

  test('every pooled input is structurally identical to validateData', () => {
    // Same key set in the same order means the same hidden class, so rotating
    // costs no megamorphic-dispatch penalty and stays a fair comparison.
    const expectedKeys = Object.keys(validateData);

    for (const input of inputPoolForTests) {
      expect(Object.keys(input)).toEqual(expectedKeys);
      expect(Object.keys(input.deeplyNested)).toEqual(
        Object.keys(validateData.deeplyNested),
      );
    }
  });

  test('every pooled input still satisfies the schema types', () => {
    for (const input of inputPoolForTests) {
      expect(typeof input.number).toBe('number');
      expect(typeof input.negNumber).toBe('number');
      expect(typeof input.maxNumber).toBe('number');
      expect(typeof input.string).toBe('string');
      expect(typeof input.longString).toBe('string');
      expect(typeof input.boolean).toBe('boolean');
      expect(typeof input.deeplyNested.foo).toBe('string');
      expect(typeof input.deeplyNested.num).toBe('number');
      expect(typeof input.deeplyNested.bool).toBe('boolean');
    }
  });

  test('nextInput() actually rotates rather than returning one constant', () => {
    const seen = new Set<unknown>();

    for (let i = 0; i < inputPoolForTests.length; i++) {
      seen.add(nextInput());
    }

    // If this ever collapses to 1, the constant-folding artifact is back.
    expect(seen.size).toBe(inputPoolForTests.length);
  });

  test('nextInput() wraps around the pool', () => {
    const first = nextInput();

    for (let i = 0; i < inputPoolForTests.length - 1; i++) {
      nextInput();
    }

    expect(nextInput()).toBe(first);
  });
});

describe('benchmark bodies route their result through the sink', () => {
  // If any of these regress, that benchmark silently goes back to measuring a
  // loop the JIT is free to delete.
  const cases = [
    ['ParseSafe', ParseSafe, { cloned: 'value' }],
    ['ParseStrict', ParseStrict, { cloned: 'value' }],
    ['AssertLoose', AssertLoose, true],
    ['AssertStrict', AssertStrict, true],
  ] as const;

  cases.forEach(([name, Ctor, result]) => {
    test(`${name}.run() sinks the value returned by the case fn`, () => {
      let callCount = 0;
      const fn = () => {
        callCount++;
        return result;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const benchmark = new (Ctor as any)(`${name}-test`, fn);

      // Clear the hole first so we cannot pass on a stale value from an
      // earlier test.
      sink(undefined);
      expect(readSinkHole()).toBe(undefined);

      benchmark.run();

      expect(callCount).toBe(1);
      expect(readSinkHole()).toBe(result);
    });
  });
});
