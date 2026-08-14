export type ScaleSetErrorCode =
  | "RUNNER_NOT_FOUND"
  | "RUNNER_EXISTS"
  | "JOB_STILL_RUNNING"
  | "MESSAGE_QUEUE_TOKEN_EXPIRED"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REQUEST_FAILED"
  | "VALIDATION";

export type HttpStatusErrorCode = Extract<
  ScaleSetErrorCode,
  "BAD_REQUEST" | "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT"
>;

/** Base error emitted by this package. */
export class ScaleSetError extends Error {
  constructor(
    message: string,
    readonly code: ScaleSetErrorCode = "REQUEST_FAILED",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScaleSetError";
  }
}

/** A failed HTTP request with GitHub and Actions request metadata preserved. */
export class RequestError extends ScaleSetError {
  constructor(
    message: string,
    readonly request: { method: string; url: string },
    readonly status?: number,
    readonly activityId?: string,
    readonly githubRequestId?: string,
    options?: ErrorOptions & { code?: ScaleSetErrorCode; responseBody?: string },
  ) {
    super(message, options?.code ?? "REQUEST_FAILED", options);
    this.name = "RequestError";
    this.responseBody = options?.responseBody;
    this.httpStatusCode = httpStatusCode(status);
  }

  /** Unparsed service response body retained for actionable diagnostics. */
  readonly responseBody: string | undefined;
  /** A Go-compatible top-level HTTP error classification, when applicable. */
  readonly httpStatusCode: HttpStatusErrorCode | undefined;
}

export const runnerNotFoundError = (message = "runner not found") =>
  new ScaleSetError(message, "RUNNER_NOT_FOUND");
export const runnerExistsError = (message = "runner exists") =>
  new ScaleSetError(message, "RUNNER_EXISTS");
export const jobStillRunningError = (message = "job still running") =>
  new ScaleSetError(message, "JOB_STILL_RUNNING");
export const messageQueueTokenExpiredError = (message = "message queue token expired") =>
  new ScaleSetError(message, "MESSAGE_QUEUE_TOKEN_EXPIRED");
export const badRequestError = (message = "bad request") =>
  new ScaleSetError(message, "BAD_REQUEST");
export const unauthorizedError = (message = "unauthorized") =>
  new ScaleSetError(message, "UNAUTHORIZED");
export const notFoundError = (message = "not found") => new ScaleSetError(message, "NOT_FOUND");
export const conflictError = (message = "conflict") => new ScaleSetError(message, "CONFLICT");

export function isScaleSetError(error: unknown, code: ScaleSetErrorCode): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      current instanceof ScaleSetError &&
      (current.code === code ||
        (current instanceof RequestError && current.httpStatusCode === code))
    )
      return true;
    current = current.cause;
  }
  return false;
}

function httpStatusCode(status: number | undefined): HttpStatusErrorCode | undefined {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    default:
      return undefined;
  }
}

export async function requestError(
  request: Request,
  response: Response | undefined,
  cause: Error,
): Promise<RequestError> {
  if (!response) {
    return new RequestError(
      `request ${request.method} ${request.url} failed: ${cause.message}`,
      { method: request.method, url: request.url },
      undefined,
      undefined,
      undefined,
      { cause },
    );
  }

  const activityId = response.headers.get("ActivityId") ?? undefined;
  const githubRequestId = response.headers.get("X-GitHub-Request-Id") ?? undefined;
  const details = [
    `status=${JSON.stringify(`${response.status} ${response.statusText}`.trim())}`,
    activityId ? `activity_id=${JSON.stringify(activityId)}` : undefined,
    githubRequestId ? `github_request_id=${JSON.stringify(githubRequestId)}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const prefix = `request ${request.method} ${request.url} failed(${details})`;
  const body = await response.text();

  if (!body) {
    return new RequestError(
      `${prefix}: ${cause.message}: unknown error`,
      { method: request.method, url: request.url },
      response.status,
      activityId,
      githubRequestId,
      { cause, responseBody: body },
    );
  }

  if (cause instanceof ScaleSetError && cause.code !== "REQUEST_FAILED") {
    return new RequestError(
      `${prefix}: ${cause.message}: ${body}`,
      { method: request.method, url: request.url },
      response.status,
      activityId,
      githubRequestId,
      { cause, code: cause.code, responseBody: body },
    );
  }

  if (response.headers.get("content-type")?.includes("text/plain")) {
    return new RequestError(
      `${prefix}: ${cause.message}: ${body}`,
      { method: request.method, url: request.url },
      response.status,
      activityId,
      githubRequestId,
      { cause, responseBody: body },
    );
  }

  try {
    const value: unknown = JSON.parse(body);
    if (isRecord(value)) {
      const typeName = typeof value.typeName === "string" ? value.typeName : "";
      const message = typeof value.message === "string" ? value.message : body;
      if (typeName.includes("AgentExistsException"))
        return typedRequestError("RUNNER_EXISTS", message);
      if (typeName.includes("AgentNotFoundException"))
        return typedRequestError("RUNNER_NOT_FOUND", message);
      if (typeName.includes("JobStillRunningException"))
        return typedRequestError("JOB_STILL_RUNNING", message);
      return new RequestError(
        `${prefix}: ${cause.message}: ${typeName}: ${message}`,
        { method: request.method, url: request.url },
        response.status,
        activityId,
        githubRequestId,
        { cause, responseBody: body },
      );
    }
  } catch {
    // The raw response is retained below when the service did not return Actions JSON.
  }

  return new RequestError(
    `${prefix}: ${cause.message}: failed to parse error response body: ${JSON.stringify(body)}`,
    { method: request.method, url: request.url },
    response.status,
    activityId,
    githubRequestId,
    { cause, responseBody: body },
  );

  function typedRequestError(code: ScaleSetErrorCode, message: string): RequestError {
    return new RequestError(
      `${prefix}: ${message}`,
      { method: request.method, url: request.url },
      response!.status,
      activityId,
      githubRequestId,
      { cause, code, responseBody: body },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
