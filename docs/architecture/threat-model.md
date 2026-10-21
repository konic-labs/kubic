# Threat model

What Kubic defends, against whom, with what — and what it does not. It builds
on the [in-process runtime](in-process.md) (one process, the user's
authority, no isolation by default) and the
[change journal and safety model](journal-and-safety.md).

## Assets

- **The user's files**: the workspace and everything the user's account can
  reach.
- **Credentials**: provider keys, cloud credentials, SSH keys, tokens in the
  environment or on disk.
- **The network position** of the machine running Kubic.
- **The record**: the change journal, the session transcripts and the audit
  ledger an organization relies on.

## Trust boundaries

| Source | Trusted? | Why |
| --- | --- | --- |
| The user at the terminal, and the user's own config | Yes | The run acts with their authority. |
| The organization's managed config | Yes, above the user | It may freeze keys, sign its policy and set the strictest values. |
| A repository's `.kubic/` (config, models.json, roles, skills, AGENTS.md, suites) | Only after `kubic trust` | A grant covers the files as they were; a change asks again. |
| Model output | Never | It is data that proposes actions; every action passes the approval pipeline. |
| Tool output, file contents, web content, MCP results | Never | Untrusted data that may carry prompt injection. |
| Providers, gateways, MCP servers, collectors | As far as their configuration | Reached over TLS; an MCP server or a provider sees what it is sent. |

## Adversaries and what stands in their way

**A manipulated or mistaken model** (prompt injection in a file, a web page,
a tool result). The approval pipeline challenges destructive, network,
credential, install, deploy, git-push, outside-write and privilege commands
and Kubic's own control plane; in a run without a terminal a challenged call
is refused unless a broker, a pre-approval file or `autoApprove` answers it.
The change journal records every write and `kubic undo` reverts it. Admin
hooks can refuse calls by the organization's own rules. With `[sandbox]`, the
bash tool's commands cannot write outside the workspace, open connections
(local sockets included) or read the credential paths and the macOS
keychain, beyond what an approved call was approved for.
With the egress proxy, they reach only the allowed domains.

**A malicious repository**. Its configuration, model providers, roles,
skills, instructions and eval suites load only after `kubic trust`, and a
change to them asks again. A trusted project still cannot declare admin
hooks, MCP servers, an approval broker, a pre-approval key, OIDC targets,
provider regions or sandbox paths, and under `project_policy = "restricted"`
it cannot widen approvals or permissions.

**A user evading the organization's policy**. Enterprise keys are frozen;
spend caps and the sandbox mode take the strictest value any layer sets; a
managed policy can be signed so a replaced file is refused; the audit ledger
is hash-chained and verifiable, and delivered to collectors through a spool.

**Secret exfiltration**. Provider keys never reach tool processes (the tool
environment drops secret-shaped variables); live keys are scrubbed from what
a run stores and prints; `data_policy = "redact"` scans sessions, and
`"redact-model"` tool output before the model reads it.

## Out of scope — stated plainly

- **Isolation of the run.** Kubic runs with the user's authority; the
  sandbox confines the bash tool's commands only, and the file tools rely on
  lexical confinement and approvals.
- **Prompt-injection prevention.** Injected instructions can reach the model;
  the defences above limit what they can make Kubic do.
- **A compromised machine or account**, a malicious Node.js runtime or a
  malicious dependency of Kubic itself.
- **What a provider, gateway or MCP server does** with what it is sent.
- **Lexical detection is not complete**: obfuscated commands can slip past
  the detectors (the [approvals page](../cli/approvals.md) lists the stated
  misses); the sandbox and the egress proxy are the controls that do not
  depend on reading the command.
