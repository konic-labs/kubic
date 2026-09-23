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

// Credential-shaped `key=value` pairs must never be written into an
// artifact — fail closed at validation, redact at render.
const CREDENTIAL_RE =
  /((?:token|password|passwd|secret|api[-_]?key|bearer|authorization|private[-_]?key)\s*(?:[=:]|\s+))\S+/gi;

export function containsCredential(text: string): boolean {
  CREDENTIAL_RE.lastIndex = 0;
  return CREDENTIAL_RE.test(text);
}

export function redactArtifactText(text: string): string {
  CREDENTIAL_RE.lastIndex = 0;
  return text.replace(CREDENTIAL_RE, '$1[REDACTED]');
}

function allTextFields(artifact: TaskArtifact): string[] {
  return [
    artifact.summary,
    ...artifact.fileRefs,
    ...artifact.findings,
    ...(artifact.tests ?? []).flatMap((test) =>
      test.output === undefined ? [test.name] : [test.name, test.output],
    ),
    ...(artifact.decisions ?? []),
    ...(artifact.diffRefs ?? []),
  ];
}

function validateArtifactTest(
  test: unknown,
  index: number,
  errors: string[],
): void {
  if (!isObject(test)) {
    errors.push(`tests[${index}] must be an object`);
    return;
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

  if (!isNonEmptyString(input.artifactId))
    errors.push('artifactId must be a non-empty string');
  if (!isNonEmptyString(input.summary))
    errors.push('summary must be a non-empty string');

  if (!isStringArray(input.fileRefs))
    errors.push('fileRefs must be an array of strings');
  else {
    for (const ref of input.fileRefs) {
      if (!isNonEmptyString(ref)) {
        errors.push('fileRefs entries must be non-empty strings');
        break;
      }
      // Paths only (§25): anything spanning lines is file contents, not a
      // ref. NUL bytes can never appear in a path either.
      if (ref.includes('\n') || ref.includes('\r') || ref.includes('\0')) {
        errors.push(
          `fileRefs are paths only, never contents (§25): '${ref.slice(0, 40)}'`,
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
  for (const field of ['decisions', 'diffRefs'] as const) {
    const value = input[field];
    if (
      value !== undefined &&
      (!isStringArray(value) || !value.every(isNonEmptyString))
    )
      errors.push(`${field} must be an array of non-empty strings`);
  }

  if (errors.length === 0 && isObject(input)) {
    const candidate = input as unknown as TaskArtifact;
    const leaked = allTextFields(candidate).find((text) =>
      containsCredential(text),
    );
    if (leaked !== undefined)
      errors.push(
        'artifact must not carry credential-shaped values (redact before write)',
      );
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, artifact: input as unknown as TaskArtifact };
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
// travel by construction (§25.4 token economics).
export function buildChildPrompt(input: ChildPromptInput): string {
  const lines = [`objective: ${input.objective}`];
  if (input.constraints !== undefined && input.constraints.length > 0)
    lines.push(`constraints: ${input.constraints.join('; ')}`);
  if (input.relevantFiles !== undefined && input.relevantFiles.length > 0)
    lines.push(`relevant files: ${input.relevantFiles.join(', ')}`);
  if (input.previousFindings !== undefined)
    lines.push(`previous findings: ${input.previousFindings}`);
  if (input.expectedOutput !== undefined)
    lines.push(`expected output: ${input.expectedOutput}`);
  if (
    input.artifactSummaries !== undefined &&
    input.artifactSummaries.length > 0
  )
    lines.push(`artifacts: ${input.artifactSummaries.join('; ')}`);
  return lines.join('\n');
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
  const lines = [`[artifact ${clean.artifactId}] ${clean.summary}`];
  lines.push(`files: ${clean.fileRefs.join(', ')}`);
  for (const finding of clean.findings) lines.push(`finding: ${finding}`);
  for (const test of clean.tests ?? [])
    lines.push(`test: ${test.name} (${test.passed ? 'pass' : 'fail'})`);
  for (const decision of clean.decisions ?? [])
    lines.push(`decision: ${decision}`);
  if (clean.diffRefs !== undefined && clean.diffRefs.length > 0)
    lines.push(`diffs: ${clean.diffRefs.join(', ')}`);
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
      : { tests: clean.tests.map((test) => ({ ...test })) }),
    ...(clean.decisions === undefined
      ? {}
      : { decisions: [...clean.decisions] }),
    ...(clean.diffRefs === undefined ? {} : { diffRefs: [...clean.diffRefs] }),
  };
}

// Defense in depth: render paths redact credential-shaped text even though
// validation already rejects it at write time.
export function sanitizeArtifact(artifact: TaskArtifact): TaskArtifact {
  return {
    ...artifact,
    summary: redactArtifactText(artifact.summary),
    fileRefs: artifact.fileRefs.map(redactArtifactText),
    findings: artifact.findings.map(redactArtifactText),
    ...(artifact.tests === undefined
      ? {}
      : {
          tests: artifact.tests.map((test) => ({
            ...test,
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
    });
  }
  if (!isNonEmptyString(input.diffRef))
    errors.push('diffRef must be a non-empty string');
  if (!isNonEmptyString(input.worktree))
    errors.push('worktree must be a non-empty string');
  else if (!input.worktree.startsWith('/'))
    errors.push('worktree must be an absolute path');
  if (!Array.isArray(input.constraints))
    errors.push('constraints must be an array');
  if (!Array.isArray(input.artifactIds))
    errors.push('artifactIds must be an array');
  if (!isNonEmptyString(input.workerId))
    errors.push('workerId must be a non-empty string');
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    handoff: {
      role: 'debugger',
      result: {
        status: 'failed',
        summary: input.summary,
        filesChanged: [...input.filesChanged],
        tests: input.failingTests.map((test) => ({
          name: test.name,
          passed: false as const,
          ...(test.output === undefined ? {} : { output: test.output }),
        })),
      },
      artifactIds: [...input.artifactIds],
      diffRef: input.diffRef,
      worktree: input.worktree,
      constraints: [...input.constraints],
      writeScope: 'worktree',
    },
  };
}

// Fresh-session debugger prompt: failing tests + diff ref + constraints +
// artifact refs. No transcript parameter exists — a new session starts from
// this prompt alone.
export function freshDebuggerPrompt(handoff: DebuggerHandoff): string {
  const lines = [
    'role: debugger',
    `resume from: ${handoff.result.summary}`,
    `failing tests: ${handoff.result.tests
      .map((test) =>
        test.output === undefined ? test.name : `${test.name} (${test.output})`,
      )
      .join('; ')}`,
    `diff ref: ${handoff.diffRef}`,
    `files: ${handoff.result.filesChanged.join(', ')}`,
    `constraints: ${handoff.constraints.join('; ')}`,
    `artifacts: ${handoff.artifactIds.join(', ')}`,
    `worktree: ${handoff.worktree}`,
  ];
  return lines.join('\n');
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
