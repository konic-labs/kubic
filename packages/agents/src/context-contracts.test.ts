// Context-contract dispositions (issue #99, scope item 5; §24, §25, §28,
// §69, §70).
//
// #99's job for the inert contracts was a per-module wire-or-delete call,
// executed. This file pins the calls that were NOT "wire", so a later
// session cannot quietly resurrect a module no path reads, and so the design
// sections those modules described are recorded as not-yet-implemented
// instead of silently implied.
//
// The deleted modules had zero non-test importers on HEAD fdbcf28 and no
// honest consumer exists on the shipped path:
//   - the delegation that ships is a CLI fan-out of separate `kubic run -p`
//     PROCESSES (issue #95's decision, documented in
//     docs/architecture/orchestrator.md). There is no in-process parent
//     transcript to isolate, no artifact exchange, no handoff chain and no
//     review loop — so §24/§25/§69/§70's validators had nothing to validate
//     and §28's memory lifetimes duplicated the harness session store.
//   - wiring any of them would have meant inventing a caller, which the
//     sibling issues explicitly rejected as worse than deletion.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = join(ROOT, 'docs', 'dead-surface.md');
const DRIFT = join(ROOT, 'docs', 'design-drift.md');
const ARCHITECTURE = join(ROOT, 'docs', 'architecture', 'orchestrator.md');

// Modules #99 deleted rather than faked. They may not come back without a
// real consumer: this is the pin the ledger's own doctrine asks for.
// NOT in this list, and why: `spec.ts` (its only importer is
// `roles/roles-data.ts`, which open issue #104 owns — deleting it here
// would force deleting that module and its model-defaults data source),
// `budget.ts` (live: the scheduler imports `RunMode`, the extensions bundle
// imports `createBudget`), and `graph.ts` (live: #95's orchestrate CLI).
const DELETED = [
  'packages/agents/src/artifacts.ts',
  'packages/agents/src/memory.ts',
  'packages/agents/src/transfer.ts',
  'packages/host/src/handoff.ts',
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('context contracts: the delete calls stay executed (#99)', () => {
  it('keeps every faked-consumer module deleted', () => {
    for (const module of DELETED) {
      expect(existsSync(join(ROOT, module)), `${module} is back`).toBe(false);
    }
  });

  it('carries no ledger row for a deleted module', () => {
    const ledger = read(LEDGER);
    for (const module of DELETED) {
      // Rows, not prose: the entry that records the deletion names the
      // modules on purpose. A row is `| LOC | \`path\` | owner | why |`.
      const row = new RegExp(`^\\|[^|]*\\|\\s*\`${module}\``, 'm');
      expect(ledger, `${module} still has a ledger row`).not.toMatch(row);
    }
  });

  it('records the deletion and the design sections it leaves unshipped', () => {
    // The honesty half: deleting the module is only defensible if the
    // design sections it implemented are marked not-yet-implemented
    // somewhere a reader of this repo can see (the design document itself
    // is local-only and gitignored).
    const ledger = read(LEDGER);
    expect(ledger).toMatch(/Issue #99[\s\S]{0,400}delet/i);
    expect(ledger).toContain('§25');
    expect(ledger).toContain('§28');
    expect(ledger).toContain('§69');
  });

  it('names the sections as not yet implemented in the drift page', () => {
    const drift = read(DRIFT);
    // §24/§25/§69's enforcement and §28's lifetimes have no live path yet;
    // the drift page is where a clone can read that.
    expect(drift).toMatch(/§24[\s\S]{0,300}§25|§25[\s\S]{0,300}§24/);
    expect(drift).toMatch(/not-yet-implemented|not yet implemented/i);
    expect(drift).toMatch(/§28/);
    expect(drift).toMatch(/§69/);
  });

  it('keeps the no-transcript property that holds structurally on the shipped path', () => {
    // The deleted validator enforced §24/§69 at object level. The property
    // itself survives by construction: the shipped delegation hands each
    // worker process an argv prompt and a session id, never a transcript.
    // The architecture page must keep saying so, because that is now the
    // only statement of the guarantee.
    //
    // Issue #103 changed *what* prompt a worker gets — each worker now runs
    // its own plan step instead of the shared `-p` verbatim — so the older
    // "same prompt" wording is gone for good, and pinning that phrase would
    // pin a claim the shipped code now contradicts. What must survive is the
    // isolation guarantee: a worker is a separate PROCESS in its own
    // worktree, handed a prompt and a session id rather than a parent
    // transcript. That is what this asserts.
    const architecture = read(ARCHITECTURE);
    expect(architecture).toMatch(
      /separate process|one process per|worker process/i,
    );
    expect(architecture).not.toMatch(/same prompt/i);
  });
});
