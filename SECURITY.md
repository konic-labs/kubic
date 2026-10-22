# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub's
[private vulnerability reporting](https://github.com/konic-labs/kubic/security/advisories/new)
for this repository: open the **Security** tab and choose **Report a
vulnerability**. Never report one in a public issue, pull request or
discussion.

A useful report names the Kubic version (`kubic --version`), the operating
system and Node version, the configuration involved, and the steps that show
the problem.

## What happens next

- A maintainer acknowledges the report in the private advisory and works on
  it with you there.
- The fix ships in a new release, together with a GitHub security advisory
  that names the affected versions and the fixed one.
- The advisory credits you, unless you ask to stay anonymous.

Please give us the time to release a fix before you disclose the
vulnerability publicly.

## Supported versions

Fixes, security fixes included, land in the newest release; older releases
are not patched. Update with `npm install -g kubic@latest`. The
[support policy](docs/support-policy.md) has the details.

## The security model in short

Kubic runs one agent in your directory, in-process, with your own authority
over files, network and credentials. It has no isolation and does not prevent
prompt injection: anything the agent can reach, a mistaken or manipulated
instruction can reach too. Its controls are the approvals that stop a risky
tool call before it runs, and the change journal that records every change so
you can review and undo it. A report that Kubic can do what your own account
can do is expected behaviour, not a vulnerability. A way past an approval, a
change the journal misses, or a leak of a credential is one.

- [In-process runtime](docs/architecture/in-process.md): what runs with your
  authority, and the controls Kubic has instead of isolation.
- [Change journal and safety](docs/architecture/journal-and-safety.md): what
  the journal records and how undo works.
- [Threat model](docs/architecture/threat-model.md): what Kubic defends,
  against whom, and what it does not.
