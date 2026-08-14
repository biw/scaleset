/** The API header used when reporting scale-set capacity while long polling. */
export const HEADER_SCALE_SET_MAX_CAPACITY = "X-ScaleSetMaxCapacity";
export const DEFAULT_RUNNER_GROUP = "default";

export type MessageType = "JobAvailable" | "JobAssigned" | "JobStarted" | "JobCompleted";

export interface SystemInfo {
  system: string;
  version: string;
  commitSha: string;
  scaleSetId: number;
  subsystem: string;
}

export interface Label {
  type?: string;
  name: string;
}

export interface RunnerSetting {
  disableUpdate?: boolean;
}

export interface RunnerScaleSetStatistic {
  totalAvailableJobs: number;
  totalAcquiredJobs: number;
  totalAssignedJobs: number;
  totalRunningJobs: number;
  totalRegisteredRunners: number;
  totalBusyRunners: number;
  totalIdleRunners: number;
}

export interface RunnerScaleSet {
  id?: number;
  name?: string;
  runnerGroupId?: number;
  runnerGroupName?: string;
  labels?: Label[];
  runnerSetting?: RunnerSetting;
  createdOn?: string;
  runnerJitConfigUrl?: string;
  statistics?: RunnerScaleSetStatistic;
}

export interface RunnerGroup {
  id: number;
  name: string;
  size: number;
  isDefaultGroup: boolean;
}

export interface RunnerGroupList {
  count: number;
  value: RunnerGroup[];
}

export interface RunnerReference {
  id: number;
  name: string;
  runnerScaleSetId?: number;
}

export interface RunnerReferenceList {
  count: number;
  value: RunnerReference[];
}

export interface RunnerScaleSetJitRunnerSetting {
  name: string;
  workFolder: string;
}

export interface RunnerScaleSetJitRunnerConfig {
  runner?: RunnerReference;
  encodedJITConfig: string;
}

export interface RunnerScaleSetSession {
  sessionId?: string;
  ownerName?: string;
  runnerScaleSet?: RunnerScaleSet;
  messageQueueUrl?: string;
  messageQueueAccessToken?: string;
  statistics?: RunnerScaleSetStatistic;
}

export interface JobMessageBase {
  messageType: MessageType;
  runnerRequestId: number;
  repositoryName: string;
  ownerName: string;
  jobId: string;
  jobWorkflowRef: string;
  jobDisplayName: string;
  workflowRunId: number;
  eventName: string;
  requestLabels: string[];
  queueTime: string;
  scaleSetAssignTime: string;
  runnerAssignTime: string;
  finishTime: string;
}

export interface JobAvailable extends JobMessageBase {
  messageType: "JobAvailable";
  acquireJobUrl: string;
}

export interface JobAssigned extends JobMessageBase {
  messageType: "JobAssigned";
}

export interface JobStarted extends JobMessageBase {
  messageType: "JobStarted";
  runnerId: number;
  runnerName: string;
}

export interface JobCompleted extends JobMessageBase {
  messageType: "JobCompleted";
  result: string;
  runnerId: number;
  runnerName: string;
}

export interface RunnerScaleSetMessage {
  messageId: number;
  statistics?: RunnerScaleSetStatistic;
  jobAvailableMessages: JobAvailable[];
  jobAssignedMessages: JobAssigned[];
  jobStartedMessages: JobStarted[];
  jobCompletedMessages: JobCompleted[];
}

export interface Logger {
  debug?(message: string, attributes?: Record<string, unknown>): void;
  info?(message: string, attributes?: Record<string, unknown>): void;
  warn?(message: string, attributes?: Record<string, unknown>): void;
  error?(message: string, attributes?: Record<string, unknown>): void;
}

export interface RetryOptions {
  /** Number of retries after the initial attempt. Matches the Go client's default of four. */
  maxRetries?: number;
  /** Maximum delay between attempts. Defaults to 30 seconds. */
  maxDelayMs?: number;
  /** Initial retry delay. Defaults to one second, matching retryablehttp. */
  minDelayMs?: number;
  /** Optional deterministic random source used for retry jitter. */
  random?: () => number;
}

export interface TransportInfo {
  hasProxy?: boolean;
  hasRootCA?: boolean;
}

/**
 * Fetch can be supplied by any standards-compatible runtime. Node helpers add
 * optional diagnostic metadata and a close method without affecting portable
 * consumers.
 */
export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly scalesetTransportInfo?: TransportInfo;
}

/** Injectable wall clock for deterministic token/JWT behavior. */
export type Clock = () => Date;

export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
}
