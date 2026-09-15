# TypeScript GitHub Actions Runner Scale Set Client

> Status: **Public preview** – this branch tracks
> [`actions/scaleset` main at `fb56300`](https://github.com/actions/scaleset/tree/fb56300503fd21caa788feeb85c63071d15155c6).
> It is an ESM-only package for Node.js 24+ and standards-compatible runtimes.

`scaleset` is a standalone TypeScript client for the GitHub Actions **Runner
Scale Set** APIs. It gives platform teams and infrastructure providers the
protocol primitives needed to build their own autoscaling solution: scale-set
and runner operations, just-in-time (JIT) runner configuration, message
sessions, and a listener state machine.

It does not provision runners, make fleet-capacity decisions, or require
Kubernetes. [Actions Runner Controller](https://github.com/actions/actions-runner-controller)
is a future consumer-level integration reference, not a second SDK
specification.

## What is a Scale Set?

A runner scale set is a group of self-hosted runners that autoscales with
workflow demand. At a high level:

1. Create a scale set with a name. Workflows target that name in `runs-on`.
2. Poll the message API while reporting the maximum number of runners your
   provider can create.
3. GitHub matches eligible jobs to the scale set according to its labels and
   runner-group policies.
4. The service reports the current desired capacity in
   `statistics.totalAssignedJobs`.
5. Your provider creates, maintains, or removes runners to meet that capacity.
6. GitHub assigns pending work to idle runners in the scale set.

Scale-set runners are normally ephemeral: a runner executes one job and is
then removed, giving each job a clean environment.

## High-Level Flow

1. Create a `ScaleSetClient` with GitHub App credentials (recommended), a PAT,
   or a custom token provider.
2. Look up a runner group and create a runner scale set.
3. Create a message session and pass it to `ScaleSetListener`.
4. In your scaler's `scale` handler, use the desired capacity to provision your
   processes, containers, VMs, or another runner implementation.
5. Generate a JIT configuration for each runner as needed, then start it.

The listener deliberately has no fleet-control-plane logic. Your callbacks own
capacity policy and runner lifecycle, so providers can support both
pre-provisioned capacity and just-in-time runners.

## Autoscaling

Use `statistics.totalAssignedJobs` from every response to decide how many
runners should be online. It includes both work waiting for a runner and work
already running (`totalAssignedJobs >= totalRunningJobs`).

Do not derive desired capacity from individual `JobAvailable`, `JobStarted`,
or `JobCompleted` messages:

- A response contains a bounded batch of messages, so a large backlog can be
  incomplete.
- The `statistics` payload is the current state of the scale set.

Report your scale set's maximum capacity with `maxRunners`. The listener passes
it to the message API as the `X-ScaleSetMaxCapacity` header, allowing GitHub to
avoid assigning more work than the provider can fulfill.

`JobStarted` and `JobCompleted` messages are still useful for provider state,
metrics, and safe runner cleanup. They are lifecycle signals, not the scaling
source of truth.

## How the Message API Works

### Long polling

`MessageSessionClient.getMessage()` uses long polling. It returns a message
immediately when one is available; otherwise, the service waits for up to about
50 seconds and returns `undefined` for an empty poll (`202 Accepted`). Poll
again immediately after every response.

`ScaleSetListener` preserves the observable behavior of the upstream Go
listener: it sends a synthetic initial message containing the session
statistics, passes every poll result to the scaler, tracks the latest message
cursor, and acknowledges a real message only after the scaler succeeds.

The scaler receives `undefined` after an empty poll. The listener does not cache
statistics, acquire available jobs, or interpret lifecycle messages. Cache the
last statistics yourself if you want to keep reconciling during idle polls, and
call `session.acquireJobs()` for every available job you want assigned.

### Message acknowledgment

`deleteMessage()` acknowledges a received message. `ScaleSetListener` calls it
only after `scale()` returns successfully. If `scale()` throws, the listener
stops without acknowledging the message so it can be redelivered. Handlers
should be idempotent because any partial work completed before an error can run
again.

### Message ID tracking

Pass the ID of the last processed message to `getMessage()`. Passing `0` (or
omitting a previous ID) reads the first available message and can cause
reprocessing.

### Durable and resumable polling

Use `ResumableScaleSetListener` when the process cannot keep its cursor and
latest statistics only in memory. Its checkpoint is JSON-serializable, each
`poll()` call performs at most one long poll, and a delivery is acknowledged
only when the caller explicitly asks for it.

```ts
import { ResumableScaleSetListener, type ScaleSetCheckpoint } from "scaleset";

const listener = new ResumableScaleSetListener(session);
let checkpoint: ScaleSetCheckpoint = (await loadCheckpoint()) ?? listener.initialCheckpoint();

const result = await listener.poll(checkpoint, { maxRunners: 10, signal });
if (result.kind === "idle") {
  await persistDesiredRunnerCount(result.desiredRunnerCount);
} else {
  // Persist demand and every JobAssigned/JobStarted/JobCompleted record before
  // acknowledging so a restart can safely replay partial work.
  await persistDelivery(result.desiredRunnerCount, result.message);

  const selected = result.message.jobAvailableMessages.map((job) => job.runnerRequestId);
  const acquired = await result.acquire(selected);
  await persistAcquiredAssignments(acquired);

  checkpoint = await result.acknowledge();
  await persistCheckpoint(checkpoint);
}
```

The durable sequence is:

1. Poll for one delivery.
2. Persist desired demand and assigned lifecycle records.
3. Select and acquire any subset of the available jobs.
4. Persist the request IDs GitHub actually acquired.
5. Acknowledge the delivery.
6. Persist the checkpoint returned by `acknowledge()`.

An empty poll returns the unchanged cursor and last authoritative statistics.
Desired capacity always comes from `statistics.totalAssignedJobs`, never from
the number of lifecycle records. If statistics are missing or invalid, polling
fails before acknowledgement and the saved checkpoint remains unchanged. All
persistence, retry, provisioning, and capacity policy remains the consumer's
responsibility.

### Job reassignment

A job can appear in multiple lifecycle messages, including a later
`JobCompleted` event with `result: "canceled"`, when it was assigned but not
acquired in time. These are message-history events; always use
`statistics.totalAssignedJobs` for current capacity.

## Getting Started

Install the published package:

```sh
pnpm add scaleset
```

Import the portable client from the package root:

```ts
import { personalAccessToken, ScaleSetClient, ScaleSetListener } from "scaleset";

const client = new ScaleSetClient({
  githubConfigUrl: "https://github.com/acme",
  credential: personalAccessToken(process.env.GITHUB_TOKEN!),
});

const group = await client.getRunnerGroupByName("default");
const scaleSet = await client.createRunnerScaleSet({
  name: "my-scale-set",
  runnerGroupId: group.id,
});

if (!scaleSet.id) throw new Error("scale set response did not include an ID");

// Reconcile pre-existing scale sets without doing a separate lookup per name.
const scaleSets = await client.listRunnerScaleSets(group.id);

const session = await client.createMessageSession(scaleSet.id, "provider-1");
const listener = new ScaleSetListener(session, {
  scaleSetId: scaleSet.id,
  maxRunners: 10,
});

await listener.run({
  async scale(message, { signal } = {}) {
    // An empty long poll has no new state. Cache statistics here if your
    // provider should continue reconciling during idle polls.
    if (!message) return;

    if (message.jobAvailableMessages.length > 0) {
      await session.acquireJobs(
        message.jobAvailableMessages.map((job) => job.runnerRequestId),
        { signal },
      );
    }
    for (const job of message.jobStartedMessages) {
      // Record that job.runnerName is busy.
    }
    for (const job of message.jobCompletedMessages) {
      // Record completion and safely clean up an ephemeral runner.
    }
    if (message.statistics) {
      const desired = message.statistics.totalAssignedJobs;
      // Create or remove runners until the provider reaches `desired`.
    }
  },
});
```

Node-specific filesystem, proxy, and custom-CA helpers are exported separately
from `scaleset/node`. `createNodeFetch()` exposes `close()` so callers can
release its proxy/TLS connection pool when their provider stops. The root export
uses Fetch, Web Crypto, promises, and `AbortSignal`, and is suitable for
standards-compatible runtimes.

### Node proxy, custom CA, and mTLS

Keep Node-only TLS and filesystem concerns out of portable provider code by
injecting a Node fetch implementation. For an enterprise network that requires
a proxy, custom trust root, or mutual TLS, load the PEM values from files or a
secret store and close the transport on shutdown:

```ts
import { createNodeFetch, readTlsClientCertificate } from "scaleset/node";

const fetch = createNodeFetch({
  proxyUrl: process.env.HTTPS_PROXY,
  ca: process.env.GHES_CA_PEM,
  ...(await readTlsClientCertificate("./client.crt", "./client.key")),
});
const client = new ScaleSetClient({
  githubConfigUrl: "https://github.example.com/acme",
  credential: personalAccessToken(process.env.GITHUB_TOKEN!),
  fetch,
});

try {
  // Use client.
} finally {
  await fetch.close();
}
```

Never use `rejectUnauthorized: false` outside an explicitly trusted development
environment, and never commit PEMs to a repository.

## Authentication

Use a GitHub App wherever possible. It scopes access more narrowly and supports
normal credential rotation. The client exchanges the supplied credential for
the GitHub registration and Actions-service tokens it needs, refreshing them
before expiry.

```ts
import { githubApp, githubAppJwtProvider, personalAccessToken, tokenProvider } from "scaleset";

const appCredential = githubApp({
  clientId: process.env.GITHUB_APP_CLIENT_ID!,
  installationId: Number(process.env.GITHUB_APP_INSTALLATION_ID),
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,
});

const patCredential = personalAccessToken(process.env.GITHUB_TOKEN!);

const externalCredential = tokenProvider({
  async getToken() {
    return process.env.GITHUB_TOKEN!; // Or fetch a short-lived token from your service.
  },
});

const kmsCredential = githubAppJwtProvider({
  installationId: Number(process.env.GITHUB_APP_INSTALLATION_ID),
  jwtProvider: {
    async getJwt(signal) {
      // Return an RS256 GitHub App JWT signed by your KMS/HSM integration.
      return signGitHubAppJwtWithKms({ signal });
    },
  },
});
```

GitHub App JWT signing uses Web Crypto and accepts both PKCS#8 (`PRIVATE KEY`)
and traditional PKCS#1 (`RSA PRIVATE KEY`) PEM files, matching the Go client.
`githubAppJwtProvider()` keeps raw private key material outside this process and
exchanges the provider's signed JWT for the installation access token. In
contrast, `tokenProvider()` supplies a GitHub token directly.
A PAT is simpler but normally has a broader security footprint; rotate it and
grant only the permissions required by your runner scope. See the [GitHub
authentication guidance](https://docs.github.com/en/actions/tutorials/use-actions-runner-controller/authenticate-to-the-api)
for required permissions.

### GitHub Enterprise Server

Pass your GHES base URL as `githubConfigUrl`; the client derives the matching
GitHub API paths. Availability of individual scale-set capabilities, such as
custom labels, depends on your GHES version and appliance configuration. Refer
to your GHES documentation before relying on those capabilities.

## Security Notes

- Prefer GitHub App credentials over PATs and never log credentials, message
  queue access tokens, or JIT configuration values.
- Use `githubAppJwtProvider()` when the App key must remain in a KMS or HSM.
- Treat JIT configurations as secrets until the runner consumes them.
- npm releases are published only by the protected, tag-triggered workflow with
  npm trusted publishing; no npm token is stored in this repository or its CI.
- See [SECURITY.md](./SECURITY.md) for private reporting and credential-handling
  guidance.

## Runtime requirement

- Node.js 24 or later
- Go 1.26.3 or later only when running the pinned Go reference or differential
  conformance suite (Docker is a local fallback for the upstream hierarchy on
  macOS)

## License

MIT
