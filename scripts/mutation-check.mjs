// Per-file mutation gate (issue #66): Stryker's `thresholds.break` enforces
// the total score only, so `npm run test:mutation` also runs this check over
// the JSON report to enforce ≥ `--min` (default 80) on every mutated file.
//
// CLI: `node scripts/mutation-check.mjs --report <mutation.json> [--min 80]`
// exits 1 listing files below the bar; files with no scored mutants pass
// with a note (Stryker's own `allowEmpty` governs empty runs).

const DETECTED = new Set(['Killed', 'Timeout']);
const MISSED = new Set(['Survived', 'NoCoverage']);

export function fileScores(report) {
  const scores = [];
  for (const [file, result] of Object.entries(report.files ?? {})) {
    let detected = 0;
    let missed = 0;
    for (const mutant of result.mutants ?? []) {
      if (DETECTED.has(mutant.status)) detected++;
      else if (MISSED.has(mutant.status)) missed++;
    }
    const total = detected + missed;
    scores.push({
      file,
      detected,
      total,
      score: total === 0 ? null : Math.round((detected / total) * 10000) / 100,
    });
  }
  return scores.sort((a, b) => (a.file < b.file ? -1 : 1));
}

export function belowThreshold(scores, min) {
  return scores.filter((s) => s.score !== null && s.score < min);
}

function main(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const { readFileSync } = process.getBuiltinModule('node:fs');
  const reportPath = flag('--report', 'reports/mutation/mutation.json');
  const min = Number(flag('--min', '80'));
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(`mutation-check: cannot read ${reportPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const scores = fileScores(report);
  for (const s of scores) {
    console.log(
      `${s.score === null ? 'no mutants' : `${s.score}% (${s.detected}/${s.total})`}\t${s.file}`,
    );
  }
  const failing = belowThreshold(scores, min);
  if (failing.length > 0) {
    for (const s of failing) {
      console.error(`mutation-check: ${s.file} at ${s.score}% < ${min}%`);
    }
    process.exitCode = 1;
  }
}

const invokedAsMain =
  process.argv[1] != null &&
  new URL(import.meta.url).pathname === process.argv[1];
if (invokedAsMain) main(process.argv.slice(2));
