# Contributing

`scaleset` is a public preview published to npm. Package publication is limited
to admin-created release tags through its trusted-publishing workflow. Never
add an npm access token, `.npmrc` credential, or registry credential to the
repository, a workflow, or a local fixture.

## Package boundaries

The root package is portable TypeScript: Fetch, Web Crypto, promises, and
`AbortSignal`. Node-specific filesystem, proxy, custom-CA, and mTLS helpers
belong only in `scaleset/node`.

This project implements the Actions Runner Scale Set protocol. It does not own
runner provisioning, Kubernetes resources, persistence, capacity policy, or
reconciliation. A future Actions Runner Controller (ARC) integration should be
a separate consumer-level control plane that depends on this public client API;
it owns Kubernetes CRDs and fleet lifecycle. Do not add ARC or Kubernetes
dependencies to this SDK merely to test an integration.

## Upstream compatibility changes

`actions-scaleset` is a submodule pinned to one reviewed commit, never
an automatically tracked branch. To adopt upstream behavior:

1. Fetch the upstream repository and move the submodule to an explicit commit.
2. Record the new commit in the README and `conformance/test-map.json`.
3. Run `pnpm conformance:map:sync`, then classify every new Go test and subtest
   in the map. A test may be a shared differential scenario, an equivalent
   Vitest test, or a documented intentional deferral.
4. Add or update deterministic Go-vs-TypeScript scenarios whenever observable
   request, response, authentication, error, retry, or session behavior
   changes.
5. Run `pnpm test`, `pnpm test:coverage`, and `pnpm test:go-reference` before
   merging. The final command runs the unmodified pinned Go suite; macOS uses
   the official Linux Go image for its Linux-specific TLS assertion.

Never silently adopt an upstream commit. The submodule SHA, mapped tests, and
any deliberate compatibility decision belong in the same change.

## Quality gates

Run `pnpm check` for the normal local gate. Vite+ formats, lints, and type
checks the project, then the command executes the single Vitest suite, enforces
the coverage floor, and verifies a clean packaged consumer install.
`pnpm audit:dependencies` checks production dependencies for high-severity
advisories. CI tests Node 24 and runs the same gate.

The live runner E2E suite is not a pull-request check. It runs only on `main`
pushes or manual dispatches. The workflow resolves the merged pull request
associated with the triggering commit: a current repository admin author uses
the unreviewed `e2e-admin` environment. A direct push or manual dispatch also
uses `e2e-admin` when GitHub reports that the authenticated triggering actor is
a current repository admin. Non-admin authors and actors, permission lookup
failures, and other unmatched cases fail closed to approval-gated `e2e`. Git
commit author metadata is never trusted for this decision. Its fine-grained
GitHub token and target settings must remain environment-scoped. Do not use
`pull_request_target`, pass those values to an untrusted pull request, or make
an E2E failure optional.

## Release policy

1. Update the version, `CHANGELOG.md`, API documentation, and compatibility
   notes in a reviewed change on `main`.
2. Wait for the Node 24 verification job to pass.
3. An administrator creates and pushes the exact `v<package-version>` tag from
   that `main` commit. The release-tag ruleset prevents other roles from
   creating, moving, or deleting `v*` tags.
4. The publish workflow repeats all quality gates, verifies that the tag
   matches the package version and points to a commit on `main`, then publishes
   with npm OIDC trusted publishing and provenance.
5. Verify the package page, provenance, tarball contents, and clean consumer
   install before announcing the release.

The npm trusted publisher must be configured once for `biw/scaleset` and
`.github/workflows/publish.yml`; it is the only publication authority. Rotate
or revoke an old npm automation token rather than adding it as a fallback.
