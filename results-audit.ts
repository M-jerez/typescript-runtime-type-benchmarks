/**
 * Audit published benchmark results for measurements that cannot be real.
 *
 * Reads `docs/results/*.json` and applies the structural checks in
 * `benchmarks/helpers/audit.ts`. No timing, no re-running: every check is
 * arithmetic over numbers that are already committed, so the result does not
 * depend on the machine this runs on.
 *
 * Usage:
 *   npm run results-audit             # audit every results file
 *   npm run results-audit bun-1.2     # audit one
 *   npm run results-audit -- --strict # exit non-zero when anything is flagged
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  auditResults,
  type Finding,
  type ResultRow,
} from './benchmarks/helpers/audit';

function resultsDir(): string {
  // Resolved relative to this file so it works from any cwd. Run under ts-node
  // in CommonJS mode, like the repo's other root-level scripts.
  return join(__dirname, 'docs', 'results');
}

function loadRows(file: string): ResultRow[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));

  return parsed.results ?? [];
}

function describe(findings: Finding[]) {
  const byCheck = new Map<string, Finding[]>();

  for (const finding of findings) {
    const bucket = byCheck.get(finding.check) ?? [];
    bucket.push(finding);
    byCheck.set(finding.check, bucket);
  }

  for (const [check, group] of byCheck) {
    console.log(`\n  ${check} — ${group.length} finding(s)`);

    for (const finding of group) {
      console.log(
        `    ${finding.benchmark.padEnd(13)} ${finding.name.slice(0, 34).padEnd(34)} ${finding.detail}`,
      );
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const wanted = args.filter(a => !a.startsWith('--'));

  const dir = resultsDir();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .filter(f =>
      wanted.length ? wanted.includes(basename(f, '.json')) : true,
    );

  let total = 0;

  for (const file of files) {
    const rows = loadRows(join(dir, file));
    const findings = auditResults(rows);
    total += findings.length;

    const label = `${basename(file, '.json')} (${rows.length} measurements)`;

    if (findings.length === 0) {
      console.log(`\n${label}: clean`);
      continue;
    }

    console.log(`\n${label}: ${findings.length} finding(s)`);
    describe(findings);
  }

  console.log(`\n${total} finding(s) across ${files.length} file(s).`);

  if (total > 0) {
    console.log(
      'A finding means the number is not a measurement — most often a benchmark loop the JIT deleted.',
    );
  }

  if (strict && total > 0) {
    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }
}

main();
