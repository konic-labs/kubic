// Per-file mutation gate (issue #66): Stryker's `thresholds.break` enforces
// the total score only, so `npm run test:mutation` also runs this check over
// the JSON report to enforce ≥ `--min` (default 80) on every mutated file.
//
// CLI: `node scripts/mutation-check.mjs --report <mutation.json> [--min 80]
// [--baseline <previous.json>]` exits 1 listing files below the bar; files
// with no scored mutants pass with a note (Stryker's own `allowEmpty`
// governs empty runs).
//
// Ratchet (issue #72): with `--baseline`, a file's bar is
// min(--min, its baseline score) — a file below --min may not drop below
// its baseline, one at or above --min must stay >= --min, and files new to
// the baseline must meet --min.

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

// baseline: Map<file, score|null> from a previous report (optional).
export function belowThreshold(scores, min, baseline = new Map()) {
  const failing = [];
  for (const s of scores) {
    if (s.score === null) continue;
    const before = baseline.get(s.file);
    const bar = before == null ? min : Math.min(min, before);
    if (s.score < bar) failing.push({ ...s, bar });
  }
  return failing;
}

function main(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const { readFileSync } = process.getBuiltinModule('node:fs');
  const reportPath = flag('--report', 'reports/mutation/mutation.json');
  const min = Number(flag('--min', '80'));
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.error(`mutation-check: cannot read ${path}: ${err.message}`);
      process.exitCode = 1;
      return null;
    }
  };
  const report = read(reportPath);
  if (report === null) return;
  const baselinePath = flag('--baseline', null);
  const baseline = new Map();
  if (baselinePath !== null) {
    const previous = read(baselinePath);
    if (previous === null) return;
    for (const s of fileScores(previous)) baseline.set(s.file, s.score);
  }
  const scores = fileScores(report);
  for (const s of scores) {
    console.log(
      `${s.score === null ? 'no mutants' : `${s.score}% (${s.detected}/${s.total})`}\t${s.file}`,
    );
  }
  const failing = belowThreshold(scores, min, baseline);
  if (failing.length > 0) {
    for (const s of failing) {
      const why = s.bar < min ? ' (its baseline)' : '';
      console.error(
        `mutation-check: ${s.file} at ${s.score}% < ${s.bar}%${why}`,
      );
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) main(process.argv.slice(2));
