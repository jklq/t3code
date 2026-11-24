import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { parsePoolConfig, POOL_DRIVER_KIND, selectPoolMember } from "@t3tools/shared/usageLimits";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PoolRuntimeRegistry from "./PoolRuntimeRegistry.ts";

function continuationTitle(title: string): string {
  const trimmed = title.trim();
  if (/\(cont\.\)$/i.test(trimmed)) return trimmed;
  return `${trimmed} (cont.)`;
}

export class PoolLimitRecovery extends Context.Service<
  PoolLimitRecovery,
  {
    /**
     * When a pool thread's usage-limit recovery wakes at reset, launches a new continuation
     * thread on the quickest-renewed / least-limited member account and disarms recovery on
     * the original thread. Returns true when handled as a pool thread, false otherwise.
     */
    readonly tryRecoverPoolThread: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly resetAt: string;
    }) => Effect.Effect<boolean>;
  }
>()("t3/fork/PoolCoordinator/PoolLimitRecovery") {}

const launchContinuationThread = Effect.fn("PoolCoordinator.launchContinuationThread")(
  function* (input: {
    readonly sourceThread: OrchestrationV2AppThread;
    readonly poolInstanceId: ProviderInstanceId;
    readonly targetMemberInstanceId: ProviderInstanceId;
    readonly commandId: CommandId;
    readonly chainDepth: number;
    readonly poolRegistry: PoolRuntimeRegistry.PoolRuntimeRegistry["Service"];
    readonly threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"];
    readonly ids: IdAllocator.IdAllocatorV2["Service"];
  }) {
    const newThreadId = yield* input.ids.allocate.thread({
      projectId: input.sourceThread.projectId,
    });
    yield* input.poolRegistry.setThreadBinding({
      threadId: newThreadId,
      poolInstanceId: input.poolInstanceId,
      memberInstanceId: input.targetMemberInstanceId,
    });
    if (input.chainDepth > 0) {
      yield* input.poolRegistry.setFailoverDepth(newThreadId, input.chainDepth);
    }
    const workspaceStrategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy =
      input.sourceThread.worktreePath !== null
        ? {
            type: "existing_worktree",
            worktreePath: input.sourceThread.worktreePath,
            ...(input.sourceThread.branch ? { branch: input.sourceThread.branch } : {}),
          }
        : {
            type: "root",
            ...(input.sourceThread.branch ? { branch: input.sourceThread.branch } : {}),
          };
    yield* input.threadLaunch.launch({
      commandId: input.commandId,
      threadId: newThreadId,
      projectId: input.sourceThread.projectId,
      title: continuationTitle(input.sourceThread.title),
      titleRenamed: true,
      modelSelection: {
        ...input.sourceThread.modelSelection,
        instanceId: input.poolInstanceId,
      },
      runtimeMode: input.sourceThread.runtimeMode,
      interactionMode: input.sourceThread.interactionMode,
      workspaceStrategy,
      initialMessage: {
        messageId: MessageId.make(`pool-continue:${input.commandId}`),
        text: `Continue thread id ${input.sourceThread.id}`,
        attachments: [],
      },
      createdBy: "agent",
      creationSource: "server",
    });
    return newThreadId;
  },
);

/** Bridges ProviderInstanceRegistry + ProviderRegistry into PoolRuntimeRegistry. */
export const layerBridge: Layer.Layer<
  never,
  never,
  | PoolRuntimeRegistry.PoolRuntimeRegistry
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderRegistry.ProviderRegistry
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const poolRegistry = yield* PoolRuntimeRegistry.PoolRuntimeRegistry;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;

    yield* poolRegistry.attachHost({
      getInstance: (id) => instances.getInstance(id),
      refreshInstance: (id) => providers.refreshInstance(id).pipe(Effect.asVoid, Effect.ignore),
    });

    const initial = yield* providers.getProviders;
    yield* poolRegistry.publishSnapshots(initial);

    yield* forkParked(
      Stream.runForEach(providers.streamChanges, (snapshots) =>
        poolRegistry.publishSnapshots(snapshots),
      ),
    );
  }),
);

/** Handles both immediate pool failovers and reset-time pool limit recovery. */
export const layerLimitRecovery: Layer.Layer<
  PoolLimitRecovery,
  never,
  | ProjectionStore.ProjectionStoreV2
  | Orchestrator.OrchestratorV2
  | ThreadLaunchService.ThreadLaunchService
  | ServerSettings.ServerSettingsService
  | IdAllocator.IdAllocatorV2
> = Layer.effect(
  PoolLimitRecovery,
  Effect.gen(function* () {
    const maybePoolRegistry = yield* Effect.serviceOption(PoolRuntimeRegistry.PoolRuntimeRegistry);
    if (Option.isNone(maybePoolRegistry)) {
      return PoolLimitRecovery.of({
        tryRecoverPoolThread: Effect.fn("PoolLimitRecovery.tryRecoverPoolThread")(() =>
          Effect.succeed(false),
        ),
      });
    }
    const poolRegistry = maybePoolRegistry.value;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const ids = yield* IdAllocator.IdAllocatorV2;

    // Immediate failover worker: drains PoolAdapter's failover queue and spawns continuation threads.
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          const request = yield* poolRegistry.takeFailover;
          yield* Effect.gen(function* () {
            const sourceThread = yield* projections.getThread(request.sourceThreadId);
            const commandId = CommandId.make(
              `pool-failover:${request.sourceThreadId}:${request.runOrdinal}:${request.targetMemberInstanceId}`,
            );
            yield* launchContinuationThread({
              sourceThread,
              poolInstanceId: request.poolInstanceId,
              targetMemberInstanceId: request.targetMemberInstanceId,
              commandId,
              chainDepth: request.chainDepth,
              poolRegistry,
              threadLaunch,
              ids,
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("fork.pool.failover-launch-failed", {
                sourceThreadId: request.sourceThreadId,
                targetMemberInstanceId: request.targetMemberInstanceId,
                cause,
              }),
            ),
          );
        }),
      ),
    );

    return PoolLimitRecovery.of({
      tryRecoverPoolThread: Effect.fn("PoolLimitRecovery.tryRecoverPoolThread")(function* ({
        threadId,
        runId,
        resetAt,
      }) {
        const sourceThread = yield* projections
          .getThread(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (sourceThread === null) return false;
        const currentSettings = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const instanceConfig = currentSettings?.providerInstances[sourceThread.providerInstanceId];
        if (instanceConfig?.driver !== POOL_DRIVER_KIND) return false;

        const poolConfig = parsePoolConfig(instanceConfig.config);
        const nowMs = yield* Clock.currentTimeMillis;
        const allSnapshots = yield* poolRegistry.getSnapshots;
        const byId = new Map(allSnapshots.map((s) => [s.instanceId, s] as const));
        const members = poolConfig.memberInstanceIds.flatMap((id) => {
          const found = byId.get(id);
          return found ? [found] : [];
        });
        const cooldowns = yield* poolRegistry.getCooldowns(nowMs);
        const selection = selectPoolMember({
          members,
          model: sourceThread.modelSelection.model,
          now: nowMs,
          cooldowns,
        });
        const targetMemberInstanceId =
          selection.selected?.instanceId ??
          selection.quickestResetMember?.instanceId ??
          poolConfig.memberInstanceIds[0];
        if (!targetMemberInstanceId) return false;

        const resetMs = Date.parse(resetAt);
        const identity = `${threadId}:${runId}:${Number.isFinite(resetMs) ? resetMs : resetAt}`;
        const launched = yield* launchContinuationThread({
          sourceThread,
          poolInstanceId: sourceThread.providerInstanceId,
          targetMemberInstanceId,
          commandId: CommandId.make(`pool-limit-resume:${identity}`),
          chainDepth: 0,
          poolRegistry,
          threadLaunch,
          ids,
        }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("fork.pool.limit-recovery-launch-failed", {
              threadId,
              targetMemberInstanceId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (launched) {
          yield* orchestrator
            .autoArmLimitRecovery({
              commandId: CommandId.make(`pool-limit-disarm:${identity}`),
              threadId,
              limitRecovery: {
                runId,
                resetAt,
                autoResume: false,
                snooze: false,
              },
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        return true;
      }),
    });
  }),
);
