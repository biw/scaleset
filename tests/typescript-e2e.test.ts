import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";

const runScaleSetE2e = process.env.RUN_SCALESET_E2E === "true";
const readyMarker = "SCALESET_TYPESCRIPT_PROVIDER_READY";

describe("TypeScript Docker provider E2E", () => {
  it.runIf(runScaleSetE2e)(
    "creates runners and completes a workflow through the TypeScript client",
    async () => {
      const originalName = required("E2E_SCALESET_NAME");
      const scaleSetName = `${originalName}-ts`;
      const environment = { ...process.env, E2E_SCALESET_NAME: scaleSetName };
      const provider = spawn(
        resolve(process.cwd(), "node_modules/.bin/tsx"),
        ["conformance/providers/docker-provider.ts"],
        {
          cwd: process.cwd(),
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const append = (chunk: Buffer) => {
        output += chunk.toString();
      };
      provider.stdout.on("data", append);
      provider.stderr.on("data", append);

      try {
        await waitFor(
          () => {
            if (provider.exitCode !== null)
              throw new Error(`TypeScript provider exited before readiness:\n${output}`);
            return output.includes(readyMarker);
          },
          5 * 60_000,
          () => output,
        );
        const runId = await dispatchWorkflow(scaleSetName);
        const run = await waitForWorkflow(runId);
        expect(run).toMatchObject({ status: "completed", conclusion: "success" });
      } finally {
        if (provider.exitCode === null) {
          const exited = once(provider, "exit").then(() => true);
          provider.kill("SIGINT");
          const stopped = await Promise.race([exited, delay(30_000).then(() => false)]);
          if (!stopped) {
            provider.kill("SIGKILL");
            await exited;
          }
        }
      }
    },
    14 * 60_000,
  );
});

async function dispatchWorkflow(scaleSetName: string): Promise<number> {
  const org = required("E2E_WORKFLOW_TARGET_ORG");
  const repo = required("E2E_WORKFLOW_TARGET_REPO");
  const file = required("E2E_WORKFLOW_TARGET_FILE");
  const createdAfter = new Date().toISOString();
  const response = await github(
    `/repos/${org}/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: "main", inputs: { scaleset_name: scaleSetName } }),
    },
  );
  if (response.status !== 204)
    throw new Error(`workflow dispatch failed: ${await response.text()}`);

  const run = await waitFor(
    async () => {
      const list = await github(
        `/repos/${org}/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?event=workflow_dispatch&created=>=${encodeURIComponent(createdAfter)}&per_page=10`,
      );
      if (!list.ok) throw new Error(`workflow list failed: ${await list.text()}`);
      const value = (await list.json()) as { workflow_runs?: Array<{ id: number }> };
      return value.workflow_runs?.[0];
    },
    90_000,
    () => "workflow run was not created",
  );
  return run.id;
}

async function waitForWorkflow(runId: number): Promise<{ status: string; conclusion: string }> {
  const org = required("E2E_WORKFLOW_TARGET_ORG");
  const repo = required("E2E_WORKFLOW_TARGET_REPO");
  return waitFor(
    async () => {
      const response = await github(`/repos/${org}/${repo}/actions/runs/${runId}`);
      if (!response.ok) throw new Error(`workflow status failed: ${await response.text()}`);
      const value = (await response.json()) as { status: string; conclusion: string | null };
      return value.status === "completed" && value.conclusion
        ? { status: value.status, conclusion: value.conclusion }
        : undefined;
    },
    10 * 60_000,
    () => `workflow ${runId} did not complete`,
  );
}

async function github(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${required("E2E_WORKFLOW_GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);

  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers,
  });
}

async function waitFor<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  detail: () => string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await operation();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${detail()}`);
    await delay(2_000);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
