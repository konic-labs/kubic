# Contributing to Kubic

Thanks for helping. Kubic is Konic's open-source terminal coding agent: a
model-agnostic agent built on the Pi agent harness, with a change journal that
makes every edit reviewable and reversible. This page is the short version. The
full workflow and every CI gate are in [docs/contributing.md](docs/contributing.md).

## Set up

Users install Kubic with `npm install -g kubic`. To work on Kubic itself,
build it from a clone. Node 22.19 or newer and git are required: the test
suite runs real git commands.

```sh
git clone https://github.com/konic-labs/kubic.git
cd kubic
npm ci
npm run build
./bin/kubic.js --version
npm link        # optional: `kubic` on your PATH runs this build
```

## Before you open a pull request

Run what CI's test job runs, in this order:

```sh
npm run check                         # every static gate
npm test                              # the test suite
npm run build && npm run test:binary  # the built binary
```

[docs/contributing.md](docs/contributing.md#before-you-push) lists the gates
`npm run check` runs and why each repo script exists.

A change that alters behaviour ships its documentation page in the same commit.

## Tests

- Write the failing test first, watch it fail, then write the code.
- Tests never need network access or paid tokens. Agent tests use the `faux` provider.
- Every test removes the temporary directories, environment changes and child
  processes it creates.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, written in the imperative, in lower case, with no
trailing period. For example: `fix(journal): judge a blob's freshness in whole milliseconds`.
Common types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore` and `build`.
A breaking change uses `type(scope)!:` and a `BREAKING CHANGE:` footer.

A pull request's title is a Conventional Commits subject too: a squash merge
makes it the commit's subject, and the pull request's description its body.

## Docs style

Write in the present tense and describe what the code does now. Do not narrate
history: avoid "previously", "used to", "was removed", "after the pivot" and review
rounds. Keep tracker references out of code, comments, tests and docs: no issue
numbers, no design-document section numbers, and no epic or wave names. When
behaviour changes, document the new behaviour; the commit history already records
the change. The full guide (terms, key notation, tables, screenshots) is
[docs style](docs/contributing.md#docs-style).

## Pull requests

- One concern per pull request: a fix, a feature or a refactor, not several.
- The title is a Conventional Commits subject (see [Commits](#commits)).
- The tests and the docs change in the same pull request as the code, and
  the checks above pass.

## Reporting bugs and asking for features

Open an issue in this repository. Report a security vulnerability privately,
as [SECURITY.md](SECURITY.md) describes, never in an issue.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Kubic is released under the MIT License (see [LICENSE](LICENSE)). By opening
a pull request, you license your contribution under the same MIT License, as
[GitHub's terms of
service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
provide. No contributor licence agreement or sign-off is required.
