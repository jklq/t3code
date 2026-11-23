import type { WorkflowQuestion, WorkflowRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  latestForkRun,
  parseTagList,
  pendingInstall,
  readForkConfig,
  writeForkConfig,
} from "./forkConfig";

const workflow = (config: string) =>
  [
    'const FORK_HOME = "/home/me/.t3/fork";',
    "",
    "// fork-config:begin edited by settings; keep it JSON.",
    `const FORK_CONFIG = ${config};`,
    "// fork-config:end",
    "",
    'workflow("fork-update", {}, body);',
  ].join("\n");

const run = (patch: Partial<WorkflowRun>): WorkflowRun => ({
  runId: "r",
  workflow: "fork-update",
  version: 2,
  title: "fork-update",
  status: "completed",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  endedAt: null,
  ...patch,
});

describe("fork config block", () => {
  it("reads the JSON between the markers", () => {
    const config = readForkConfig(workflow('{ "cadenceHours": 12, "pinTag": null }'));
    expect(config).toMatchObject({ cadenceHours: 12, pinTag: null });
  });

  it("is missing without the block or with broken JSON", () => {
    expect(readForkConfig('workflow("x", {}, body);')).toBeNull();
    expect(readForkConfig(workflow("{ cadenceHours: 12 }"))).toBeNull();
  });

  it("writes a patch, keeping other keys and the rest of the file", () => {
    const source = workflow('{ "cadenceHours": 24, "node": "/usr/bin/node" }');
    const written = writeForkConfig(source, { cadenceHours: 6 });
    expect(readForkConfig(written)).toEqual({ cadenceHours: 6, node: "/usr/bin/node" });
    expect(written.startsWith('const FORK_HOME = "/home/me/.t3/fork";')).toBe(true);
    expect(written.endsWith('workflow("fork-update", {}, body);')).toBe(true);
  });

  it("splits a skip list on commas and spaces", () => {
    expect(parseTagList(" v1-nightly.1, v1-nightly.2  v1-nightly.3,")).toEqual([
      "v1-nightly.1",
      "v1-nightly.2",
      "v1-nightly.3",
    ]);
  });
});

describe("fork update status", () => {
  it("shows the newest run that did something, not the idle ticks after it", () => {
    const runs = [
      run({ runId: "update", detail: "v1 → v2", startedAt: "2026-11-24T01:00:00.000Z" }),
      run({
        runId: "tick",
        status: "skipped",
        detail: "not due",
        startedAt: "2026-11-24T02:00:00.000Z",
      }),
      run({ runId: "other", workflow: "nightly-report", startedAt: "2026-11-24T03:00:00.000Z" }),
    ];
    expect(latestForkRun(runs)?.runId).toBe("update");
  });

  it("finds the install question of a fork update with its version", () => {
    const question: WorkflowQuestion = {
      runId: "update",
      name: "install",
      request: { title: "Install?", choices: ["install", "skip"], data: { version: "0.1.13" } },
      askedAt: "2026-11-24T01:10:00.000Z",
      thread: null,
    };
    expect(
      pendingInstall([question], [run({ runId: "update", workflow: "fork-install" })]),
    ).toEqual({
      runId: "update",
      name: "install",
      version: "0.1.13",
    });
    expect(pendingInstall([question], [])).toBeNull();
  });
});
