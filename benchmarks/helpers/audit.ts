// Structural audits over benchmark results.
//
// These exist because timing evidence is easy to get wrong. Every check here is
// arithmetic over already-published numbers: none of them re-measures anything,
// so none of them can be skewed by a noisy machine, JIT warm-up, or the order
// variants happen to run in. A result that fails one of these is not "slow" or
// "fast" — it is not a measurement at all.
//
// Three independent checks, each able to catch a deleted benchmark loop on its
// own:
//
//   1. MARGIN — how far the number moved between repeat samples. Double digits
//      means the loop was doing different amounts of work each time, which is
//      what partial dead-code elimination looks like.
//   2. PHYSICAL PLAUSIBILITY — a validator must at minimum load and type-check
//      each field. Below roughly one CPU cycle per field, it did not happen.
//   3. IMPOSSIBLE ORDERING — parseSafe does everything assertLoose does AND
//      builds a result, so it cannot be faster. A pure logic violation.

export interface ResultRow {
  benchmark: string;
  name: string;
  ops: number;
  margin: number;
  runtime?: string;
  runtimeVersion?: string;
}

export interface Finding {
  check: 'margin' | 'implausible' | 'impossible-ordering' | 'suspicious-tie';
  benchmark: string;
  name: string;
  detail: string;
}

/**
 * Above this ratio, parseSafe is measurably FASTER than assertLoose, which no
 * implementation can be — it does the same validation plus builds a result.
 */
export const IMPOSSIBLE_RATIO = 1.05;

/**
 * Between this and IMPOSSIBLE_RATIO the two are effectively tied. That is only
 * legitimate for a parseSafe that returns its input unchanged (no clone, no
 * strip), so a tie is reported separately as a weaker signal rather than as
 * proof — several libraries here genuinely do that.
 */
export const TIE_RATIO = 0.98;

/** Fields the shared sample object requires a validator to check, including the nested ones. */
export const SAMPLE_FIELD_COUNT = 10;

/**
 * Nothing on current hardware retires a field check in under ~1 cycle, and
 * ~3GHz is a generous clock. So the floor per operation is roughly
 * `fields / 3e9` seconds; anything faster did not run. Deliberately lenient —
 * this is meant to catch 100x artifacts, not to adjudicate close calls.
 */
export function implausibilityCeiling(
  fieldCount = SAMPLE_FIELD_COUNT,
  clockHz = 3e9,
): number {
  return clockHz / fieldCount;
}

/** A margin above this means the samples disagreed too much to mean anything. */
export const MARGIN_LIMIT = 20;

export function auditMargins(
  rows: ResultRow[],
  limit = MARGIN_LIMIT,
): Finding[] {
  return rows
    .filter(row => row.margin >= limit)
    .map(row => ({
      check: 'margin' as const,
      benchmark: row.benchmark,
      name: row.name,
      detail: `error margin ${row.margin.toFixed(1)}% (>= ${limit}%) — samples disagreed too much to be a measurement`,
    }));
}

export function auditPlausibility(
  rows: ResultRow[],
  fieldCount = SAMPLE_FIELD_COUNT,
): Finding[] {
  const ceiling = implausibilityCeiling(fieldCount);

  return rows
    .filter(row => row.ops > ceiling)
    .map(row => ({
      check: 'implausible' as const,
      benchmark: row.benchmark,
      name: row.name,
      detail:
        `${(row.ops / 1e6).toFixed(1)}M ops/s implies ${((1e9 / row.ops) * 1000).toFixed(2)}ps per field ` +
        `across ${fieldCount} fields — below one cycle per field, so the work did not happen`,
    }));
}

/**
 * `parseSafe` = validate + build a result. `assertLoose` = validate. So
 * parseSafe cannot be faster, and the ratio between them is a free correctness
 * signal that needs no timing baseline.
 *
 * Two severities, because a tie has a legitimate explanation and a win does
 * not: a parseSafe that returns its input unchanged really does the same work
 * as assertLoose. Only `impossible-ordering` is proof on its own.
 */
export function auditImpossibleOrdering(rows: ResultRow[]): Finding[] {
  const loose = new Map(
    rows.filter(r => r.benchmark === 'assertLoose').map(r => [r.name, r.ops]),
  );

  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.benchmark !== 'parseSafe') continue;

    const looseOps = loose.get(row.name);
    if (looseOps === undefined) continue;

    const ratio = row.ops / looseOps;
    const shape = `parseSafe ${(row.ops / 1e6).toFixed(1)}M vs assertLoose ${(looseOps / 1e6).toFixed(1)}M (${ratio.toFixed(2)}x)`;

    if (ratio >= IMPOSSIBLE_RATIO) {
      findings.push({
        check: 'impossible-ordering',
        benchmark: row.benchmark,
        name: row.name,
        detail: `${shape} — parseSafe cannot be faster, it does the same validation plus builds a result`,
      });
    } else if (ratio >= TIE_RATIO) {
      findings.push({
        check: 'suspicious-tie',
        benchmark: row.benchmark,
        name: row.name,
        detail: `${shape} — only legitimate if this parseSafe returns its input unchanged`,
      });
    }
  }

  return findings;
}

/** Run every structural check. */
export function auditResults(rows: ResultRow[]): Finding[] {
  return [
    ...auditPlausibility(rows),
    ...auditMargins(rows),
    ...auditImpossibleOrdering(rows),
  ];
}
