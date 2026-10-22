<img src="docs/assets/readme/banner.svg" width="100%" alt="Kubic. Agentic coding, in your control. Built for teams and enterprise.">

<img src="docs/assets/readme/facts.svg" width="100%" alt="MIT license. Node 22.19+. Any model. npm i -g kubic.">

**Kubic is Konic's open-source coding agent.** It runs in your terminal with the
model you choose, records every file change in a journal you can review and undo,
and asks before anything risky runs. Teams get managed policy, an audit ledger and
spend caps on top.
[![CI](https://github.com/konic-labs/kubic/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/konic-labs/kubic/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/kubic?color=ff004d&label=npm)](https://www.npmjs.com/package/kubic)

<img src="docs/assets/readme/session.svg" width="100%" alt="A Kubic session: asked to make slugify handle accents, the agent reads src/slug.js, edits it and runs the test; the diff panel shows the change, and /undo restores the file.">

## Why Kubic

<table>
  <tr>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-models.svg" width="24" height="24" alt=""><br>
      <b>Any model</b><br>
      Anthropic, OpenAI, Google, Bedrock, OpenRouter or your own endpoint.
    </dd></dl></td>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-journal.svg" width="24" height="24" alt=""><br>
      <b>Undo any turn</b><br>
      Every change is journaled; <code>/undo</code> works with or without git.
    </dd></dl></td>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-approvals.svg" width="24" height="24" alt=""><br>
      <b>Approvals</b><br>
      Risky actions ask first, in the TUI or through a broker.
    </dd></dl></td>
  </tr>
  <tr>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-sessions.svg" width="24" height="24" alt=""><br>
      <b>Sessions that branch</b><br>
      Durable sessions; <code>/tree</code> branches from any prompt.
    </dd></dl></td>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-sandbox.svg" width="24" height="24" alt=""><br>
      <b>A sandbox for bash</b><br>
      Opt in to Seatbelt or bubblewrap to confine commands.
    </dd></dl></td>
    <td width="33%" valign="top"><dl><dd><br>
      <img src="docs/assets/readme/icon-policy.svg" width="24" height="24" alt=""><br>
      <b>Built for teams</b><br>
      Managed policy, an audit ledger, spend caps and OIDC.
    </dd></dl></td>
  </tr>
</table>

## Install

Kubic needs Node 22.19 or later:

```bash
npm install -g kubic
export ANTHROPIC_API_KEY=...    # or OPENAI_API_KEY, GEMINI_API_KEY, ...
kubic                           # the first launch picks a default model
```

Describe a task, review the change with `Ctrl+O`, and type `/undo` to put a turn
back. `npx kubic` runs Kubic without installing it, and `KUBIC_PROVIDER=faux kubic`
opens the TUI without a key, on a built-in model that echoes your prompts.

[Getting started](docs/getting-started.md) walks through a first session, and
[Contributing](CONTRIBUTING.md) builds Kubic from source.

## Documentation

| Start here | Reference | Inside Kubic |
| --- | --- | --- |
| [Getting started](docs/getting-started.md) | [Commands](docs/cli/README.md) | [Architecture](docs/architecture/README.md) |
| [The TUI](docs/cli/tui.md) | [Configuration](docs/cli/configuration.md) | [Threat model](docs/architecture/threat-model.md) |
| [For teams](docs/cli/enterprise.md) | [TUI keys](docs/cli/tui-keys.md) | [Contributing](CONTRIBUTING.md) |

## License

MIT, © 2026 Konic Labs. Kubic runs on the [Pi](NOTICE.md) agent harness.

<img src="docs/assets/readme/footer.svg" width="100%" alt="Konic">
