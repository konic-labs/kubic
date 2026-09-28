// Per-worker approvals, as documented (issue #105, acceptance criterion 5).
// The docs must state what actually shipped, and the two ways they lied before
// are both pinned here:
//   1. `docs/cli/commands.md` and `docs/architecture/orchestrator.md` claimed
//      per-worker approvals were NOT wired (a named future issue);
//   2. nothing documented the behaviour or the exit codes at all.
// The absence assertions below normalize whitespace before matching (markdown
// reflows legitimately) and assert the scanned file list is NON-EMPTY — a scan
// that reads zero files proves nothing and would pass vacuously.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const COMMANDS = join(REPO_ROOT, 'docs', 'cli', 'commands.md');
const ARCHITECTURE = join(REPO_ROOT, 'docs', 'architecture', 'orchestrator.md');

function normalized(path: string): string {
  // Collapse ALL whitespace runs (including newlines) so a reflowed paragraph
  // still matches, and so an absence scan cannot be dodged by a line wrap.
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim();
}

describe('docs: per-worker approvals are documented as shipped (issue #105)', () => {
  it('states the per-worker approval behaviour and the exit codes in the orchestrate section', () => {
    const commands = normalized(COMMANDS);
    // The behaviour: asks route to the user through the run's router/mailbox.
    expect(commands).toMatch(/per-worker approvals/i);
    expect(commands).toMatch(/KUBIC_APPROVALS_DIR/);
    expect(commands).toMatch(/\.kubic\/orchestrator\/approvals/);
    // The named statuses and their §78 exits.
    expect(commands).toContain('approval_denied');
    expect(commands).toContain('BUDGET_EXHAUSTED');
    expect(commands).toContain('approval_timeout');
    expect(commands).toMatch(/exit \*\*4\*\*|exit 4/);
    expect(commands).toMatch(/exit \*\*3\*\*|exit 3/);
    // The two flags that carry the posture, and the read-only manager view.
    expect(commands).toContain('--budget');
    expect(commands).toContain('--full-access');
    expect(commands).toMatch(/read-only blocked indicator/i);
    expect(commands).toMatch(/self-raise|raise its own budget/i);
    expect(commands).toMatch(/session-scop/i);
  });

  it('no longer claims per-worker approvals are unwired, in either document', () => {
    const scanned = [COMMANDS, ARCHITECTURE].map(normalized);
    // Non-vacuity: a scan over empty (or missing) pages would assert nothing,
    // so both pages must carry real content.
    expect(scanned.every((text) => text.length > 1_000)).toBe(true);
    for (const text of scanned) {
      // The old claim, in both of its spellings: "per-worker approvals" as a
      // named future issue, and the "(#105)" parenthetical naming it as such.
      expect(text).not.toMatch(/per-worker approvals[^.]{0,120}remain/i);
      expect(text).not.toMatch(/remain named future issues[^.]{0,200}#105/);
      expect(text).not.toMatch(/\(per-worker approvals\), \[#105\]/);
    }
    // And the architecture page carries the shipped truth instead.
    const architecture = normalized(ARCHITECTURE);
    expect(architecture).toMatch(/issue #105/);
    expect(architecture).toContain('approval_timeout');
    expect(architecture).toContain('BUDGET_EXHAUSTED');
    expect(architecture).toMatch(/session-scoped/i);
    expect(architecture).toMatch(/read-only blocked indicator/i);
  });
});
