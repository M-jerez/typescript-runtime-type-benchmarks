/**
 * Evidence harness for the dead-code-elimination artifact.
 *
 * Runs every registered benchmark twice — once in LEGACY mode (both
 * mitigations off: result discarded, one frozen constant input) and once in
 * FIXED mode — in SEPARATE processes, because both are bound once at module
 * load. Then reports, per case:
 *
 *   - the inflation factor (legacy ops/s ÷ fixed ops/s). A case whose work was
 *     being deleted reports a large factor; a case that was always measured
 *     honestly reports ~1, minus the mitigations' own small overhead.
 *   - the error margin in each mode. A double-digit margin means the number
 *     moved wildly between samples and is not a measurement at all.
 *   - the IMPOSSIBLE-RESULT check: parseSafe does everything assertLoose does
 *     AND builds a result, so parseSafe must be slower. Any case where it is
 *     not was measuring a deleted computation. This check is immune to
 *     arguments about the sink's overhead, since both benchmarks pay it
 *     equally.
 *
 * Usage:
 *   npm run dce-evidence                 # all cases
 *   npm run dce-evidence ts-runtypes ajv # only the named cases
 *
 * This writes nothing to docs/results — it is a diagnostic, not a benchmark run.
 */
import * as childProcess from 'node:child_process';
import { add, complete, suite } from 'benny';
import { getRegisteredBenchmarks } from './benchmarks';
import { importCase, cases as allCases, type CaseName } from './cases';

interface Measurement {
  benchmark: string;
  name: string;
  opsPerSecond: number;
  margin: number;
}

/**
 * Drive the REAL harness (benny, i.e. Benchmark.js), not a hand-rolled loop.
 *
 * This matters: Benchmark.js decompiles the benchmark function and inlines its
 * source into a generated timing loop. That inlining is what lets the JIT see
 * through to the validator and delete it. A hand-written
 * `for (…) benchmarkCase.run()` loop keeps a real method call in the way, does
 * NOT reproduce the artifact, and would understate it dramatically. Measuring
 * the same harness the published results come from is the whole point.
 *
 * Mirrors `benchmarks/helpers/main.ts`'s `runBenchmarks`, minus the file
 * writing and the cycle logging.
 */
async function runChild(caseNames: CaseName[]) {
  for (const caseName of caseNames) {
    try {
      await importCase(caseName);
    } catch {
      // Same tolerance the main runner has: not every case builds on every
      // runtime, and a missing one should not abort the comparison.
    }
  }

  const measurements: Measurement[] = [];

  for (const [benchmark, benchmarkCases] of getRegisteredBenchmarks()) {
    if (benchmarkCases.length === 0) continue;

    const summary = await suite(
      benchmark,
      ...benchmarkCases.map(c => add(c.moduleName, () => c.run())),
      complete(),
    );

    for (const result of summary.results) {
      measurements.push({
        benchmark,
        name: result.name,
        opsPerSecond: result.ops,
        margin: result.margin,
      });
    }
  }

  process.stdout.write('__RESULTS__' + JSON.stringify(measurements));
}

function spawnMode(fixed: boolean, caseNames: string[]): Measurement[] {
  const argv = [...process.argv.slice(0, 2), 'child', ...caseNames];
  const output = childProcess.execFileSync(argv[0], argv.slice(1), {
    env: {
      ...process.env,
      // Both mitigations move together: the sink covers parse*, the rotating
      // input covers assert*. Neither fixes the other's benchmarks.
      BENCHMARK_SINK: fixed ? '1' : '0',
      BENCHMARK_ROTATE_INPUT: fixed ? '1' : '0',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const marker = output.lastIndexOf('__RESULTS__');

  if (marker < 0) {
    throw new Error('child produced no results');
  }

  return JSON.parse(output.slice(marker + '__RESULTS__'.length));
}

function key(m: { benchmark: string; name: string }) {
  return `${m.benchmark} ${m.name}`;
}

function report(unsunk: Measurement[], sunk: Measurement[]) {
  const sunkByKey = new Map(sunk.map(m => [key(m), m]));

  const rows = unsunk
    .map(before => {
      const after = sunkByKey.get(key(before));
      if (!after) return undefined;
      return {
        benchmark: before.benchmark,
        name: before.name,
        before: before.opsPerSecond,
        after: after.opsPerSecond,
        beforeMargin: before.margin,
        afterMargin: after.margin,
        inflation: before.opsPerSecond / after.opsPerSecond,
      };
    })
    .filter(row => row !== undefined)
    .sort((a, b) => b.inflation - a.inflation);

  const millions = (n: number) => (n / 1e6).toFixed(1).padStart(8) + 'M';

  console.log(
    '\nPer-case inflation — how much the legacy benchmark overstated throughput.',
  );
  console.log(
    'A factor near 1 means the case was always measured honestly (the small residue is the mitigations themselves).\n',
  );
  console.log(
    `${'benchmark'.padEnd(13)} ${'case'.padEnd(30)} ${'legacy'.padStart(9)} ${'margin'.padStart(7)} ${'fixed'.padStart(9)} ${'margin'.padStart(7)}  factor`,
  );

  for (const row of rows.slice(0, 25)) {
    const flag = row.inflation >= 1.5 ? '  <== inflated' : '';
    console.log(
      `${row.benchmark.padEnd(13)} ${row.name.slice(0, 30).padEnd(30)} ${millions(row.before)} ${row.beforeMargin.toFixed(1).padStart(6)}% ${millions(row.after)} ${row.afterMargin.toFixed(1).padStart(6)}%  ${row.inflation.toFixed(2)}x${flag}`,
    );
  }

  const inflated = rows.filter(row => row.inflation >= 1.5);
  console.log(
    `\n${inflated.length} of ${rows.length} measurements overstated by >=1.5x in legacy mode.`,
  );

  // A margin is how much the number moved between repeat samples. Anything in
  // double digits is not a measurement, and is the clearest single tell that a
  // loop was deleted rather than run.
  const wild = (
    rows: { beforeMargin: number; afterMargin: number }[],
    pick: 'before' | 'after',
  ) =>
    rows.filter(r => (pick === 'before' ? r.beforeMargin : r.afterMargin) >= 20)
      .length;

  console.log(
    `Implausible error margins (>=20%): ${wild(rows, 'before')} legacy, ${wild(rows, 'after')} fixed.`,
  );

  impossibleResultCheck(unsunk, sunk);
}

/**
 * parseSafe validates AND builds a result; assertLoose only validates. So
 * parseSafe can never legitimately be faster. Counting the violations in each
 * mode shows whether the mitigations actually restored physical plausibility.
 */
function impossibleResultCheck(unsunk: Measurement[], sunk: Measurement[]) {
  const violations = (measurements: Measurement[]) => {
    const loose = new Map(
      measurements
        .filter(m => m.benchmark === 'assertLoose')
        .map(m => [m.name, m.opsPerSecond]),
    );
    const offenders: string[] = [];
    let compared = 0;

    for (const m of measurements) {
      if (m.benchmark !== 'parseSafe') continue;
      const looseOps = loose.get(m.name);
      if (looseOps === undefined) continue;
      compared++;
      if (m.opsPerSecond >= looseOps * 0.98) offenders.push(m.name);
    }

    return { offenders, compared };
  };

  const before = violations(unsunk);
  const after = violations(sunk);

  console.log(
    '\nImpossible-result check — parseSafe does strictly more work than assertLoose,',
  );
  console.log(
    'so parseSafe >= 98% of assertLoose cannot be a real measurement.\n',
  );
  console.log(
    `  legacy : ${before.offenders.length} of ${before.compared} cases impossible`,
  );
  console.log(
    `  fixed  : ${after.offenders.length} of ${after.compared} cases impossible`,
  );

  if (after.offenders.length) {
    console.log(
      `\n  still impossible when fixed: ${after.offenders.join(', ')}`,
    );
    console.log(
      '  (expected for cases whose parseSafe returns the input as-is, doing no extra work)',
    );
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'child') {
    await runChild((args.length ? args : [...allCases]) as CaseName[]);
    return;
  }

  const caseNames = command ? [command, ...args] : [...allCases];

  console.log(
    `Measuring ${caseNames.length} case(s) in both modes, one process each...`,
  );

  const before = spawnMode(false, caseNames);
  const after = spawnMode(true, caseNames);

  report(before, after);
}

main().catch(e => {
  throw e;
});
