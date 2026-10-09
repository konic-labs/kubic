// The faux testing provider (`KUBIC_PROVIDER=faux`): Pi's faux provider
// with a scripted echo behaviour, so the shipped binary can be driven end
// to end — `kubic run`, `kubic tui` — with no network, no credentials and
// no paid tokens.
//
// It is a TESTING provider. It is never selected implicitly: only the exact
// env value `KUBIC_PROVIDER=faux` turns it on, and every surface that runs a
// model under it says so (the run's stderr header, the TUI footer, `kubic
// models`, `kubic doctor`). Nothing it produces is a model's output.
//
// Behaviour, per model call:
//   - after a tool result: one text reply naming the tool and the size of
//     what it returned (`faux: <tool> returned <n> chars`), ending the turn;
//   - a prompt with a `faux:tool <name> <json-args>` line: one tool call to
//     <name> with those arguments (the lane executes it for real, under the
//     installed policy and journal);
//   - otherwise: `faux echo: <prompt>` — the last user message, verbatim.

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';

export const FAUX_PROVIDER_ID = 'faux';
export const FAUX_MODEL_ID = 'echo';
export const FAUX_MODEL_REF = `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`;

// The one line every surface prints while the faux provider is active.
// The TUI footer's shorter form of the same statement.
export const FAUX_FOOTER = `${FAUX_MODEL_REF}: testing provider, no model is called`;

export const FAUX_NOTICE = `provider: ${FAUX_MODEL_REF} (testing provider: scripted replies, no model is called; KUBIC_PROVIDER=faux)`;

type Env = Readonly<Record<string, string | undefined>>;

export type ProviderOverride =
  | { readonly kind: 'none' }
  | { readonly kind: 'faux' }
  | { readonly kind: 'invalid'; readonly value: string };

// `KUBIC_PROVIDER` is read here and nowhere else. Unset/empty is no
// override; `faux` is the testing provider; anything else is refused by
// name (fail closed — a typo must not silently run a real provider).
export function providerOverrideFromEnv(env: Env): ProviderOverride {
  const value = env.KUBIC_PROVIDER;
  if (value === undefined || value === '') return { kind: 'none' };
  if (value === FAUX_PROVIDER_ID) return { kind: 'faux' };
  return { kind: 'invalid', value };
}

export function fauxProviderActive(env: Env): boolean {
  return providerOverrideFromEnv(env).kind === 'faux';
}

export function invalidProviderMessage(value: string): string {
  return `unsupported KUBIC_PROVIDER ${JSON.stringify(value)} (the only override is 'faux', the testing provider)`;
}

const TOOL_DIRECTIVE = /^\s*faux:tool\s+([A-Za-z0-9_.-]+)(?:\s+(.*))?$/m;

type Handle = ReturnType<typeof fauxProvider>;
type Step = Parameters<Handle['setResponses']>[0][number];
type Factory = Extract<Step, (...args: never[]) => unknown>;
type Transcript = Parameters<Factory>[0];
type Message = Transcript['messages'][number];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: unknown; text?: unknown }) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .join('');
}

function lastOfRole(
  messages: readonly Message[],
  role: Message['role'],
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message;
  }
  return undefined;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | string {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return 'faux:tool arguments must be a JSON object';
    return parsed as Record<string, unknown>;
  } catch (error) {
    return `faux:tool arguments are not JSON (${error instanceof Error ? error.message : String(error)})`;
  }
}

// The scripted reply for one call — exported for the unit tests.
export function fauxReplyFor(
  messages: readonly Message[],
): ReturnType<typeof fauxAssistantMessage> {
  const last = messages[messages.length - 1];
  if (last?.role === 'toolResult') {
    const size = textOf(last.content).length;
    const verdict = last.isError ? 'failed' : 'returned';
    return fauxAssistantMessage(
      fauxText(`faux: ${last.toolName} ${verdict} ${size} chars`),
    );
  }
  const prompt = textOf(lastOfRole(messages, 'user')?.content);
  const directive = TOOL_DIRECTIVE.exec(prompt);
  if (directive !== null) {
    const name = directive[1] as string;
    const args = parseArgs(directive[2]);
    if (typeof args === 'string') return fauxAssistantMessage(fauxText(args));
    return fauxAssistantMessage(
      fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1]),
      { stopReason: 'toolUse' },
    );
  }
  return fauxAssistantMessage(fauxText(`faux echo: ${prompt}`));
}

// Registers the faux provider on `models` with an unbounded script: each
// consumed step re-queues itself, so a session never runs out of replies.
export function registerFauxProvider(models: MutableModels): void {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER_ID,
    models: [
      {
        id: FAUX_MODEL_ID,
        name: 'Faux echo (testing provider)',
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const step: Factory = (context) => {
    faux.appendResponses([step]);
    return fauxReplyFor(context.messages);
  };
  faux.setResponses([step]);
  models.setProvider(faux.provider);
}
