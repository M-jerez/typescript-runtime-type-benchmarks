import { test, describe, expect } from 'vitest';
import {
  auditMargins,
  auditPlausibility,
  auditImpossibleOrdering,
  auditResults,
  implausibilityCeiling,
  MARGIN_LIMIT,
  SAMPLE_FIELD_COUNT,
  type ResultRow,
} from '../benchmarks/helpers/audit';

// The audits are the safety net for a benchmark whose loops can be deleted by
// the JIT. They must fire on the real published shapes and stay quiet on honest
// ones, so both directions are pinned here.

const row = (over: Partial<ResultRow> = {}): ResultRow => ({
  benchmark: 'assertLoose',
  name: 'some-library',
  ops: 40_000_000,
  margin: 3,
  ...over,
});

describe('margin audit', () => {
  test('flags a margin at or above the limit', () => {
    // The real shape: bun assertLoose reported 328M ops/s at a 74.3% margin.
    const findings = auditMargins([row({ ops: 328_570_983, margin: 74.29 })]);

    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('margin');
    expect(findings[0].detail).toContain('74.3%');
  });

  test('stays quiet for a tight margin', () => {
    expect(auditMargins([row({ margin: MARGIN_LIMIT - 0.1 })])).toHaveLength(0);
  });
});

describe('physical plausibility audit', () => {
  test('flags throughput that implies less than a cycle per field', () => {
    // 328M ops/s over 10 fields is ~0.3ns per op — impossible.
    const findings = auditPlausibility([row({ ops: 328_570_983 })]);

    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('implausible');
  });

  test('leaves a fast but achievable result alone', () => {
    // Just under the ceiling must not trip: the check is for 100x artifacts.
    const findings = auditPlausibility([
      row({ ops: implausibilityCeiling(SAMPLE_FIELD_COUNT) - 1 }),
    ]);

    expect(findings).toHaveLength(0);
  });

  test('the ceiling scales with the number of fields', () => {
    // More fields to check per operation means a lower plausible ops ceiling.
    expect(implausibilityCeiling(20)).toBeLessThan(implausibilityCeiling(10));
  });
});

describe('impossible ordering audit', () => {
  test('flags parseSafe measurably beating its own assertLoose as impossible', () => {
    // The real shape: node-24 reported zod4 at 7.4M parseSafe vs 3.6M assertLoose.
    const findings = auditImpossibleOrdering([
      { benchmark: 'assertLoose', name: 'lib', ops: 3_600_000, margin: 3 },
      { benchmark: 'parseSafe', name: 'lib', ops: 7_400_000, margin: 3 },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('impossible-ordering');
    expect(findings[0].detail).toContain('2.06x');
  });

  test('reports an exact tie at the weaker severity, not as proof', () => {
    // A parseSafe that returns its input unchanged legitimately ties. The real
    // shape: node-24 reported ts-runtypes at 86.9M for both.
    const findings = auditImpossibleOrdering([
      { benchmark: 'assertLoose', name: 'lib', ops: 86_900_000, margin: 3 },
      { benchmark: 'parseSafe', name: 'lib', ops: 86_900_000, margin: 3 },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('suspicious-tie');
  });

  test('accepts parseSafe being properly slower', () => {
    const findings = auditImpossibleOrdering([
      { benchmark: 'assertLoose', name: 'lib', ops: 80_000_000, margin: 3 },
      { benchmark: 'parseSafe', name: 'lib', ops: 40_000_000, margin: 3 },
    ]);

    expect(findings).toHaveLength(0);
  });

  test('ignores a library that has no assertLoose case to compare against', () => {
    const findings = auditImpossibleOrdering([
      {
        benchmark: 'parseSafe',
        name: 'only-parses',
        ops: 99_000_000,
        margin: 3,
      },
    ]);

    expect(findings).toHaveLength(0);
  });
});

describe('auditResults', () => {
  test('returns nothing for a plausible, tightly measured, correctly ordered set', () => {
    expect(
      auditResults([
        { benchmark: 'assertLoose', name: 'lib', ops: 80_000_000, margin: 2.5 },
        { benchmark: 'parseSafe', name: 'lib', ops: 40_000_000, margin: 2.1 },
      ]),
    ).toHaveLength(0);
  });

  test('reports every independent check that fires for one bad row', () => {
    // A deleted loop typically trips several checks at once, which is the point:
    // no single heuristic has to be trusted on its own.
    const findings = auditResults([
      { benchmark: 'assertLoose', name: 'lib', ops: 300_000_000, margin: 70 },
      { benchmark: 'parseSafe', name: 'lib', ops: 330_000_000, margin: 70 },
    ]);

    const checks = new Set(findings.map(f => f.check));

    expect(checks).toContain('implausible');
    expect(checks).toContain('margin');
    expect(checks).toContain('impossible-ordering');
  });
});
