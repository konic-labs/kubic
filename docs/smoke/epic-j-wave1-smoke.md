# EPIC J wave-1 live smoke — issues #108/#109/#113 (+#110, #121 unit-pinned)

First live run of the wave-1 hardening against a real subscription provider,
exercising the three p1 behaviors end-to-end through the shipped binary:
the undo staleness safety (#108), the guard drain that kills in-flight tool
work (#109), and the TUI parity boot (#113). Scratch-only: nothing outside
the scratch dir was touched.

- Date: 2026-09-26. Binary: `bin/kubic.js` on repo build (`npm run build`
  clean at `main` after #108/#109/#110/#113/#121).
- Provider: **opencode-go subscription** (`https://opencode.ai/zen/go/v1`,
  `openai-completions`, model `deepseek-v4.1-flash`) via `models.json` in
  the scratch workspace, key in `OPENCODE_GO_KEY` from the operator's
  credential store — never printed, never written to the scratch, never
  committed. The subscription endpoint requires an `x-opencode-session`
  routing header per request; kubic's `models.json` gained a per-provider
  `headers` map for exactly this (committed alongside this doc).
- Hermetic env: `HOME=<scratch>/home` (sessions land under
  `<scratch>/home/.kubic/sessions`); skills fixture at
  `<scratch>/home/.agents/skills/deploy-widget` with
  `KUBIC_TRUST_PROJECT=1` for the TUI leg.

## 1. Settled run + create-entry honesty (exit 0)

```console
$ kubic run -p "Use the write tool to create a file named smoke.txt …"
result: done
session: 01a0dbf9-8e49-7196-be06-eb9b6e984450
journal: journal:01a0dbf9-8e49-7196-be06-eb9b6e984450
usage: usage:01a0dbf9-8e49-7196-be06-eb9b6e984450
trajectory: trajectory:01a0dbf9-8e49-7196-be06-eb9b6e984450
exit: 0
```

The model called `write`; `smoke.txt` landed with the exact content.
`kubic diff --session <id>` renders the attributed change with the honest
`[non-reversible]` badge (a **created** file has no pre-image to restore),
and `undo --dry-run --session <id>` reports
`would restore 0 step(s), skip 1 non-reversible` — the refusal to invent a
pre-image, not a failure. `--force` does not override it, by design.

## 2. Staleness round-trip (#108) — refuse, preserve, then force

A second run edited the existing file through the `edit` tool (journaled
with before-content). Then the exact #108 scenario:

```console
$ kubic undo --dry-run --session <id2>
would restore 1 step(s)          exit: 0
$ printf '…operator-touched-after…' >> smoke.txt   # manual post-journal edit
$ kubic undo --session <id2>
stale (skipped): smoke.txt — stale: 'smoke.txt' changed after this entry
  was journaled (current sha256 63eaedad06c9… ≠ recorded after 2b8e5884d507…)
  — restoring would discard those changes; use --force
undo: 0 restored, 1 skipped (1 stale)          exit: 2
# disk still holds the operator's post-journal edit — nothing destroyed
$ kubic undo --force --session <id2>
restored smoke.txt                              exit: 0
# disk now holds the journaled pre-edit state
```

The stale refusal named both hashes, preserved the operator's edit, and
`--force` restored exactly the recorded before-state.

## 3. Guard drain (#109) — timeout kills the in-flight tree, no orphans

```console
$ kubic run --timeout 4000 -p "Use the bash tool to run: sleep 90 …"
result: run timed out after 4000ms
session: 01a0dbfa-… (ref triple intact)
exit: 3                                    # budget_exhausted, §78
$ ps … | grep "sleep 90"                   # immediately after exit
NO ORPHANS — drain killed the tree
```

Before #109 this run abandoned the drive: the detached `sh -c … sleep 90`
process group outlived the binary and kept writing after the sweep. Now
the guard requests the durable abort, drains the kill registry, and only
then sweeps — no orphan process survives the exit (checked live, twice).

## 4. TUI parity boot (#113) — skills present, live model, clean restore

`kubic tui` under a pty with the skills fixture under `HOME` and
`KUBIC_TRUST_PROJECT=1`: booted the real lane on
`opencode-go/deepseek-v4.1-flash`, rendered the status bar
(`solo • approvals:on • session 01a0dbfa-…`), carried the solo
no-isolation notice, and quit on `Ctrl-C` with the alt-screen restored
exactly once (`?1049l` observed, exit 0, no boot errors). The
`<skills>` block reaching the interactive prompt is pinned by
`tui-parity-prod.test.ts`; this leg proves the live boot composes with
skills discovery enabled.

## Verdict

All five wave-1 behaviors hold on the shipped binary against a live
subscription provider: undo never destroys unjournaled state (#108), a
timed-out run leaves no orphaned tool processes (#109), timeout denials
no longer latch (#110, unit-pinned), chatty child output is bounded
(#121, unit-pinned), and the TUI boots with run-parity context (#113).