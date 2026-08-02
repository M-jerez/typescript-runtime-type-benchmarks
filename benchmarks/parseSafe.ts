import { Benchmark } from './helpers/types';
import { consume } from './helpers/sink';
import { envEnabled } from './helpers/env';
import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest';

export const validateData = Object.freeze({
  number: 1,
  negNumber: -1,
  maxNumber: Number.MAX_VALUE,
  string: 'string',
  longString:
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Vivendum intellegat et qui, ei denique consequuntur vix. Semper aeterno percipit ut his, sea ex utinam referrentur repudiandae. No epicuri hendrerit consetetur sit, sit dicta adipiscing ex, in facete detracto deterruisset duo. Quot populo ad qui. Sit fugit nostrum et. Ad per diam dicant interesset, lorem iusto sensibus ut sed. No dicam aperiam vis. Pri posse graeco definitiones cu, id eam populo quaestio adipiscing, usu quod malorum te. Ex nam agam veri, dicunt efficiantur ad qui, ad legere adversarium sit. Commune platonem mel id, brute adipiscing duo an. Vivendum intellegat et qui, ei denique consequuntur vix. Offendit eleifend moderatius ex vix, quem odio mazim et qui, purto expetendis cotidieque quo cu, veri persius vituperata ei nec. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  boolean: true,
  deeplyNested: {
    foo: 'bar',
    num: 1,
    bool: false,
  },
});

// Rotating input pool — the second half of the dead-code-elimination fix.
//
// The sink (helpers/sink.ts) rescues the `parse*` benchmarks, whose result
// carries the work. It cannot rescue `assert*`, whose case functions end in
// `return true`: sinking a literal proves nothing ran. What lets the JIT fold
// those away is validating ONE frozen constant on every iteration — fully
// inlined, the whole computation becomes a known-true constant.
//
// Rotating over structurally identical but distinct objects removes that
// constant without changing what is measured: every entry has the same shape
// (so no megamorphic-call penalty) and is equally valid, only the values
// differ. Measured on bun, ts-runtime-checks assertLoose: 217.0M ops/s at a
// 49.5% margin against one constant, versus 79.5M at 13.8% rotating — a 2.7x
// overstatement, and a margin that becomes a real measurement.
//
// Set `BENCHMARK_ROTATE_INPUT=0` to restore the single-constant behaviour.
const INPUT_POOL_SIZE = 16;

/**
 * The sample shape, with the numbers widened. `validateData` is a frozen
 * literal, so TypeScript infers `number: 1`; pooled entries vary that field and
 * would not be assignable to it.
 */
export interface BenchmarkInput {
  readonly number: number;
  readonly negNumber: number;
  readonly maxNumber: number;
  readonly string: string;
  readonly longString: string;
  readonly boolean: boolean;
  readonly deeplyNested: {
    readonly foo: string;
    readonly num: number;
    readonly bool: boolean;
  };
}

const inputPool: readonly BenchmarkInput[] = Object.freeze(
  Array.from({ length: INPUT_POOL_SIZE }, (_, i) =>
    Object.freeze({
      ...validateData,
      number: i,
      negNumber: -i,
      deeplyNested: Object.freeze({ ...validateData.deeplyNested, num: i }),
    }),
  ),
);

const rotateInput = envEnabled('BENCHMARK_ROTATE_INPUT');

let inputCursor = 0;

/**
 * The value benchmark bodies validate. Rotates through the pool so the JIT
 * cannot constant-fold the validation, unless disabled by env flag.
 */
export function nextInput(): BenchmarkInput {
  if (!rotateInput) {
    return validateData;
  }

  // Power-of-two mask: cheap, and never a bounds check.
  return inputPool[inputCursor++ & (INPUT_POOL_SIZE - 1)];
}

/** Test-only view of the pool. */
export const inputPoolForTests: readonly BenchmarkInput[] = inputPool;

type Fn = (data: unknown) => typeof validateData;

/**
 * Validate and ignore unknown keys, removing them from the result.
 *
 * When validating untrusted data, unknown keys should always be removed to
 * not result in unwanted parameters or the `__proto__` attribute being
 * maliciously passed to internal functions.
 */
export class ParseSafe extends Benchmark<Fn> {
  run() {
    // See helpers/sink.ts: parseSafe implementations that return a freshly
    // built object are the ones escape analysis deletes outright.
    consume(this.fn(nextInput()));
  }

  test(describe: SuiteAPI, expect: ExpectStatic, test: TestAPI) {
    describe(this.moduleName, () => {
      test('should validate the data', () => {
        expect(this.fn(validateData)).toEqual(validateData);
      });

      test('should validate with unknown attributes but remove them from the validated result', () => {
        const dataWithExtraKeys = {
          ...validateData,
          extraAttribute: 'foo',
        };

        expect(this.fn(dataWithExtraKeys)).toEqual(validateData);
      });

      // some libraries define the strict / non-strict validation as an
      // option to the record/object/type type so we need to test the
      // nested extra attribute explicitely so we know our runtype has
      // been constructed correctly
      test('should validate with unknown attributes but remove them from the validated result (nested)', () => {
        const dataWithExtraNestedKeys = {
          ...validateData,
          deeplyNested: {
            ...validateData.deeplyNested,
            extraNestedAttribute: 'bar',
          },
        };

        expect(this.fn(dataWithExtraNestedKeys)).toEqual(validateData);
      });

      test('should throw on missing attributes', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = {
          ...validateData,
        };

        delete data.number;

        expect(() => this.fn(data)).toThrow();
      });

      test('should throw on data with an invalid attribute', () => {
        expect(() =>
          this.fn({
            ...validateData,
            number: 'foo',
          }),
        ).toThrow();
      });
    });
  }
}
