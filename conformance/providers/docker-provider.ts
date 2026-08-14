/**
 * A minimal private E2E provider. It intentionally owns Docker fleet behavior
 * here rather than in the library; the package itself remains provider-neutral.
 */
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  personalAccessToken,
  ScaleSetClient,
  ScaleSetListener,
  type JobCompleted,
  type JobStarted,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort(new Error("provider interrupted")));
process.once("SIGTERM", () => shutdown.abort(new Error("provider terminated")));

const config = {
  githubConfigUrl: required("E2E_SCALESET_URL"),
  name: required("E2E_SCALESET_NAME"),
  token: required("E2E_SCALESET_GITHUB_TOKEN"),
  runnerGroup: process.env.E2E_SCALESET_RUNNER_GROUP || "default",
  minRunners: nonNegative("E2E_SCALESET_MIN_RUNNERS", 0),
  maxRunners: nonNegative("E2E_SCALESET_MAX_RUNNERS", 1),
  runnerImage: process.env.E2E_RUNNER_IMAGE || "ghcr.io/actions/actions-runner:latest",
};

if (config.maxRunners < config.minRunners)
  throw new Error("E2E_SCALESET_MAX_RUNNERS must be at least E2E_SCALESET_MIN_RUNNERS");

const client = new ScaleSetClient({
  githubConfigUrl: config.githubConfigUrl,
  credential: personalAccessToken(config.token),
  systemInfo: {
    system: "scaleset-typescript-e2e",
    version: "0.1.0",
    commitSha: process.env.GITHUB_SHA ?? "local",
    scaleSetId: 0,
    subsystem: "docker-provider",
  },
  logger: { info: log, debug: log, warn: log, error: log },
});

let scaleSetId: number | undefined;
let session: Awaited<ReturnType<typeof client.createMessageSession>> | undefined;
const runners = new Map<string, { id: string; state: "idle" | "busy" }>();

try {
  await docker(["pull", config.runnerImage]);
  const runnerGroupId =
    config.runnerGroup === "default"
      ? 1
      : (await client.getRunnerGroupByName(config.runnerGroup)).id;
  const scaleSet = await client.createRunnerScaleSet({
    name: config.name,
    runnerGroupId,
    runnerSetting: { disableUpdate: true },
  });
  if (!scaleSet.id) throw new Error("scale set response did not include an ID");
  scaleSetId = scaleSet.id;
  client.setSystemInfo({
    system: "scaleset-typescript-e2e",
    version: "0.1.0",
    commitSha: process.env.GITHUB_SHA ?? "local",
    scaleSetId,
    subsystem: "docker-provider",
  });

  session = await client.createMessageSession(scaleSetId, hostname());
  const listener = new ScaleSetListener(session, {
    scaleSetId,
    maxRunners: config.maxRunners,
    logger: { info: log, debug: log, warn: log, error: log },
  });
  console.log("SCALESET_TYPESCRIPT_PROVIDER_READY");
  await listener.run(
    {
      handleDesiredRunnerCount: scaleTo,
      handleJobStarted,
      handleJobCompleted,
    },
    shutdown.signal,
  );
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
} finally {
  await Promise.allSettled([...runners.values()].map(({ id }) => docker(["rm", "--force", id])));
  if (session) await session.close().catch(logError);
  if (scaleSetId) await client.deleteRunnerScaleSet(scaleSetId).catch(logError);
}

async function scaleTo(assignedJobs: number): Promise<number> {
  const target = Math.min(config.maxRunners, config.minRunners + assignedJobs);
  while (runners.size < target) await startRunner();
  return runners.size;
}

function handleJobStarted(job: JobStarted): void {
  const runner = runners.get(job.runnerName);
  if (runner) runner.state = "busy";
}

async function handleJobCompleted(job: JobCompleted): Promise<void> {
  const runner = runners.get(job.runnerName);
  if (!runner) return;
  runners.delete(job.runnerName);
  await docker(["rm", "--force", runner.id]);
}

async function startRunner(): Promise<void> {
  if (!scaleSetId) throw new Error("scale set is not initialized");
  const name = `scaleset-ts-${randomUUID().slice(0, 8)}`;
  const jit = await client.generateJitRunnerConfig({ name, workFolder: "_work" }, scaleSetId);
  const { stdout } = await docker([
    "create",
    "--name",
    name,
    "--user",
    "runner",
    "--env",
    `ACTIONS_RUNNER_INPUT_JITCONFIG=${jit.encodedJITConfig}`,
    config.runnerImage,
    "/home/runner/run.sh",
  ]);
  const id = stdout.trim();
  await docker(["start", id]);
  runners.set(name, { id, state: "idle" });
}

async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonNegative(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function log(message: string, attributes?: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...attributes }));
}

function logError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
}
