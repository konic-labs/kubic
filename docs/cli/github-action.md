# The GitHub Action

> Run Kubic in a GitHub workflow and post its result on the pull request.

The repository's `action.yml` runs Kubic in a workflow: it installs Kubic,
runs `kubic run --json` on a pull request and posts the result as a comment.

```yaml
# .github/workflows/kubic-review.yml
name: Kubic review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the review reads the diff against the base branch
      - uses: konic-labs/kubic@main
        with:
          model: anthropic/claude-sonnet-5-5
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Modes

- **`review`** (the default) reads the pull request's diff against its base
  branch (`git diff origin/<base>...HEAD`, so the checkout needs the base:
  `fetch-depth: 0`) and the files it touches, and comments the findings with
  file and line. It runs as the built-in `reviewer` role: no write, edit or
  git tool, and a read-only shell. `prompt` adds instructions.
- **`task`** runs `prompt`. It is read-only too unless `allow-edits: true`;
  with `allow-edits: true` and `push: true`, a run that completes commits its
  changes and pushes them to the pull request branch — never for a pull
  request from a fork.

The action never writes to the repository unless `allow-edits` and `push`
both say so. A challenged call in CI is refused like in any `kubic run`
without a terminal, unless an [approval broker or a pre-approval
file](enterprise.md#headless-approvals) answers it.

## Inputs and outputs

| Input | Meaning |
| --- | --- |
| `mode` | `review` (default) or `task`. |
| `prompt` | The task, or extra review instructions. |
| `base` | The branch a review compares against (default the pull request's base branch). |
| `model` | `provider/id` (default the configured model). |
| `max-turns` | The run's turn bound (default 40). |
| `allow-edits` | `true` lets a task edit the checkout. |
| `push` | `true` (with `allow-edits`) pushes a task's changes to the pull request branch. |
| `comment` | `false` skips the pull request comment. |
| `kubic-version` | The npm version to install (default `latest`). |
| `github-token` | The token the comment and a push use (default the workflow's). |

Outputs: `status` (the run's status), `exit-code` and `summary` (the final
answer). The step summary carries the same report as the comment, and the
step fails when `kubic run` does, with its exit code
([the exit codes](run.md)). Provider keys come from the job's secrets, or
from OIDC with no stored key (see
[Keys and workload identity](enterprise.md#keys-and-workload-identity)).

## See also

- [`kubic run`](run.md): the command the action runs.
- [For teams](enterprise.md#headless-approvals): approvals in CI.
