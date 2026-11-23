import type { ModelSelection, WorkflowQuestion, WorkflowRun } from "@t3tools/contracts";

// The fork's update settings live in a JSON block of the installed workflow file, so the settings
// page edits them through the workflow definition API. Keep in sync with fork/cli.ts (CONFIG_BLOCK).
export const FORK_WORKFLOW_FILE = "fork-sync.ts";
const FORK_UPDATE_WORKFLOW = "fork-update";
const FORK_INSTALL_WORKFLOW = "fork-install";

const CONFIG_BLOCK =
  /(\/\/ fork-config:begin[^\n]*\nconst FORK_CONFIG = )([\s\S]*?);\n(\/\/ fork-config:end)/;

export interface ForkConfig {
  readonly cadenceHours: number;
  readonly minNightlyAgeHours: number;
  readonly pinTag: string | null;
  readonly skipTags: ReadonlyArray<string>;
  readonly autoInstall: boolean;
  /** Passed to the workflow's agents as their `model`, options (effort) included. */
  readonly models: {
    readonly resolve: ModelSelection;
    readonly escalate: ModelSelection;
    readonly review?: ModelSelection;
  };
  /** Have models.review check every finished rebase before it is published. */
  readonly reviewMerges?: boolean;
  readonly requestedAt: string | null;
  /** The environment that merges; null means the machine with the desktop app. */
  readonly mergeEnvironmentId: string | null;
}

export const CADENCE_PRESETS = [6, 12, 24, 48, 168] as const;
export const NIGHTLY_AGE_PRESETS = [0, 3, 6, 12, 24] as const;

export function readForkConfig(source: string): ForkConfig | null {
  const block = CONFIG_BLOCK.exec(source);
  if (!block?.[2]) return null;
  try {
    return JSON.parse(block[2]) as ForkConfig;
  } catch {
    return null;
  }
}

/** Replaces only the block, keeping every other key the engine stores (repo, node, app). */
export function writeForkConfig(source: string, patch: Partial<ForkConfig>): string {
  const current = CONFIG_BLOCK.exec(source)?.[2];
  const next = { ...(current ? (JSON.parse(current) as object) : {}), ...patch };
  return source.replace(
    CONFIG_BLOCK,
    (_match, head: string, _body: string, tail: string) =>
      `${head}${JSON.stringify(next, null, 2)};\n${tail}`,
  );
}

export function parseTagList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

// Hourly-ish ticks that found nothing to do; they would bury the last real check.
const IDLE_DETAILS = new Set(["not due", "another fork update is running"]);

/** The newest fork update run that did something, or found it was up to date. */
export function latestForkRun(runs: ReadonlyArray<WorkflowRun>): WorkflowRun | null {
  let latest: WorkflowRun | null = null;
  for (const run of runs) {
    if (run.workflow !== FORK_UPDATE_WORKFLOW) continue;
    if (run.status === "skipped" && IDLE_DETAILS.has(run.detail ?? "")) continue;
    if (!latest || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}

export interface PendingInstall {
  readonly runId: string;
  readonly name: string;
  readonly version: string | null;
}

/** The fork release waiting on "install?" on this machine, if any. */
export function pendingInstall(
  questions: ReadonlyArray<WorkflowQuestion>,
  runs: ReadonlyArray<WorkflowRun>,
): PendingInstall | null {
  const forkRuns = new Set(
    runs.filter((run) => run.workflow === FORK_INSTALL_WORKFLOW).map((run) => run.runId),
  );
  const question = questions.find((q) => q.name === "install" && forkRuns.has(q.runId));
  if (!question) return null;
  const request = question.request as { readonly data?: { readonly version?: unknown } } | null;
  const version = request?.data?.version;
  return {
    runId: question.runId,
    name: question.name,
    version: typeof version === "string" ? version : null,
  };
}
