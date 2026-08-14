# Security Policy

This is a public repository and npm package. Security fixes must not weaken the
protected E2E or npm release boundaries.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository, or contact a
repository administrator through an established private channel.
Include the affected version or commit, impact, reproduction steps, and any
safe mitigation. Do not include real access tokens, GitHub App private keys,
queue access tokens, JIT configuration, certificates, or other credentials in
an issue, pull request, test fixture, log, or advisory.

## Credential handling

- Prefer narrowly scoped GitHub App credentials to personal access tokens.
- Store credentials in the platform secret store or CI secrets, never in source
  control or package configuration.
- Keep the live E2E GitHub token in both `e2e` and `e2e-admin`, never in a
  repository secret. Both environments are restricted to protected `main`;
  only the latter omits a reviewer when the triggering commit is associated
  with a pull request by a current repository admin. Do not expose either to
  pull-request workflows.
- npm publishing uses GitHub Actions OIDC trusted publishing. Do not create or
  add a long-lived npm token as a workflow fallback.
- Treat runner JIT configuration, message queue tokens, client certificate
  material, and custom CA material as sensitive.
- Rotate a credential if it appears in output, history, or an unintended
  location; remove the exposed value and follow the host platform's incident
  process.
