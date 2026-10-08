# Contributing to Kubic

Thanks for helping. Kubic is Konic's open-source terminal coding agent: a
model-agnostic agent built on the Pi agent harness, with a change journal that
makes every edit reviewable and reversible. This page is the short version. The
full workflow and every CI gate are in [docs/contributing.md](docs/contributing.md).

## Set up

Node 22.19 or newer and git are required: the test suite runs real git commands.

```sh
npm ci
npm run build
./bin/kubic.js --version
```

## Before you open a pull request

Run the checks that CI's test job runs, in this order (the mutation jobs are
switched off in `.github/workflows/ci.yml`):

```sh
npm run typecheck
npm run lint
npm run lint:deps
npm run lint:dead
npm run lint:dead:prod
npm run check:pi
npm run docs:check
npm test
npm run test:unit
npm run build
npm run test:binary-contract
```

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

## Docs style

Write in the present tense and describe what the code does now. Do not narrate
history: avoid "previously", "used to", "was removed", "after the pivot" and review
rounds. Keep tracker references out of code, comments, tests and docs: no issue
numbers, no design-document section numbers, and no epic or wave names. When
behaviour changes, document the new behaviour; the commit history already records
the change.

## Reporting bugs and asking for features

Open an issue in this repository.

## License

Kubic is released under the MIT License (see [LICENSE](LICENSE)).
