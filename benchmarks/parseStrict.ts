import { Benchmark } from './helpers/types';
import { consume } from './helpers/sink';
import { validateData, nextInput } from './parseSafe';
import type { ExpectStatic, SuiteAPI, TestAPI } from 'vitest';

type Fn = (data: unknown) => typeof validateData;

/**
 * Like parseSafe but throw on unknown (extra) keys in objects.
 */
export class ParseStrict extends Benchmark<Fn> {
  run() {
    // Sink + rotating input: see helpers/sink.ts and parseSafe.ts's
    // nextInput(). Both are needed — the sink alone does not fix assert*.
    consume(this.fn(nextInput()));
  }

  test(describe: SuiteAPI, expect: ExpectStatic, test: TestAPI) {
    describe(this.moduleName, () => {
      test('should validate the data', () => {
        expect(this.fn(validateData)).toEqual(validateData);
      });

      test('should throw on invalid attribute type', () => {
        expect(() =>
          this.fn({
            ...validateData,
            number: 'foo',
          }),
        ).toThrow();
      });

      test('should throw on extra attributes', () => {
        expect(() =>
          this.fn({
            ...validateData,
            extraAttribute: true,
          }),
        ).toThrow();
      });

      test('should throw on extra nested attributes', () => {
        expect(() =>
          this.fn({
            ...validateData,
            deeplyNested: {
              ...validateData.deeplyNested,
              extraDeepAttribute: true,
            },
          }),
        ).toThrow();
      });

      test('should throw on missing attributes', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = {
          ...validateData,
        };

        delete data.number;

        expect(() => this.fn(data)).toThrow();
      });
    });
  }
}
