import {
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  antigravityModelFamily,
  exhaustedUsageWindow,
  intersectPoolModels,
  intersectPoolRuntimeModes,
  isEligiblePoolMember,
  POOL_DRIVER_KIND,
  type PoolConfig,
  PoolConfigSchema,
  selectPoolMember,
} from "@t3tools/shared/usageLimits";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PoolRuntimeRegistry from "./PoolRuntimeRegistry.ts";

const FALLBACK_COOLDOWN_MS = 5 * 60_000;

const DEFAULT_POOL_CAPABILITIES = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const decodePoolConfig = Schema.decodeSync(PoolConfigSchema);

export type PoolDriverEnv = never;

function memberDisplayName(
  snapshots: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): string {
  const snapshot = snapshots.find((entry) => entry.instanceId === instanceId);
  return snapshot?.displayName?.trim() || String(instanceId);
}

function buildPoolSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly continuationGroupKey: string;
  readonly memberIds: ReadonlyArray<ProviderInstanceId>;
  readonly allSnapshots: ReadonlyArray<ServerProvider>;
  readonly checkedAt: string;
}): ServerProvider {
  const byId = new Map(
    input.allSnapshots.map((snapshot) => [snapshot.instanceId, snapshot] as const),
  );
  const members = input.memberIds.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
  const eligible = members.filter(isEligiblePoolMember);
  const models = intersectPoolModels(members);
  const supportedRuntimeModes = intersectPoolRuntimeModes(members);
  const installed = members.some((member) => member.installed);
  const authenticatedMembers = members.filter((member) => member.auth.status === "authenticated");
  const readyMembers = eligible.filter(
    (member) => member.status === "ready" || member.models.length > 0,
  );

  let status: ServerProvider["status"];
  let message: string | undefined;
  if (!input.enabled) {
    status = "disabled";
  } else if (input.memberIds.length === 0) {
    status = "warning";
    message = "Add Antigravity accounts to this pool in Provider settings.";
  } else if (members.length === 0) {
    status = "warning";
    message = "Waiting for pooled accounts to load.";
  } else if (readyMembers.length > 0 && models.length > 0) {
    status = "ready";
  } else if (authenticatedMembers.length > 0) {
    status = "warning";
    message =
      models.length === 0
        ? "Waiting for pooled accounts to report shared models."
        : `${readyMembers.length} of ${members.length} accounts ready.`;
  } else {
    status = "warning";
    message = "Sign in to at least one Antigravity account in this pool.";
  }

  return {
    instanceId: input.instanceId,
    driver: POOL_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    showInteractionModeToggle: members.some((member) => member.showInteractionModeToggle === true),
    reportsContextWindow: members.some((member) => member.reportsContextWindow === true),
    ...(supportedRuntimeModes ? { supportedRuntimeModes } : {}),
    supportsConversationRollback: members.every(
      (member) => member.supportsConversationRollback !== false,
    ),
    supportsTextGeneration: members.some((member) => member.supportsTextGeneration === true),
    enabled: input.enabled,
    installed,
    version: members.find((member) => member.version !== null)?.version ?? null,
    status,
    auth:
      authenticatedMembers.length > 0
        ? {
            status: "authenticated",
            label: `${authenticatedMembers.length} of ${input.memberIds.length} accounts`,
          }
        : { status: "unauthenticated" },
    checkedAt:
      members.reduce<string | null>(
        (latest, member) =>
          latest === null || member.checkedAt > latest ? member.checkedAt : latest,
        null,
      ) ?? input.checkedAt,
    ...(message ? { message } : {}),
    models,
    slashCommands: [],
    skills: [],
  };
}

function resolveMemberResetMs(
  memberSnapshot: ServerProvider | undefined,
  model: string,
  failureResetAt: string | null | undefined,
  nowMs: number,
): number {
  const candidates: number[] = [];
  if (failureResetAt) {
    const parsed = Date.parse(failureResetAt);
    if (Number.isFinite(parsed) && parsed > nowMs) candidates.push(parsed);
  }
  const exhausted = exhaustedUsageWindow(memberSnapshot, nowMs, model);
  if (exhausted?.resetsAt) {
    const parsed = Date.parse(exhausted.resetsAt);
    if (Number.isFinite(parsed) && parsed > nowMs) candidates.push(parsed);
  }
  return candidates.length > 0 ? Math.max(...candidates) : nowMs + FALLBACK_COOLDOWN_MS;
}

export const PoolDriver: ProviderDriver<PoolConfig, PoolDriverEnv> = {
  driverKind: POOL_DRIVER_KIND,
  metadata: {
    displayName: "Pool",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: PoolConfigSchema,
  defaultConfig: () => decodePoolConfig({}),
  create: Effect.fn("PoolDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
    config,
  }) {
    const maybePoolRegistry = yield* Effect.serviceOption(PoolRuntimeRegistry.PoolRuntimeRegistry);
    const poolRegistry = Option.isSome(maybePoolRegistry)
      ? maybePoolRegistry.value
      : yield* PoolRuntimeRegistry.makeMemoryPoolRuntimeRegistry();
    const memberIds = [...new Set(config.memberInstanceIds)];
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: POOL_DRIVER_KIND,
      instanceId,
    });

    const readMemberSnapshots = poolRegistry.getSnapshots.pipe(
      Effect.map((allSnapshots) => {
        const byId = new Map(allSnapshots.map((s) => [s.instanceId, s] as const));
        return memberIds.flatMap((id) => {
          const found = byId.get(id);
          return found ? [found] : [];
        });
      }),
    );

    const computeSnapshot = (allSnapshots: ReadonlyArray<ServerProvider>) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          buildPoolSnapshot({
            instanceId,
            displayName,
            accentColor,
            enabled,
            continuationGroupKey: continuationIdentity.continuationKey,
            memberIds,
            allSnapshots,
            checkedAt: DateTime.formatIso(now),
          }),
        ),
      );

    const getSnapshot = poolRegistry.getSnapshots.pipe(Effect.flatMap(computeSnapshot));
    const streamChanges = poolRegistry.streamSnapshots.pipe(
      Stream.mapEffect(computeSnapshot),
      Stream.changesWith((left, right) => {
        const { checkedAt: _a, ...restA } = left;
        const { checkedAt: _b, ...restB } = right;
        return Equal.equals(restA, restB);
      }),
    );
    const refresh = Effect.gen(function* () {
      yield* Effect.forEach(memberIds, (memberId) => poolRegistry.refreshMemberInstance(memberId), {
        concurrency: "unbounded",
        discard: true,
      });
      return yield* getSnapshot;
    });

    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: POOL_DRIVER_KIND,
      packageName: null,
    });

    const resolveMemberForModel = Effect.fn("PoolDriver.resolveMemberForModel")(function* (
      model: string | undefined,
      stickyMemberId?: ProviderInstanceId,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      const memberSnapshots = yield* readMemberSnapshots;
      const cooldowns = yield* poolRegistry.getCooldowns(nowMs);
      if (stickyMemberId && memberIds.includes(stickyMemberId)) {
        const stickyInstance = yield* poolRegistry.getMemberInstance(stickyMemberId);
        if (stickyInstance && stickyInstance.enabled) {
          return {
            memberId: stickyMemberId,
            memberInstance: stickyInstance,
          };
        }
      }
      const selection = selectPoolMember({
        members: memberSnapshots,
        model,
        now: nowMs,
        cooldowns,
      });
      const candidateId = selection.selected?.instanceId ?? memberIds[0];
      if (!candidateId) return undefined;
      const memberInstance = yield* poolRegistry.getMemberInstance(candidateId);
      if (!memberInstance) return undefined;
      return { memberId: candidateId, memberInstance };
    });

    const rewriteModelSelectionToMember = (
      selection: ModelSelection,
      memberId: ProviderInstanceId,
    ): ModelSelection => ({
      ...selection,
      instanceId: memberId,
    });

    const rewriteProviderThreadForMember = (
      thread: OrchestrationV2ProviderThread,
      memberInstance: ProviderInstance,
    ): OrchestrationV2ProviderThread => ({
      ...thread,
      driver: memberInstance.driverKind,
      providerInstanceId: memberInstance.instanceId,
    });

    const rewriteProviderThreadForPool = (
      thread: OrchestrationV2ProviderThread,
      memberId: ProviderInstanceId,
      model: string,
    ): OrchestrationV2ProviderThread => ({
      ...thread,
      driver: POOL_DRIVER_KIND,
      providerInstanceId: instanceId,
      // Carries the bound member instance so the web composer icon reflects the active account.
      nativeMetadata: {
        ...thread.nativeMetadata,
        modelSelection: { instanceId: memberId, model },
      },
    });

    const orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver: POOL_DRIVER_KIND,
      getCapabilities: Effect.fn("PoolAdapter.getCapabilities")(function* () {
        for (const memberId of memberIds) {
          const member = yield* poolRegistry.getMemberInstance(memberId);
          if (!member) continue;
          const caps = yield* member.orchestrationAdapter.getCapabilities().pipe(Effect.option);
          if (Option.isSome(caps)) return caps.value;
        }
        return DEFAULT_POOL_CAPABILITIES;
      }),
      planSelectionTransition: (input) =>
        Effect.succeed(
          input.current.model !== input.target.model &&
            !input.sessionCapabilities.sessions.supportsModelSwitchInSession
            ? {
                type: "reject" as const,
                reason: "The active session does not expose a model-switch capability.",
              }
            : { type: "apply_on_next_turn" as const },
        ),
      openSession: Effect.fn("PoolAdapter.openSession")(function* (openInput) {
        const existingBinding = yield* poolRegistry.getThreadBinding(openInput.threadId);
        const stickyId =
          existingBinding?.poolInstanceId === instanceId
            ? existingBinding.memberInstanceId
            : undefined;
        const resolved = yield* resolveMemberForModel(openInput.modelSelection.model, stickyId);
        if (!resolved) {
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver: POOL_DRIVER_KIND,
            providerSessionId: openInput.providerSessionId,
            cause: new Error(
              "This pool has no available Antigravity accounts. Add and sign in to at least one account in Provider settings.",
            ),
          });
        }
        const { memberId, memberInstance } = resolved;
        yield* poolRegistry.setThreadBinding({
          threadId: openInput.threadId,
          poolInstanceId: instanceId,
          memberInstanceId: memberId,
        });

        const memberSession = yield* memberInstance.orchestrationAdapter.openSession({
          ...openInput,
          modelSelection: rewriteModelSelectionToMember(openInput.modelSelection, memberId),
          ...(openInput.resumeFromSession
            ? {
                resumeFromSession: {
                  ...openInput.resumeFromSession,
                  driver: memberInstance.driverKind,
                  providerInstanceId: memberId,
                },
              }
            : {}),
        });

        let currentModel = openInput.modelSelection.model;
        const maxHops = Math.max(memberIds.length, 4);

        const wrapEvent = Effect.fn("PoolAdapter.wrapEvent")(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
        ): Effect.fn.Return<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>> {
          switch (event.type) {
            case "provider_session.updated":
              return [
                {
                  ...event,
                  driver: POOL_DRIVER_KIND,
                  providerSession: {
                    ...event.providerSession,
                    driver: POOL_DRIVER_KIND,
                    providerInstanceId: instanceId,
                  },
                },
              ];
            case "provider_thread.updated":
              return [
                {
                  ...event,
                  driver: POOL_DRIVER_KIND,
                  providerThread: rewriteProviderThreadForPool(
                    event.providerThread,
                    memberId,
                    currentModel,
                  ),
                },
              ];
            case "thread_model_selection.updated":
              return [
                {
                  ...event,
                  driver: POOL_DRIVER_KIND,
                  instanceId,
                },
              ];
            case "app_thread.created":
              return [
                {
                  ...event,
                  driver: POOL_DRIVER_KIND,
                  appThread: {
                    ...event.appThread,
                    providerInstanceId: instanceId,
                    modelSelection: {
                      ...event.appThread.modelSelection,
                      instanceId,
                    },
                  },
                },
              ];
            case "turn.terminal": {
              if (event.status !== "failed" || event.failure.class !== "usage_limit") {
                return [{ ...event, driver: POOL_DRIVER_KIND }];
              }
              const nowMs = yield* Clock.currentTimeMillis;
              const allSnapshots = yield* poolRegistry.getSnapshots;
              const memberSnapshot = allSnapshots.find((s) => s.instanceId === memberId);
              const family = antigravityModelFamily(currentModel) ?? "all";
              const resetAtMs = resolveMemberResetMs(
                memberSnapshot,
                currentModel,
                event.failure.resetAt,
                nowMs,
              );
              yield* poolRegistry.recordCooldown({
                memberInstanceId: memberId,
                family,
                resetAtMs,
              });
              yield* poolRegistry.refreshMemberInstance(memberId).pipe(Effect.forkDetach);

              const memberSnapshots = yield* readMemberSnapshots;
              const cooldowns = yield* poolRegistry.getCooldowns(nowMs);
              const chainDepth = yield* poolRegistry.getFailoverDepth(openInput.threadId);

              const nextChoice = selectPoolMember({
                members: memberSnapshots,
                model: currentModel,
                now: nowMs,
                cooldowns,
                excludeInstanceIds: new Set([memberId]),
              });

              if (nextChoice.selected !== null && !nextChoice.allDepleted && chainDepth < maxHops) {
                const failedLabel = memberDisplayName(allSnapshots, memberId);
                const targetLabel = memberDisplayName(allSnapshots, nextChoice.selected.instanceId);
                yield* poolRegistry.enqueueFailover({
                  sourceThreadId: openInput.threadId,
                  poolInstanceId: instanceId,
                  targetMemberInstanceId: nextChoice.selected.instanceId,
                  failedMemberLabel: failedLabel,
                  targetMemberLabel: targetLabel,
                  runOrdinal: event.runOrdinal,
                  chainDepth: chainDepth + 1,
                });
                const now = yield* DateTime.now;
                const noticeId = IdAllocator.derive.turnItemFromProviderItem({
                  driver: POOL_DRIVER_KIND,
                  nativeItemId: `pool-failover:${event.providerTurnId}:${event.runOrdinal}:${nextChoice.selected.instanceId}`,
                });
                const noticeEvent: ProviderAdapter.ProviderAdapterV2Event = {
                  type: "turn_item.updated",
                  driver: POOL_DRIVER_KIND,
                  turnItem: {
                    id: noticeId,
                    threadId: openInput.threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: event.providerThreadId,
                    providerTurnId: event.providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: event.failureItemOrdinal,
                    status: "completed",
                    title: "Switched pool account",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "system_notice",
                    level: "info",
                    message: `${failedLabel} reached its usage limit. Continuing in a new thread with ${targetLabel}.`,
                  },
                };
                const completedTerminal: ProviderAdapter.ProviderAdapterV2Event = {
                  type: "turn.terminal",
                  driver: POOL_DRIVER_KIND,
                  providerThreadId: event.providerThreadId,
                  providerTurnId: event.providerTurnId,
                  runOrdinal: event.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                  ...(event.retainedRuntimeRequestIds === undefined
                    ? {}
                    : { retainedRuntimeRequestIds: event.retainedRuntimeRequestIds }),
                };
                return [noticeEvent, completedTerminal];
              }

              // Every account in the pool is depleted: surface standard usage_limit with
              // the earliest reset across all pool accounts so auto-continue wakes on it.
              const allEvaluation = selectPoolMember({
                members: memberSnapshots,
                model: currentModel,
                now: nowMs,
                cooldowns,
              });
              const earliestResetAt =
                allEvaluation.earliestResetAt ??
                event.failure.resetAt ??
                DateTime.formatIso(DateTime.makeUnsafe(resetAtMs));
              return [
                {
                  ...event,
                  driver: POOL_DRIVER_KIND,
                  failure: {
                    ...event.failure,
                    class: "usage_limit",
                    resetAt: earliestResetAt,
                  },
                },
              ];
            }
            default:
              return [{ ...event, driver: POOL_DRIVER_KIND }];
          }
        });

        const wrappedSession: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          ...memberSession,
          instanceId,
          driver: POOL_DRIVER_KIND,
          providerSession: {
            ...memberSession.providerSession,
            driver: POOL_DRIVER_KIND,
            providerInstanceId: instanceId,
          },
          events: memberSession.events.pipe(
            Stream.mapEffect(wrapEvent),
            Stream.flatMap(Stream.fromIterable),
          ),
          ...(memberSession.subscribeEvents
            ? {
                subscribeEvents: memberSession.subscribeEvents.pipe(
                  Effect.map((sub) => ({
                    ...sub,
                    events: sub.events.pipe(
                      Stream.mapEffect(wrapEvent),
                      Stream.flatMap(Stream.fromIterable),
                    ),
                  })),
                ),
              }
            : {}),
          ...(memberSession.hasPendingBackgroundWorkForThread
            ? {
                hasPendingBackgroundWorkForThread: (providerThread, options) =>
                  memberSession.hasPendingBackgroundWorkForThread!(
                    rewriteProviderThreadForMember(providerThread, memberInstance),
                    options,
                  ),
              }
            : {}),
          ...(memberSession.getModelContextWindow
            ? {
                getModelContextWindow: (selection, cwd) =>
                  memberSession.getModelContextWindow!(
                    rewriteModelSelectionToMember(selection, memberId),
                    cwd,
                  ),
              }
            : {}),
          ...(memberSession.canReuseContextUsage
            ? {
                canReuseContextUsage: (previous, next) =>
                  memberSession.canReuseContextUsage!(
                    rewriteModelSelectionToMember(previous, memberId),
                    rewriteModelSelectionToMember(next, memberId),
                  ),
              }
            : {}),
          ...(memberSession.normalizeThreadLoadModelSelection
            ? {
                normalizeThreadLoadModelSelection: (selection) => ({
                  ...memberSession.normalizeThreadLoadModelSelection!(
                    rewriteModelSelectionToMember(selection, memberId),
                  ),
                  instanceId,
                }),
              }
            : {}),
          ensureThread: (input) => {
            currentModel = input.modelSelection.model;
            return memberSession
              .ensureThread({
                ...input,
                modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
              })
              .pipe(
                Effect.map((thread) =>
                  rewriteProviderThreadForPool(thread, memberId, currentModel),
                ),
              );
          },
          resumeThread: (input) => {
            if (input.modelSelection) currentModel = input.modelSelection.model;
            return memberSession
              .resumeThread({
                ...input,
                providerThread: rewriteProviderThreadForMember(
                  input.providerThread,
                  memberInstance,
                ),
                ...(input.modelSelection
                  ? {
                      modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
                    }
                  : {}),
              })
              .pipe(
                Effect.map((thread) =>
                  rewriteProviderThreadForPool(thread, memberId, currentModel),
                ),
              );
          },
          ...(memberSession.injectHistory
            ? {
                injectHistory: (input) =>
                  memberSession.injectHistory!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          startTurn: (input) => {
            currentModel = input.modelSelection.model;
            return memberSession.startTurn({
              ...input,
              providerThread: rewriteProviderThreadForMember(input.providerThread, memberInstance),
              modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
            });
          },
          ...(memberSession.resumeTurn
            ? {
                resumeTurn: (input) => {
                  currentModel = input.modelSelection.model;
                  return memberSession.resumeTurn!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                    modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
                  });
                },
              }
            : {}),
          ...(memberSession.compactThread
            ? {
                compactThread: (input) => {
                  currentModel = input.modelSelection.model;
                  return memberSession.compactThread!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                    modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
                  });
                },
              }
            : {}),
          steerTurn: (input) =>
            memberSession.steerTurn({
              ...input,
              providerThread: rewriteProviderThreadForMember(input.providerThread, memberInstance),
            }),
          ...(memberSession.applyModelSelection
            ? {
                applyModelSelection: (input) => {
                  currentModel = input.modelSelection.model;
                  return memberSession.applyModelSelection!({
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                    modelSelection: rewriteModelSelectionToMember(input.modelSelection, memberId),
                  });
                },
              }
            : {}),
          ...(memberSession.applyThreadTitle
            ? {
                applyThreadTitle: (input) =>
                  memberSession.applyThreadTitle!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          ...(memberSession.stopTask
            ? {
                stopTask: (input) =>
                  memberSession.stopTask!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          ...(memberSession.awaitBackgroundTasks
            ? {
                awaitBackgroundTasks: (input) =>
                  memberSession.awaitBackgroundTasks!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          interruptTurn: (input) =>
            memberSession.interruptTurn({
              ...input,
              providerThread: rewriteProviderThreadForMember(input.providerThread, memberInstance),
            }),
          ...(memberSession.stopSubagent
            ? {
                stopSubagent: (input) =>
                  memberSession.stopSubagent!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          ...(memberSession.unloadThread
            ? {
                unloadThread: (input) =>
                  memberSession.unloadThread!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          respondToRuntimeRequest: (input) => memberSession.respondToRuntimeRequest(input),
          readThreadSnapshot: (input) =>
            memberSession
              .readThreadSnapshot({
                ...input,
                providerThread: rewriteProviderThreadForMember(
                  input.providerThread,
                  memberInstance,
                ),
              })
              .pipe(
                Effect.map((snapshot) => ({
                  ...snapshot,
                  providerThread: rewriteProviderThreadForPool(
                    snapshot.providerThread,
                    memberId,
                    currentModel,
                  ),
                })),
              ),
          ...(memberSession.uploadFeedback
            ? {
                uploadFeedback: (input) =>
                  memberSession.uploadFeedback!({
                    ...input,
                    providerThread: rewriteProviderThreadForMember(
                      input.providerThread,
                      memberInstance,
                    ),
                  }),
              }
            : {}),
          ...(memberSession.mcpApps
            ? {
                mcpApps: {
                  listTools: (input) =>
                    memberSession.mcpApps!.listTools({
                      ...input,
                      providerThread: rewriteProviderThreadForMember(
                        input.providerThread,
                        memberInstance,
                      ),
                    }),
                  callTool: (input) =>
                    memberSession.mcpApps!.callTool({
                      ...input,
                      providerThread: rewriteProviderThreadForMember(
                        input.providerThread,
                        memberInstance,
                      ),
                    }),
                  readResource: (input) =>
                    memberSession.mcpApps!.readResource({
                      ...input,
                      providerThread: rewriteProviderThreadForMember(
                        input.providerThread,
                        memberInstance,
                      ),
                    }),
                },
              }
            : {}),
          ...(memberSession.mcpSignIn
            ? {
                mcpSignIn: {
                  start: (input) =>
                    memberSession.mcpSignIn!.start({
                      ...input,
                      providerThread: rewriteProviderThreadForMember(
                        input.providerThread,
                        memberInstance,
                      ),
                    }),
                  complete: (input) =>
                    memberSession.mcpSignIn!.complete({
                      ...input,
                      providerThread: rewriteProviderThreadForMember(
                        input.providerThread,
                        memberInstance,
                      ),
                    }),
                },
              }
            : {}),
          rollbackThread: (input) =>
            memberSession
              .rollbackThread({
                ...input,
                providerThread: rewriteProviderThreadForMember(
                  input.providerThread,
                  memberInstance,
                ),
              })
              .pipe(
                Effect.map((snapshot) => ({
                  ...snapshot,
                  providerThread: rewriteProviderThreadForPool(
                    snapshot.providerThread,
                    memberId,
                    currentModel,
                  ),
                })),
              ),
          forkThread: (input) =>
            memberSession
              .forkThread({
                ...input,
                sourceProviderThread: rewriteProviderThreadForMember(
                  input.sourceProviderThread,
                  memberInstance,
                ),
              })
              .pipe(
                Effect.map((thread) =>
                  rewriteProviderThreadForPool(thread, memberId, currentModel),
                ),
              ),
        };
        return wrappedSession;
      }),
    };

    const delegateTextGeneration = <I extends { modelSelection: ModelSelection }, O>(
      operation: string,
      invoke: (textGen: ProviderTextGeneration, input: I) => Effect.Effect<O, TextGenerationError>,
    ) =>
      Effect.fn(`PoolDriver.${operation}`)(function* (input: I) {
        const resolved = yield* resolveMemberForModel(input.modelSelection.model);
        if (!resolved) {
          return yield* new TextGenerationError({
            operation,
            detail: "Pool has no available member accounts.",
          });
        }
        return yield* invoke(resolved.memberInstance.textGeneration, {
          ...input,
          modelSelection: rewriteModelSelectionToMember(input.modelSelection, resolved.memberId),
        });
      });

    const textGeneration: ProviderTextGeneration = {
      generateTranscriptionPostProcessing: delegateTextGeneration(
        "generateTranscriptionPostProcessing",
        (tg, input) => tg.generateTranscriptionPostProcessing(input),
      ),
      generateCommitMessage: delegateTextGeneration("generateCommitMessage", (tg, input) =>
        tg.generateCommitMessage(input),
      ),
      generatePrContent: delegateTextGeneration("generatePrContent", (tg, input) =>
        tg.generatePrContent(input),
      ),
      generateBranchName: delegateTextGeneration("generateBranchName", (tg, input) =>
        tg.generateBranchName(input),
      ),
      generateThreadTitle: delegateTextGeneration("generateThreadTitle", (tg, input) =>
        tg.generateThreadTitle(input),
      ),
      generateReviewGuide: delegateTextGeneration("generateReviewGuide", (tg, input) =>
        tg.generateReviewGuide(input),
      ),
    };

    return {
      instanceId,
      driverKind: POOL_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: {
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSnapshot,
        refresh,
        streamChanges,
        applyUsageLimits: () => Effect.void,
      },
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
