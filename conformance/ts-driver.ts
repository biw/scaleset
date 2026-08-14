import { readFile } from "node:fs/promises";
import {
  isScaleSetError,
  personalAccessToken,
  ScaleSetClient,
  type FetchLike,
} from "../src/index.js";

export interface ResponseDefinition {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Scenario {
  name: string;
  operation: string;
  input?: Record<string, unknown>;
  actionsResponses?: ResponseDefinition[];
  queueResponses?: ResponseDefinition[];
}

export interface Transcript {
  requests: Array<{
    method: string;
    path: string;
    query: string;
    body: string;
    headers: Record<string, string>;
  }>;
  result?: unknown;
  error?: { code: string };
}

const adminToken = "eyJhbGciOiJub25lIn0.eyJleHAiOjE4OTM0NTYwMDB9.signature";

export async function execute(scenario: Scenario): Promise<Transcript> {
  const requests: Transcript["requests"] = [];
  let actionIndex = 0;
  let queueIndex = 0;
  let concurrentQueueArrivals = 0;
  let releaseConcurrentQueueBarrier: (() => void) | undefined;
  const concurrentQueueBarrier =
    scenario.operation === "getMessageConcurrentRefresh"
      ? new Promise<void>((resolve) => {
          releaseConcurrentQueueBarrier = resolve;
        })
      : undefined;
  const fetch: FetchLike = async (input) => {
    const request = new Request(input);
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams.toString(),
      body: canonicalBody(
        (await request.text()).replace("https://reference.invalid/acme", "<config-url>"),
      ),
      headers: selectedHeaders(request),
    });
    if (url.pathname.endsWith("/registration-token")) return json({ token: "registration" }, 201);
    if (url.pathname.endsWith("/actions/runner-registration")) {
      return json({ url: "https://actions.reference.invalid/tenant/", token: adminToken }, 201);
    }
    if (url.pathname.startsWith("/queue")) {
      const responseIndex = queueIndex++;
      const definition = next(scenario.queueResponses, responseIndex);
      if (concurrentQueueBarrier && responseIndex < 2) {
        concurrentQueueArrivals += 1;
        if (concurrentQueueArrivals === 2) releaseConcurrentQueueBarrier?.();
      }
      return response(definition);
    }
    if (
      concurrentQueueBarrier &&
      request.method === "PATCH" &&
      url.pathname.includes("/sessions/")
    ) {
      await concurrentQueueBarrier;
    }
    return response(
      next(scenario.actionsResponses, actionIndex++),
      "https://reference.invalid/queue",
    );
  };
  try {
    const client = new ScaleSetClient({
      githubConfigUrl: "https://reference.invalid/acme",
      credential:
        scenario.operation === "constructorValidation"
          ? ({ type: "personal-access-token", token: "" } as const)
          : personalAccessToken("reference-pat"),
      fetch,
      retry: { minDelayMs: 0, maxDelayMs: 0, random: () => 0 },
      sleep: async () => {},
      systemInfo: {
        system: "reference",
        version: "main@cb0405b",
        commitSha: "",
        scaleSetId: 0,
        subsystem: "conformance",
      },
    });
    const result = await run(client, scenario);
    return normalizeTranscript(
      scenario,
      result === undefined ? { requests } : { requests, result },
    );
  } catch (error) {
    return normalizeTranscript(scenario, { requests, error: { code: errorCode(error) } });
  }
}

async function run(client: ScaleSetClient, scenario: Scenario): Promise<unknown> {
  const input = scenario.input ?? {};
  const number = (name: string) => requireNumber(input[name], name);
  const text = (name: string) => requireString(input[name], name);
  switch (scenario.operation) {
    case "getRunner":
      return client.getRunner(number("id"));
    case "getRunnerByName":
      return client.getRunnerByName(text("name"));
    case "removeRunner":
      return client.removeRunner(number("id"));
    case "getRunnerGroupByName":
      return client.getRunnerGroupByName(text("name"));
    case "getRunnerScaleSet":
      return client.getRunnerScaleSet(number("runnerGroupId"), text("name"));
    case "listRunnerScaleSets":
      return client.listRunnerScaleSets(number("runnerGroupId"));
    case "getRunnerScaleSetByID":
      return client.getRunnerScaleSetById(number("id"));
    case "createRunnerScaleSet":
      return client.createRunnerScaleSet({ name: text("name") });
    case "updateRunnerScaleSet":
      return client.updateRunnerScaleSet(number("id"), { name: text("name") });
    case "deleteRunnerScaleSet":
      return client.deleteRunnerScaleSet(number("id"));
    case "generateJitRunnerConfig":
      return client.generateJitRunnerConfig(
        { name: text("name"), workFolder: text("workFolder") },
        number("scaleSetId"),
      );
    case "createMessageSession": {
      const session = await client.createMessageSession(number("scaleSetId"), text("owner"));
      return { sessionId: session.session.sessionId, ownerName: session.session.ownerName };
    }
    case "getMessage":
    case "getMessageRefresh": {
      const session = await client.createMessageSession(number("scaleSetId"), text("owner"));
      const message = await session.getMessage(number("lastMessageId"), number("maxCapacity"));
      if (!message) return undefined;
      return {
        messageId: message.messageId,
        jobAvailable: message.jobAvailableMessages.length,
        jobAssigned: message.jobAssignedMessages.length,
        jobStarted: message.jobStartedMessages.length,
        jobCompleted: message.jobCompletedMessages.length,
      };
    }
    case "getMessageConcurrentRefresh": {
      const session = await client.createMessageSession(number("scaleSetId"), text("owner"));
      const messages = await Promise.all([
        session.getMessage(number("lastMessageId"), number("maxCapacity")),
        session.getMessage(number("lastMessageId"), number("maxCapacity")),
      ]);
      return { emptyPolls: messages.filter((message) => message === undefined).length };
    }
    case "deleteMessage": {
      const session = await client.createMessageSession(number("scaleSetId"), text("owner"));
      return session.deleteMessage(number("messageId"));
    }
    case "acquireJobs": {
      const session = await client.createMessageSession(number("scaleSetId"), text("owner"));
      const requestIds = input.requestIds;
      if (!Array.isArray(requestIds) || !requestIds.every((id) => typeof id === "number"))
        throw new Error("requestIds must be a number array");
      return session.acquireJobs(requestIds);
    }
    default:
      throw new Error(`unsupported operation ${JSON.stringify(scenario.operation)}`);
  }
}

function next(responses: ResponseDefinition[] | undefined, index: number): ResponseDefinition {
  return responses?.[index] ?? { body: {} };
}

function response(definition: ResponseDefinition, queueUrl?: string): Response {
  const headers = new Headers(definition.headers);
  const body =
    definition.body === undefined
      ? undefined
      : JSON.stringify(definition.body).replaceAll("<queue-url>", queueUrl ?? "<queue-url>");
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { status: definition.status ?? 200, headers });
}

function json(value: unknown, status: number): Response {
  return response({ status, body: value });
}

function selectedHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "content-type", "accept", "x-scalesetmaxcapacity"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function canonicalBody(body: string): string {
  if (!body) return "";
  try {
    return JSON.stringify(sortJson(JSON.parse(body)));
  } catch {
    return body;
  }
}

function normalizeTranscript(scenario: Scenario, transcript: Transcript): Transcript {
  if (scenario.operation !== "getMessageConcurrentRefresh") return transcript;
  return {
    ...transcript,
    requests: [...transcript.requests].sort((left, right) =>
      requestTraceKey(left).localeCompare(requestTraceKey(right)),
    ),
  };
}

function requestTraceKey(trace: Transcript["requests"][number]): string {
  return JSON.stringify([
    trace.method,
    trace.path,
    trace.query,
    trace.body,
    Object.entries(trace.headers).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => [key, sortJson(field)]),
  );
}

function errorCode(error: unknown): string {
  for (const code of [
    "RUNNER_EXISTS",
    "RUNNER_NOT_FOUND",
    "JOB_STILL_RUNNING",
    "MESSAGE_QUEUE_TOKEN_EXPIRED",
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "NOT_FOUND",
    "CONFLICT",
    "VALIDATION",
  ] as const) {
    if (isScaleSetError(error, code)) return code;
  }
  return "REQUEST_FAILED";
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`${name} must be a number`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

if (import.meta.main) {
  const scenario = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Scenario;
  process.stdout.write(JSON.stringify(await execute(scenario)) + "\n");
}
