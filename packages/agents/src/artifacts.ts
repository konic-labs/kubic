// TaskArtifact + isolation/sharing rules (issue #32; design §25).
// Isolation-by-default: a spawned child NEVER receives the parent
// transcript, unrelated output, credentials, or hidden state — only the
// bounded transfer object plus referenced artifacts. Artifacts travel as
// session entries (transcript) and trajectory records (refs only): file
// refs are paths, never contents; diff refs point at diffs without
// embedding them. Handoff (implementer→debugger) resumes from the failing
// test + diff ref + constraints in a fresh session.
//
// Self-contained on purpose: the agents package must not import host,
// worker, or trajectory (dep-lint), so the debugger-handoff shape here is
// structural — field-compatible with the host handoff without importing it.

export interface ArtifactTest {
  name: string;
  passed: boolean;
  output?: string;
}

export interface TaskArtifact {
  artifactId: string;
  summary: string;
  fileRefs: string[];
  findings: string[];
  tests?: ArtifactTest[];
  decisions?: string[];
  diffRefs?: string[];
}

// Closed-world field coverage: §25 fixes the artifact contents exactly.
export const ARTIFACT_FIELDS = {
  artifactId: true,
  summary: true,
  fileRefs: true,
  findings: true,
  tests: true,
  decisions: true,
  diffRefs: true,
} satisfies Record<keyof TaskArtifact, true>;

export type ArtifactValidation =
  | { valid: true; artifact: TaskArtifact }
  | { valid: false; errors: string[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

// Credential-shaped values must never be written into an artifact — fail
// closed at validation, redact at render. Multiple shapes: spaced or quoted
// separators, JSON-quoted keys, compound env names, and bare token formats.
// Redaction replaces the WHOLE match so no secret material survives next to
// the label.
const CREDENTIAL_PATTERNS: RegExp[] = [
  // `Authorization: Bearer <token>` must match as ONE unit: the generic
  // keyword pattern below would otherwise consume only
  // `Authorization: Bearer`, leaving the token beside `[REDACTED]`.
  /authorization\s*:\s*bearer\s+\S+/gi,
  // Keyword assignment: `api_key=…`, `password: value`, `"password": "…"`,
  // `password is hunter2`. Optional quotes handle JSON-quoted keys.
  /["']?(?:token|password|passwd|secret|api[-_ ]?key|bearer|authorization|private[-_ ]?key)["']?\s*(?:[=:]\s*|\s+(?:is\s+)?)\S+/gi,
  // Bare `key: value` / `key="value"` (strict separator — bare `key` with
  // whitespace separation would false-positive on prose like "key insight").
  /["']?\bkey["']?\s*[=:]\s*\S+/gi,
  // Compound env names: `AWS_SECRET_ACCESS_KEY=…`, `stripe_api_key: …`.
  /\b[A-Za-z0-9_]*(?:secret|token|passwd|password|private[_-]?key|api[_-]?key|auth[_-]?token|bearer)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?\S+/gi,
  // Bare token shapes: Stripe, GitHub, AWS, Slack, PEM blocks.
  /\bsk-(?:live|test)-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opurs]_[A-Za-z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{8,}\b/g,
  /\bxox[bpas]-[A-Za-z0-9-]{8,}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
];

export function containsCredential(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactArtifactText(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

// Fake-transcript / prompt-injection shapes: forged `[artifact …]` blocks,
// role/transcript headers starting a line, and instruction overrides.
// Artifact text renders quoted, and validation rejects these outright.
const TRANSCRIPT_MARKER_RE =
  /\[artifact[\s\]]|^\s*(?:system|assistant|user|human|transcript|prompt|debugger|implementer)\s*:|ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+(?:all\s+|these\s+|prior\s+)?(?:previous\s+|prior\s+)?instructions|<\s*system\s*>/im;

function containsTranscriptMarker(text: string): boolean {
  return TRANSCRIPT_MARKER_RE.test(text);
}

const MAX_PATH_LENGTH = 256;
const PATH_CHARS_RE = /^[A-Za-z0-9._\-/]+$/;

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Paths only (§25): relative, confined, printable, bounded. Returns the
// reason when the ref is not a safe worktree-relative path.
function unsafePathReason(ref: string): string | undefined {
  if (ref.length > MAX_PATH_LENGTH) return 'overlong path';
  if (hasControlChar(ref)) return 'control characters';
  if (ref.startsWith('/') || ref.startsWith('~'))
    return 'absolute or home-relative path';
  if (ref.split('/').includes('..')) return 'parent-directory traversal';
  if (!PATH_CHARS_RE.test(ref)) return 'characters outside the path allow-list';
  return undefined;
}

function allTextFields(artifact: TaskArtifact): string[] {
  // Nested scan: EVERY string value inside tests[] entries is gated — a
  // smuggled key (parentTranscript, evil, …) cannot hide a credential or a
  // transcript marker from the closed-world checks below.
  const nestedTestStrings = (artifact.tests ?? []).flatMap((test) =>
    Object.values(test).filter(
      (value): value is string => typeof value === 'string',
    ),
  );
  return [
    artifact.artifactId,
    artifact.summary,
    ...artifact.fileRefs,
    ...artifact.findings,
    ...nestedTestStrings,
    ...(artifact.decisions ?? []),
    ...(artifact.diffRefs ?? []),
  ];
}

// Closed world for tests[] entries too (§25): only name/passed/output
// travel — unknown nested keys are rejected at validation and stripped
// from every returned artifact.
const TEST_FIELDS = {
  name: true,
  passed: true,
  output: true,
} satisfies Record<keyof ArtifactTest, true>;

function validateArtifactTest(
  test: unknown,
  index: number,
  errors: string[],
): void {
  if (!isObject(test)) {
    errors.push(`tests[${index}] must be an object`);
    return;
  }
  for (const key of Object.keys(test)) {
    if (!(key in TEST_FIELDS))
      errors.push(
        `tests[${index}] must not carry unknown field '${key}' (§25)`,
      );
  }
  if (!isNonEmptyString(test.name))
    errors.push(`tests[${index}].name must be a non-empty string`);
  if (typeof test.passed !== 'boolean')
    errors.push(`tests[${index}].passed must be a boolean`);
  if (test.output !== undefined && typeof test.output !== 'string')
    errors.push(`tests[${index}].output must be a string when present`);
}

export function validateArtifact(input: unknown): ArtifactValidation {
  const errors: string[] = [];
  if (!isObject(input))
    return { valid: false, errors: ['artifact must be an object'] };

  // Deny-list at the artifact boundary too: contents and secrets are never
  // stored, only referenced.
  for (const banned of [
    'transcript',
    'contents',
    'fileContents',
    'credentials',
    'secret',
  ]) {
    if (banned in input)
      errors.push(`artifact must not carry '${banned}' (§25)`);
  }

  // Closed world (§25): ARTIFACT_FIELDS fixes the contents exactly — unknown
  // fields are rejected here and stripped from every returned artifact.
  for (const key of Object.keys(input)) {
    if (!(key in ARTIFACT_FIELDS))
      errors.push(`artifact must not carry unknown field '${key}' (§25)`);
  }

  if (!isNonEmptyString(input.artifactId))
    errors.push('artifactId must be a non-empty string');
  else if (hasControlChar(input.artifactId))
    errors.push('artifactId must not carry control characters (§25)');
  if (!isNonEmptyString(input.summary))
    errors.push('summary must be a non-empty string');
  else if (hasControlChar(input.summary))
    errors.push('summary must not carry control characters (§25)');

  if (!isStringArray(input.fileRefs))
    errors.push('fileRefs must be an array of strings');
  else {
    for (const ref of input.fileRefs) {
      if (!isNonEmptyString(ref)) {
        errors.push('fileRefs entries must be non-empty strings');
        break;
      }
      // Paths only (§25): worktree-relative, confined, printable, bounded —
      // never contents, escapes, or blobs.
      const reason = unsafePathReason(ref);
      if (reason !== undefined) {
        errors.push(
          `fileRefs are paths only, never contents (§25): ${reason} in '${ref.slice(0, 40)}'`,
        );
        break;
      }
    }
  }

  if (!isStringArray(input.findings) || !input.findings.every(isNonEmptyString))
    errors.push('findings must be an array of non-empty strings');

  if (input.tests !== undefined) {
    if (!Array.isArray(input.tests)) errors.push('tests must be an array');
    else {
      for (const [index, test] of input.tests.entries()) {
        validateArtifactTest(test, index, errors);
      }
    }
  }
  for (const field of ['decisions'] as const) {
    const value = input[field];
    if (
      value !== undefined &&
      (!isStringArray(value) || !value.every(isNonEmptyString))
    )
      errors.push(`${field} must be an array of non-empty strings`);
  }

  // Diff refs are paths too (§25): confined exactly like fileRefs — never
  // absolute, traversing, overlong, or newline-bearing blobs.
  if (
    input.diffRefs !== undefined &&
    (!isStringArray(input.diffRefs) || !input.diffRefs.every(isNonEmptyString))
  )
    errors.push('diffRefs must be an array of non-empty strings');
  else if (input.diffRefs !== undefined) {
    for (const ref of input.diffRefs) {
      const reason = unsafePathReason(ref);
      if (reason !== undefined) {
        errors.push(
          `diffRefs are paths only, never contents (§25): ${reason} in '${ref.slice(0, 40)}'`,
        );
        break;
      }
    }
  }

  if (errors.length === 0 && isObject(input)) {
    const candidate = input as unknown as TaskArtifact;
    const texts = allTextFields(candidate);
    const forged = texts.find((text) => containsTranscriptMarker(text));
    if (forged !== undefined)
      errors.push(
        'artifact text must not carry transcript-shaped or instruction-override content (§25; artifact text renders quoted)',
      );
    else {
      const leaked = texts.find((text) => containsCredential(text));
      if (leaked !== undefined)
        errors.push(
          'artifact must not carry credential-shaped values (redact before write)',
        );
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  // Closed world: return only ARTIFACT_FIELDS with test entries stripped to
  // name/passed/output — smuggled keys cannot travel on the accepted
  // artifact even if a caller bypasses validation.
  const source = input as unknown as TaskArtifact;
  return {
    valid: true,
    artifact: {
      artifactId: source.artifactId,
      summary: source.summary,
      fileRefs: [...source.fileRefs],
      findings: [...source.findings],
      ...(source.tests === undefined
        ? {}
        : {
            tests: source.tests.map((test) => ({
              name: test.name,
              passed: test.passed,
              ...(test.output === undefined ? {} : { output: test.output }),
            })),
          }),
      ...(source.decisions === undefined
        ? {}
        : { decisions: [...source.decisions] }),
      ...(source.diffRefs === undefined
        ? {}
        : { diffRefs: [...source.diffRefs] }),
    },
  };
}

// Spawn deny-list (§25.1): nothing outside the bounded transfer object
// travels to the child — no parent transcript, no unrelated output, no
// credentials, no hidden state.
export const SPAWN_DENY_FIELDS = [
  'transcript',
  'parentTranscript',
  'unrelatedOutput',
  'credentials',
  'secret',
  'secrets',
  'hiddenState',
  'internalState',
  'fileContents',
] as const;

export type SpawnIsolation =
  | { isolated: true }
  | { isolated: false; errors: string[] };

export function checkSpawnIsolation(input: unknown): SpawnIsolation {
  if (!isObject(input))
    return { isolated: false, errors: ['spawn payload must be an object'] };
  const errors: string[] = [];
  for (const field of SPAWN_DENY_FIELDS) {
    if (field in input)
      errors.push(`spawn payload must not carry '${field}' (§25)`);
  }
  if (errors.length > 0) return { isolated: false, errors };
  return { isolated: true };
}

export interface ChildPromptInput {
  objective: string;
  constraints?: string[];
  relevantFiles?: string[];
  previousFindings?: string;
  expectedOutput?: string;
  artifactSummaries?: string[];
}

// The child prompt is built ONLY from bounded transfer fields — the
// signature takes no transcript parameter, so zero parent-transcript tokens
// travel by construction (§25.4 token economics). Free-text fields render
// JSON-quoted so embedded newlines, forged markers, or instruction overrides
// stay inert string content — never a new prompt line.
export function buildChildPrompt(input: ChildPromptInput): string {
  const lines = [`objective: ${JSON.stringify(input.objective)}`];
  if (input.constraints !== undefined && input.constraints.length > 0)
    lines.push(
      `constraints: ${input.constraints.map((constraint) => JSON.stringify(constraint)).join('; ')}`,
    );
  if (input.relevantFiles !== undefined && input.relevantFiles.length > 0)
    lines.push(
      `relevant files: ${input.relevantFiles.map((file) => JSON.stringify(file)).join(', ')}`,
    );
  if (input.previousFindings !== undefined)
    lines.push(`previous findings: ${JSON.stringify(input.previousFindings)}`);
  if (input.expectedOutput !== undefined)
    lines.push(`expected output: ${JSON.stringify(input.expectedOutput)}`);
  if (
    input.artifactSummaries !== undefined &&
    input.artifactSummaries.length > 0
  )
    lines.push(
      `artifacts: ${input.artifactSummaries.map((summary) => JSON.stringify(summary)).join('; ')}`,
    );
  return redactArtifactText(lines.join('\n'));
}

// Prompt assertion for the zero-transcript acceptance criterion: no
// non-trivial parent line may appear in the child prompt. parentTokens is 0
// exactly when nothing leaked.
export function assertPromptCarriesNoTranscript(
  prompt: string,
  parentTranscript: string,
): { leaked: boolean; parentTokens: number } {
  const lines = parentTranscript
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  const leaked =
    lines.length > 0 && lines.some((line) => prompt.includes(line));
  return {
    leaked,
    parentTokens: leaked ? Math.ceil(parentTranscript.length / 4) : 0,
  };
}

// Artifacts as session entries: the transcript surface carries a human
// block; the trajectory surface carries the JSON refs record.
export interface ArtifactTranscriptEntry {
  kind: 'artifact';
  artifactId: string;
  text: string;
}

export function renderArtifactTranscript(artifact: TaskArtifact): string {
  const clean = sanitizeArtifact(artifact);
  // Header fields render JSON-quoted so embedded newlines or control text
  // stay inert string content — one block per artifact, never a forged line.
  const lines = [
    `[artifact ${JSON.stringify(clean.artifactId)}] ${JSON.stringify(clean.summary)}`,
  ];
  lines.push(`files: ${clean.fileRefs.join(', ')}`);
  for (const finding of clean.findings)
    lines.push(`finding: ${JSON.stringify(finding)}`);
  for (const test of clean.tests ?? [])
    lines.push(
      `test: ${JSON.stringify(test.name)} (${test.passed ? 'pass' : 'fail'})` +
        (test.output === undefined ? '' : ` ${JSON.stringify(test.output)}`),
    );
  for (const decision of clean.decisions ?? [])
    lines.push(`decision: ${JSON.stringify(decision)}`);
  if (clean.diffRefs !== undefined && clean.diffRefs.length > 0)
    lines.push(
      `diffs: ${clean.diffRefs.map((ref) => JSON.stringify(ref)).join(', ')}`,
    );
  return lines.join('\n');
}

export function toTranscriptEntry(
  artifact: TaskArtifact,
): ArtifactTranscriptEntry {
  return {
    kind: 'artifact',
    artifactId: artifact.artifactId,
    text: renderArtifactTranscript(artifact),
  };
}

export interface ArtifactTrajectoryRecord {
  kind: 'artifact';
  artifactId: string;
  summary: string;
  fileRefs: string[];
  findings: string[];
  tests?: ArtifactTest[];
  decisions?: string[];
  diffRefs?: string[];
}

export function toTrajectoryRecord(
  artifact: TaskArtifact,
): ArtifactTrajectoryRecord {
  const clean = sanitizeArtifact(artifact);
  return {
    kind: 'artifact',
    artifactId: clean.artifactId,
    summary: clean.summary,
    fileRefs: [...clean.fileRefs],
    findings: [...clean.findings],
    ...(clean.tests === undefined
      ? {}
      : {
          tests: clean.tests.map((test) => ({
            name: test.name,
            passed: test.passed,
            ...(test.output === undefined ? {} : { output: test.output }),
          })),
        }),
    ...(clean.decisions === undefined
      ? {}
      : { decisions: [...clean.decisions] }),
    ...(clean.diffRefs === undefined ? {} : { diffRefs: [...clean.diffRefs] }),
  };
}

// Defense in depth: render paths redact credential-shaped text even though
// validation already rejects it at write time. Closed world: only
// ARTIFACT_FIELDS survive — smuggled keys are stripped, never spread.
export function sanitizeArtifact(artifact: TaskArtifact): TaskArtifact {
  return {
    artifactId: redactArtifactText(artifact.artifactId),
    summary: redactArtifactText(artifact.summary),
    fileRefs: artifact.fileRefs.map(redactArtifactText),
    findings: artifact.findings.map(redactArtifactText),
    ...(artifact.tests === undefined
      ? {}
      : {
          tests: artifact.tests.map((test) => ({
            name: redactArtifactText(test.name),
            passed: test.passed,
            ...(test.output === undefined
              ? {}
              : { output: redactArtifactText(test.output) }),
          })),
        }),
    ...(artifact.decisions === undefined
      ? {}
      : { decisions: artifact.decisions.map(redactArtifactText) }),
    ...(artifact.diffRefs === undefined
      ? {}
      : { diffRefs: artifact.diffRefs.map(redactArtifactText) }),
  };
}

// Handoff path (§25.3): implementer→debugger resumes in a FRESH session
// from the failing test + diff ref + constraints. Structural shape —
// field-compatible with the host handoff without importing it (dep-lint).
export interface DebuggerHandoffInput {
  summary: string;
  filesChanged: string[];
  failingTests: { name: string; output?: string }[];
  diffRef: string;
  worktree: string;
  constraints: string[];
  artifactIds: string[];
  workerId: string;
}

export interface DebuggerHandoff {
  role: 'debugger';
  result: {
    status: 'failed';
    summary: string;
    filesChanged: string[];
    tests: { name: string; passed: false; output?: string }[];
  };
  artifactIds: string[];
  diffRef: string;
  worktree: string;
  constraints: string[];
  writeScope: 'worktree';
}

export type DebuggerHandoffBuild =
  | { valid: true; handoff: DebuggerHandoff }
  | { valid: false; errors: string[] };

export function buildDebuggerHandoff(
  input: DebuggerHandoffInput,
): DebuggerHandoffBuild {
  const errors: string[] = [];
  if (!isNonEmptyString(input.summary))
    errors.push('summary must be a non-empty string');
  if (
    !Array.isArray(input.filesChanged) ||
    !input.filesChanged.every(isNonEmptyString)
  )
    errors.push('filesChanged must be an array of non-empty strings');
  if (!Array.isArray(input.failingTests) || input.failingTests.length === 0)
    errors.push('failingTests must be a non-empty array');
  else {
    input.failingTests.forEach((test, index) => {
      if (!isObject(test) || !isNonEmptyString(test.name))
        errors.push(`failingTests[${index}].name must be a non-empty string`);
      if (
        isObject(test) &&
        test.output !== undefined &&
        typeof test.output !== 'string'
      )
        errors.push(
          `failingTests[${index}].output must be a string when present`,
        );
    });
  }
  if (!isNonEmptyString(input.diffRef))
    errors.push('diffRef must be a non-empty string');
  else {
    const reason = unsafePathReason(input.diffRef);
    if (reason !== undefined)
      errors.push(
        `diffRef must be a worktree-relative path, never absolute or parent-traversing (§25): ${reason}`,
      );
  }
  if (!isNonEmptyString(input.worktree))
    errors.push('worktree must be a non-empty string');
  else if (!input.worktree.startsWith('/'))
    errors.push('worktree must be an absolute path');
  else if (
    hasControlChar(input.worktree) ||
    input.worktree.split('/').includes('..')
  )
    errors.push('worktree must be a concrete absolute path without traversal');
  if (!Array.isArray(input.constraints))
    errors.push('constraints must be an array');
  if (!Array.isArray(input.artifactIds))
    errors.push('artifactIds must be an array');
  if (!isNonEmptyString(input.workerId))
    errors.push('workerId must be a non-empty string');
  // Handoff files stay inside the worktree: relative refs only.
  if (
    Array.isArray(input.filesChanged) &&
    input.filesChanged.every(isNonEmptyString)
  ) {
    const escaped = input.filesChanged.find(
      (ref) => unsafePathReason(ref) !== undefined,
    );
    if (escaped !== undefined)
      errors.push(
        `filesChanged must be worktree-relative paths, never absolute or parent-traversing (§25): '${escaped.slice(0, 40)}'`,
      );
  }
  // Same credential gate as artifacts: failing-test output and constraints
  // must not carry secrets, nor forged transcript/instruction content.
  if (errors.length === 0) {
    const texts = [
      input.summary,
      ...input.filesChanged,
      ...input.failingTests.flatMap((test) =>
        [test.name, test.output].filter(
          (part): part is string => typeof part === 'string',
        ),
      ),
      input.diffRef,
      input.worktree,
      ...input.constraints.filter(
        (constraint): constraint is string => typeof constraint === 'string',
      ),
      ...input.artifactIds.filter((id): id is string => typeof id === 'string'),
    ];
    if (texts.some((text) => containsCredential(text)))
      errors.push(
        'handoff must not carry credential-shaped values (redact before write)',
      );
    else if (texts.some((text) => containsTranscriptMarker(text)))
      errors.push(
        'handoff text must not carry transcript-shaped or instruction-override content (§25)',
      );
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    handoff: {
      role: 'debugger',
      result: {
        status: 'failed',
        summary: redactArtifactText(input.summary),
        filesChanged: input.filesChanged.map(redactArtifactText),
        tests: input.failingTests.map((test) => ({
          name: redactArtifactText(test.name),
          passed: false as const,
          ...(test.output === undefined
            ? {}
            : { output: redactArtifactText(test.output) }),
        })),
      },
      artifactIds: [...input.artifactIds],
      diffRef: input.diffRef,
      worktree: input.worktree,
      constraints: input.constraints.map(redactArtifactText),
      writeScope: 'worktree',
    },
  };
}

// Fresh-session debugger prompt: failing tests + diff ref + constraints +
// artifact refs. No transcript parameter exists — a new session starts from
// this prompt alone. Free text renders JSON-quoted and the prompt is
// redacted, so smuggled credentials or markers stay inert.
export function freshDebuggerPrompt(handoff: DebuggerHandoff): string {
  const lines = [
    'role: debugger',
    `resume from: ${JSON.stringify(handoff.result.summary)}`,
    `failing tests: ${handoff.result.tests
      .map((test) =>
        test.output === undefined
          ? JSON.stringify(test.name)
          : `${JSON.stringify(test.name)} (${JSON.stringify(test.output)})`,
      )
      .join('; ')}`,
    `diff ref: ${JSON.stringify(handoff.diffRef)}`,
    `files: ${handoff.result.filesChanged.map((file) => JSON.stringify(file)).join(', ')}`,
    `constraints: ${handoff.constraints.map((constraint) => JSON.stringify(constraint)).join('; ')}`,
    `artifacts: ${handoff.artifactIds.map((id) => JSON.stringify(id)).join(', ')}`,
    `worktree: ${JSON.stringify(handoff.worktree)}`,
  ];
  return redactArtifactText(lines.join('\n'));
}

// Token economics (§25.4): handoffs carry refs + failing-test excerpts, not
// transcripts or contents, so a five-agent review chain costs ~5 bounded
// prompts instead of 5× the full history.
export const TOKEN_ECONOMICS_NOTE =
  'Token economics (§25.4): artifacts and handoffs carry references ' +
  '(artifact ids, file paths, diff refs) plus short excerpts (failing-test ' +
  'output, constraints) — never the parent transcript and never file ' +
  'contents. Each spawn therefore costs one bounded prompt, keeping a ' +
  'five-agent review chain affordable.';

export function estimateHandoffTokens(handoff: DebuggerHandoff): {
  approxTokens: number;
  fields: string[];
} {
  const fields = [
    'role',
    'result',
    'artifactIds',
    'diffRef',
    'worktree',
    'constraints',
    'writeScope',
  ];
  return {
    approxTokens: Math.ceil(JSON.stringify(handoff).length / 4),
    fields,
  };
}
