# Models and providers

> `kubic models` and `kubic setup`, the `models.json` catalog, and where
> provider keys come from. Back to the [command index](commands.md).

## `kubic models [provider] [--all] [--json] [--resolve <provider/id>]`

Catalog readout over Pi's **built-in providers** (the generated catalogue:
`anthropic`, `openai`, `google`, `amazon-bedrock`, `openrouter`, …) plus
`models.json` customs from `~/.kubic/models/models.json` (always) and the
project's `models.json` at the project root — the git top level or nearest
`.kubic/`, so any subdirectory sees the same providers — only once the
project is trusted (`KUBIC_TRUST_PROJECT=1`). Each file found is reported as an
`info: loaded models.json: <path> (global|project, trusted): …` /
`info: models.json ignored: <path> …` line on stderr (under `--json` too:
stdout stays one document) — untrusted, invalid
or colliding files are named, never fatal (see
[configuration](#modelsjson)). A built-in is
**usable** when its auth is configured: its documented env key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, …), Anthropic's workload identity federation variables
(`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_IDENTITY_TOKEN_FILE`), or, for Bedrock/Vertex, the ambient
AWS/Google credentials Pi recognises. Only **chat** models are ever listed or
resolved: the catalogue also carries image and classifier entries, and the
unqualified reads `kubic models` and model selection use return chat models
only. A custom provider may not reuse a built-in id
(the file is ignored with a note naming the collision). Under
`KUBIC_PROVIDER=faux` the catalog also lists the `faux` testing provider
and a `warn:` line names it.

| Flag | Meaning |
| --- | --- |
| (none) | Off a terminal: a `PROVIDER  MODEL  THINKING  IN $/1M  OUT $/1M` table (plain aligned columns), one row per model of every **usable** provider, then `info: <n> built-in providers not configured (set their env key): …` on stderr for the rest. On an interactive colour terminal: the catalogue view — a `MODEL  CONTEXT  THINKING  INPUT  IN $/1M  OUT $/1M  KEY` kit table grouped by provider, the default model marked `● <provider/id>  default` (the configured pin, else the model a run would pick), every provider with more than 8 models folded to its first 3 rows and a `<provider>/… N more  kubic models <provider>` line, one `○ N providers without a key  kubic models --all` line, the `keys: <provider> ← <source>` line, and `set a default: kubic setup`. With nothing usable, stdout stays empty and stderr says `info: no usable providers (set a built-in provider's env key, e.g. ANTHROPIC_API_KEY, or add models.json)`. Exits 0. |
| `[provider]` | List one provider in full (no folding), configured or not; `--json` is scoped to it too. An unknown provider is a usage error: `error: unknown provider "<id>"; did you mean '<id>'?` when one is close, else `error: unknown provider "<id>" (known: …)`, on stderr, exit 2. |
| `--all` | Include the providers without a configured key (their KEY cell reads `—`; off a terminal their rows join the plain table and the `not configured` note is dropped). |
| `--json` | Every registered provider, usable or not, as one pretty-printed JSON document: `id`, `name`, `source` (`built-in`, `testing` or the `models.json` path), `usable`, `auth` (the auth source Pi reported, when configured) and `models` (`id`, `name`, `contextWindow`, `thinking`, `inputCost`, `outputCost`, `cacheReadCost`, `cacheWriteCost`, `input` modalities; `contextWindow` is followed by `contextWindowDefaulted: true` on a `models.json` model that declares no window). A model on the fallback window is marked `(default — set contextWindow)` in the interactive catalogue and flagged in `--json`; piped output has no window column and shows no marker. Exits 0. |
| `--resolve <provider/id>` | Print `selected <provider>/<id> (thinking: …)` for any registered model, built-in or custom, configured or not; a resolution failure prints `error: …` on stderr and exits 1. |

**Default model.** `kubic run`/`kubic tui` with no `--model`, `[model]`,
`KUBIC_MODEL` or role pin take the default model of the first usable
provider. Providers are tried in this order: `models.json` customs, then
built-ins whose auth is configured — `anthropic`, `openai`, `google` and
`openrouter` first, the rest in catalogue order, and last the ambient
credentials a machine often carries for other work (`amazon-bedrock`,
`google-vertex`, `github-copilot`, `openai-codex`), so an AWS profile never
takes the default away from an explicit key. A provider's default model is
its curated coding default (for example `anthropic/claude-sonnet-5-5`,
`openai/gpt-6.1-sol`, `google/gemini-3.1-pro-preview`), never simply the
first catalogue entry; a `models.json` provider uses its first model. A
built-in with no key is never picked implicitly, and neither is Bedrock
without a region (`AWS_REGION`, `AWS_DEFAULT_REGION` or the active profile's
`region`): `kubic doctor` warns `provider:amazon-bedrock (auth-incomplete)`
and names what to set. With nothing usable the run exits 6
(`provider_probe_failed`). Pin the model you mean, e.g.
`[model] provider = "anthropic"`, `id = "claude-sonnet-4-6"`.

Usage errors (unknown option, `--resolve` without a value, an unknown
provider) exit 2 on stderr. `--help`/`-h` prints the generated help and exits 0.

## `kubic setup`

Interactive first-run setup: from "installed" to "ready" in
under a minute.

1. **Provider** — the providers whose key is detected (the same detection
   `kubic models` and `kubic doctor` use: env keys, Bedrock/Vertex ambient
   credentials, `models.json` customs; the testing provider is never offered),
   in the order the default pick tries them. One detected provider is
   confirmed as a step; several are a choice, with the current pin's provider
   (or the one a run would pick) preselected.
2. **Default model** — that provider's chat models, the current pin (or the
   provider's default model) preselected, each with its context window and
   thinking support.
3. **Thinking level** — only for a model that supports thinking (`medium`
   preselected when supported).
4. **Trust** — when the current directory has a project layer
   (`.kubic/config.toml` or a project `models.json`) with no recorded
   decision, the same question `kubic tui` asks; the answer is recorded in
   the trust store.
5. **Save** — `[model] provider`, `id` and `thinking` go to
   `~/.kubic/config.toml`. An existing file is updated line by line: the
   three keys are replaced inside an existing `[model]` table (missing ones
   appended to it) or the table is appended; comments, other tables and
   CRLF line endings are kept. The write is atomic (write then rename).

A frozen enterprise `[model]` (`/etc/kubic/config.toml`) asks no model
question: the step names the pinned model and nothing is written. With no
provider key at all, setup names the variables to set (and `models.json`)
and exits **6** without writing. A cancelled question (Ctrl-C / Esc) writes
nothing and exits **130**. Off a terminal (stdin or stdout not a TTY) setup
refuses with `error: kubic setup is interactive: …` and the manual
alternative (`[model]` in `~/.kubic/config.toml` or `KUBIC_MODEL`), exit
**2**.

**First run.** A bare `kubic` on a terminal with no `~/.kubic/config.toml`,
no `KUBIC_MODEL`, not under `KUBIC_PROVIDER=faux` and without
`KUBIC_SKIP_SETUP=1` runs setup first, then opens the TUI on the model it
saved. Cancelling it still opens the TUI and leaves a comment-only
`~/.kubic/config.toml` (`# kubic setup was skipped …`) so the question is
not asked on every launch; `kubic setup` asks again any time. With no
provider key the first run exits 6 like `kubic setup`.

## models.json

Custom (OpenAI-compatible) providers are declared in `models.json`, on top
of Pi's built-in providers. Files, in load order:

| Location | Trust |
| --- | --- |
| `~/.kubic/models/models.json` (global) | Always loaded — it is your own machine-local file, and the recommended place for provider config. |
| `<projectRoot>/.kubic/models.json`, else `<projectRoot>/models.json` (project) | **Trust-gated** like the project `config.toml`: before it is trusted (`kubic trust`, the `kubic tui` prompt, or `KUBIC_TRUST_PROJECT=1`) it is never read, only named (`models.json ignored: <path> (project, untrusted — run 'kubic trust' or set KUBIC_TRUST_PROJECT=1 to load it)`), so a cloned repository cannot point a provider — and your key — at its own URL. |

The **project root** is the nearest directory at or above the working
directory that holds a `.git` entry (a repository or worktree top level) or
a `.kubic/` directory — never your home directory, whose `.kubic/` is the
global tree; with neither, the working directory itself. So `kubic run`,
`kubic models` and `kubic doctor` see the same providers from any
subdirectory.

A project provider overrides a global provider with the same id. Every
file is refused whole (never half-applied) and named when:

- it is invalid JSON or fails the schema;
- a provider id collides with a **built-in** provider (`anthropic`,
  `openai`, …) — a custom provider can never replace a built-in's URL or
  auth, trusted or not;
- `apiKeyEnv` — or an `apiKey` / header `$VAR` — names a variable outside
  the allowlist: a `KUBIC_*` name or a `*_API_KEY` name (`OPENROUTER_API_KEY`, `KUBIC_GATEWAY_TOKEN`). Anything
  else (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `HOME`) is refused, so a
  file can never choose an arbitrary secret to send as a bearer token.
  Without `apiKeyEnv` the key is read from `KUBIC_API_KEY`.

Which files were found and their trust state is reported: `kubic models`
and `kubic doctor` print a `loaded models.json: <path> (global|project,
trusted): <ids>` / `models.json ignored: <path> …` line on stderr, doctor's
`dep:models-json` check lists each file with `loaded`, `ignored, untrusted`
or `invalid` (an invalid file fails the check), `kubic run` prints a
`models.json ignored: …` line on stderr (the `loaded` receipt only under
`--debug`), and `kubic tui` lists the same line among its boot notices.

### models.json schema

The shape — `providers` is an object keyed by provider id (an array
of entries with their own `id` is accepted as an alias):

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "models": [
        { "id": "qwen3-coder-27b", "contextWindow": 131072, "maxTokens": 16384 }
      ]
    }
  }
}
```

| Provider key | Meaning |
| --- | --- |
| `baseUrl` | `http(s)` endpoint (required). A plain `http:` URL to a host other than this machine (`localhost`, `127.0.0.0/8` and `::1` are exempt), on a provider with a key or a secret header, sends that key in clear text: the load receipt says so (`models.json: provider '<id>' sends its API key over plain http to <host>`) and `kubic doctor` warns (`models-transport:<id>`). |
| `api` | `openai-completions` or `openai-responses` (required). |
| `apiKey` | A literal key (e.g. `not-needed` for a keyless local server), an allowlisted `$VAR` (same allowlist as `apiKeyEnv`), or a `!command` resolved per request. Escaped `\$` / `\!` stay literal. Not together with `apiKeyEnv`. |
| `apiKeyEnv` | The env variable holding the key (allowlist above; default `KUBIC_API_KEY`). |
| `name`, `headers` | Display name; per-request headers (non-empty strings). Literal values ride every request statically; `$VAR` (allowlisted) and `!command` values resolve per request through the key auth instead and never reach the wire verbatim. A gateway (LiteLLM, Portkey, Azure API Management) that routes or authorizes on a header of its own takes it here. |
| `tls` | Mutual TLS for a gateway that demands a client certificate: `{"cert": "/etc/kubic/client.pem", "key": "/etc/kubic/client.key", "ca": "/etc/kubic/gateway-ca.pem"}` — absolute PEM paths; `ca` (optional) is trusted beside the default roots for this provider. The provider's requests present the certificate; a file that cannot be read refuses the models.json by name. See [Corporate networks](enterprise.md#corporate-networks). |
| `models` | Non-empty list of models (ids unique per provider). |

| Model key | Meaning |
| --- | --- |
| `id`, `name`, `reasoning` | Model id (required), display name, reasoning support. |
| `contextWindow`, `maxTokens` | Positive integers; `maxTokens` must be **less than** `contextWindow`, judged on the effective values (defaults `8192`/`2048`), so `contextWindow: 1024` alone is refused too. A `0` or fractional value is refused with the field named. **Set `contextWindow` for every model.** Compaction and the context gauge use the window: a model that omits it runs as an 8192-token model, so a 128k model compacts far too early. `kubic models` marks such a model `(default — set contextWindow)` and `kubic doctor` warns on it (`models-window:<provider>/<model>`). |
| `cost` | `{input, output, cacheRead, cacheWrite}` in USD per 1M tokens; cache reads and writes are priced separately and reach `kubic models --json` as `cacheReadCost`/`cacheWriteCost`. The flat `inputCost`/`outputCost` keys still work — one place per field, never both. |
| `input` | Input modalities: a non-empty list from `text`, `image` (default `["text"]`). |
| `samplingParams`, `samplingParamsByThinkingLevel` | Extra request-body fields Pi assigns into the provider request verbatim (`temperature`, `top_p`, …). The by-level form is keyed by thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); at request time the effective level's object is merged over `samplingParams`. An unknown level or a non-object body is refused with the field named. Supported for the OpenAI-compatible APIs this file declares (`openai-completions`, `openai-responses`). |

## Proxies

Model requests honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (either
case). Node reads them only when it starts with its proxy support on, so when
one is set the `kubic` launcher runs the CLI in a child process that has it
(`NODE_USE_ENV_PROXY=1`): stdio, signals and the exit status pass through,
and Node 22's experimental-feature warning is silenced. A `NODE_USE_ENV_PROXY`
you set yourself is respected, `0` included; on a Node without
`--use-env-proxy` the variables are not read and model traffic goes direct.
List a local model server (`localhost`, `127.0.0.1`) in `NO_PROXY` so it is
not sent to the proxy. Tool processes get the proxy variables separately,
with any credentials stripped (see
[journal and safety](../architecture/journal-and-safety.md#tool-process-environment)).

## `kubic keys set|list|remove`

```sh
kubic keys set anthropic                                # typed without echo
printf %s "$GATEWAY_KEY" | kubic keys set KUBIC_GATEWAY_API_KEY
kubic keys list
kubic keys remove anthropic
```

`kubic keys` keeps provider keys in the operating system's keychain instead
of a shell profile: the macOS keychain, or the Secret Service (GNOME Keyring,
KWallet) through libsecret's `secret-tool` on Linux. A key is stored under the
variable it stands for — `kubic keys set anthropic` stores
`ANTHROPIC_API_KEY`; a models.json provider's variable is named directly —
and is typed without echo on a terminal or read from standard input
otherwise, never from the command line. Kubic records the variable names, not
the values, in `~/.kubic/keychain.json`, and whenever one of those variables
is not set, the model catalogue reads its key from the keychain: the provider
is usable with no environment variable, `kubic run` scrubs the key like any
other, and nothing prints it. A variable set in the environment wins, and
`kubic keys list` says so. On another system, or without `secret-tool`, the
command names what is missing and keys stay in the environment.

## Secrets (never in config)

Secrets never appear in config: a secret-shaped value or a secret ref in
`config.toml` is refused by name. What ships:

- **Provider keys from `models.json` are resolved at request time.** A
  provider's `apiKeyEnv` names the environment variable holding its key; that
  is a `$ENV_VAR` ref, resolved through the request-time resolver on **every**
  model request (never cached; a missing or empty variable leaves the provider
  unconfigured). The same holds for an `apiKey` written as an allowlisted
  `$VAR` — except a missing variable fails the request closed naming it —
  and for `$VAR` / `!command` header values, which resolve into the request's
  auth headers instead of reaching the wire verbatim. An `apiKey` written
  `\$literal` (or any other plain string) stays a literal key and never
  touches the resolver. Availability checks (`kubic models`, the provider
  probe) read presence only and are not a use.
- **A `!command` ref runs a helper on every request.** The command and its
  arguments are parsed quote-aware (`!op read "my vault/item"` stays one
  argument — a quote opens grouping only at a word boundary, so a mid-word
  quote like `don't` stays literal and the helper receives exactly what was
  written) and executed directly — never through a shell — with a 10s
  timeout and a 64 KiB output cap; an empty result, a failure, or a timeout
  fails the request closed naming the provider and command. The check path
  never executes it (an unknowable command counts as configured; a missing
  binary or a broken helper surfaces at the first request). Commands run
  only from trusted `models.json` files — an untrusted project file is
  refused before it is read.
- **Every use is audited.** Each resolution appends one record to the
  audit ledger (`.kubic/audit/audit.jsonl`, read by `kubic audit`):
  `what: credential:<provider>`, the ref as a sentinel
  (`sentinel:$GW_API_KEY`), the role, and the purpose
  (`model-request:<provider>`) — **never the value**.
- **The value never persists.** Resolved values are redacted from the
  `--debug` channel, and `kubic run` scrubs them from what the run leaves
  behind: the session JSONL is written through a redacting bridge, and the
  result (the `--json` envelope) and the trajectory's prompt are scrubbed
  — so a provider that echoes the key it rejected in its error body does not
  put it on disk or stdout (`[REDACTED]` in its place). A value is matched as
  text only from **8 characters**: a short or dummy key (`gw`, `ollama` for
  provider `ollama`) is not a secret worth blanking every word for, and it
  never causes its own credential-use row to be dropped. Likewise a key that
  is (or sits inside) one of the run's provider or model ids — LM Studio's
  documented dummy key is its provider's name, `lm-studio` — is identity, not
  a secret: it is never scrubbed out of the envelope or the session rows, and
  its credential-use row is still written (the row names only the ref). The one gap: a
  prompt that quotes the key is written to the session before the first
  request resolves it, so that line is scrubbed from the trajectory and the
  result but not from the session file. A trajectory export also redacts every
  secret-classified env key (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`,
  `*_CREDENTIALS`, and the Anthropic federation block below) to
  `<redacted>` with the same classifier the tool spawn env uses. `kubic tui` resolves and audits keys the same
  way and writes its session JSONL through the same redacting bridge.

**Anthropic workload identity federation is secret whole.**
`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
`ANTHROPIC_IDENTITY_TOKEN_FILE` and the optional
`ANTHROPIC_SERVICE_ACCOUNT_ID` / `ANTHROPIC_WORKSPACE_ID` match none of the
suffix shapes above — the token key is a FILE path and the ids end in `_ID` —
yet the block is the credential: the Anthropic SDK exchanges the file's
identity token for a short-lived access token and refreshes it itself. All
five are classified secret, so they are redacted from debug logs and from
trajectory exports like any `*_TOKEN`. The token file's *contents* never
pass through Kubic: Pi hands the SDK the path, and the SDK reads the file.
Anthropic counts as **configured** in `kubic models` and `kubic doctor` when
the three required variables are present (the two ids are optional), while an
API key or `ANTHROPIC_AUTH_TOKEN`, when set, wins as it does in Pi.
