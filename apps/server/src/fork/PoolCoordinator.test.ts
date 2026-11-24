import { it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { POOL_DRIVER_KIND } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { describe, expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PoolCoordinator from "./PoolCoordinator.ts";
import * as PoolRuntimeRegistry from "./PoolRuntimeRegistry.ts";

function makeMemberSnapshot(
  id: string,
  displayName: string,
  usedPercent: number,
  resetsAt?: string,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("antigravity"),
    displayName,
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: "2026-11-24T01:00:00.000Z",
    models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-24T01:00:00.000Z",
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent,
          windowDurationMins: 300,
          ...(resetsAt ? { resetsAt } : {}),
        },
      ],
    },
  };
}

describe("PoolCoordinator", () => {
  it.effect(
    "launches a continuation thread for immediate failover and reset-time pool recovery",
    () =>
      Effect.gen(function* () {
        const poolInstanceId = ProviderInstanceId.make("pool_main");
        const albertId = ProviderInstanceId.make("ag_albert");
        const laId = ProviderInstanceId.make("ag_la");
        const sourceThreadId = ThreadId.make("thread-source-1");
        const projectId = ProjectId.make("project-1");

        const sourceThread = {
          id: sourceThreadId,
          projectId,
          title: "Ship Pool Provider",
          providerInstanceId: poolInstanceId,
          modelSelection: {
            instanceId: poolInstanceId,
            model: "gemini-4-neon",
            options: { effort: "high" },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          worktreePath: "/tmp/wt-pool",
          branch: "feat/pool",
        } as unknown as OrchestrationV2AppThread;

        const launched = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
        const disarmed = yield* Queue.unbounded<ThreadId>();

        const poolRegistryLayer = PoolRuntimeRegistry.layerMemory;
        const testLayer = Layer.mergeAll(
          poolRegistryLayer,
          PoolCoordinator.layerLimitRecovery.pipe(
            Layer.provide(
              Layer.mergeAll(
                poolRegistryLayer,
                IdAllocator.layer,
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getThread: () => Effect.succeed(sourceThread),
                }),
                Layer.mock(Orchestrator.OrchestratorV2)({
                  autoArmLimitRecovery: (input) =>
                    Queue.offer(disarmed, input.threadId).pipe(Effect.as({} as never)),
                }),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) => Queue.offer(launched, input).pipe(Effect.as({} as never)),
                }),
                Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings: Effect.succeed({
                    providerInstances: {
                      [poolInstanceId]: {
                        driver: POOL_DRIVER_KIND,
                        displayName: "Pool",
                        enabled: true,
                        config: {
                          memberDriver: "antigravity",
                          memberInstanceIds: [albertId, laId],
                        },
                      },
                    },
                  } as never),
                }),
              ),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const poolRegistry = yield* PoolRuntimeRegistry.PoolRuntimeRegistry;
          const recovery = yield* PoolCoordinator.PoolLimitRecovery;

          yield* poolRegistry.publishSnapshots([
            makeMemberSnapshot(albertId, "Albert", 80),
            makeMemberSnapshot(laId, "LA", 10),
          ]);

          // 1. Immediate failover queue launches a new thread bound to LA with exact continuation prompt.
          yield* poolRegistry.enqueueFailover({
            sourceThreadId,
            poolInstanceId,
            targetMemberInstanceId: laId,
            failedMemberLabel: "Albert",
            targetMemberLabel: "LA",
            runOrdinal: 1,
            chainDepth: 1,
          });
          const failoverLaunch = yield* Queue.take(launched);
          expect(failoverLaunch.initialMessage?.text).toBe(`Continue thread id ${sourceThreadId}`);
          expect(failoverLaunch.modelSelection).toEqual(sourceThread.modelSelection);
          expect(failoverLaunch.workspaceStrategy).toEqual({
            type: "existing_worktree",
            worktreePath: "/tmp/wt-pool",
            branch: "feat/pool",
          });
          const failoverThreadId = failoverLaunch.threadId;
          expect(failoverThreadId).toBeDefined();
          const binding = yield* poolRegistry.getThreadBinding(failoverThreadId!);
          expect(binding?.memberInstanceId).toBe(laId);
          expect(yield* poolRegistry.getFailoverDepth(failoverThreadId!)).toBe(1);

          // 2. Reset-time recovery opens a new thread on the least-limited member and disarms the source thread.
          const handled = yield* recovery.tryRecoverPoolThread({
            threadId: sourceThreadId,
            runId: RunId.make("run-1"),
            resetAt: "2099-01-01T02:00:00.000Z",
          });
          expect(handled).toBe(true);

          const recoveryLaunch = yield* Queue.take(launched);
          expect(recoveryLaunch.initialMessage?.text).toBe(`Continue thread id ${sourceThreadId}`);
          expect(recoveryLaunch.threadId).toBeDefined();
          const recoveryBinding = yield* poolRegistry.getThreadBinding(recoveryLaunch.threadId!);
          expect(recoveryBinding?.memberInstanceId).toBe(laId);
          expect(yield* Queue.take(disarmed)).toBe(sourceThreadId);
        }).pipe(Effect.provide(testLayer));
      }),
  );
});
