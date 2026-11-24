import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  PositiveInt,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { POOL_DRIVER_KIND } from "@t3tools/shared/usageLimits";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PoolDriver } from "./PoolDriver.ts";
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
    models: [
      { slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
    ],
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

function makeFakeMemberInstance(
  snapshot: ServerProvider,
  eventQueue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
): {
  readonly instance: ProviderInstance;
  readonly openedModelSelections: Array<string>;
} {
  const openedModelSelections: Array<string> = [];
  const driver = snapshot.driver;
  const instanceId = snapshot.instanceId;
  const now = DateTime.makeUnsafe("2026-11-24T01:00:00.000Z");

  const providerSession: OrchestrationV2ProviderSession = {
    id: ProviderSessionId.make("sess-1"),
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/tmp",
    model: "gemini-4-neon",
    capabilities: AcpProviderCapabilitiesV2,
    extensionStatuses: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };

  const makeThread = (threadId: ThreadId): OrchestrationV2ProviderThread => ({
    id: ProviderThreadId.make("pt-1"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: providerSession.id,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  });

  const orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(AcpProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) => {
      openedModelSelections.push(
        `${input.modelSelection.instanceId}:${input.modelSelection.model}`,
      );
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: { ...providerSession, id: input.providerSessionId },
        events: Stream.fromQueue(eventQueue),
        ensureThread: (ensureInput) => Effect.succeed(makeThread(ensureInput.threadId)),
        resumeThread: (resumeInput) => Effect.succeed(resumeInput.providerThread),
        startTurn: () => Effect.void,
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: (readInput) =>
          Effect.succeed({
            providerThread: readInput.providerThread,
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (rollbackInput) =>
          Effect.succeed({
            providerThread: rollbackInput.providerThread,
            messages: [],
            runtimeRequests: [],
          }),
        forkThread: (forkInput) => Effect.succeed(forkInput.sourceProviderThread),
      };
      return Effect.succeed(runtime);
    },
  };

  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: {
      driverKind: driver,
      continuationKey: `${driver}:instance:${instanceId}`,
    },
    displayName: snapshot.displayName,
    accentColor: snapshot.accentColor,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
        ),
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter,
    textGeneration: {
      generateTranscriptionPostProcessing: () => Effect.die("unused"),
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateReviewGuide: () => Effect.die("unused"),
    },
  };

  return { instance, openedModelSelections };
}

describe("PoolDriver", () => {
  it.effect(
    "picks the least-limited member, stamps nativeMetadata, and fails over automatically when another member is available",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const poolRegistry = yield* PoolRuntimeRegistry.PoolRuntimeRegistry;
          const albertSnapshot = makeMemberSnapshot("ag_albert", "Albert", 70);
          const laSnapshot = makeMemberSnapshot("ag_la", "LA", 10);

          const albertEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const laEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const albert = makeFakeMemberInstance(albertSnapshot, albertEvents);
          const la = makeFakeMemberInstance(laSnapshot, laEvents);

          const byId = new Map<ProviderInstanceId, ProviderInstance>([
            [albertSnapshot.instanceId, albert.instance],
            [laSnapshot.instanceId, la.instance],
          ]);

          yield* poolRegistry.attachHost({
            getInstance: (id) => Effect.succeed(byId.get(id)),
            refreshInstance: () => Effect.void,
          });
          yield* poolRegistry.publishSnapshots([albertSnapshot, laSnapshot]);

          const pool = yield* PoolDriver.create({
            instanceId: ProviderInstanceId.make("pool_main"),
            displayName: "Pool",
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: {
              memberDriver: "antigravity",
              memberInstanceIds: [albertSnapshot.instanceId, laSnapshot.instanceId],
            },
          });

          const snap = yield* pool.snapshot.getSnapshot;
          expect(snap.driver).toBe(POOL_DRIVER_KIND);
          expect(snap.status).toBe("ready");
          expect(snap.usageLimits).toBeUndefined();
          expect(snap.models.map((m) => m.slug)).toEqual(["gemini-4-neon", "claude-sonnet-4-6"]);

          const threadId = ThreadId.make("thread-1");
          const session = yield* pool.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("ps-1"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("pool_main"),
              model: "gemini-4-neon",
            },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp",
            },
          });

          // LA had 10% used vs Albert's 70%, so LA is chosen and receives its own instanceId.
          expect(la.openedModelSelections).toEqual(["ag_la:gemini-4-neon"]);
          expect(albert.openedModelSelections).toEqual([]);

          const ensured = yield* session.ensureThread({
            threadId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("pool_main"),
              model: "gemini-4-neon",
            },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp",
            },
          });
          expect(ensured.driver).toBe(POOL_DRIVER_KIND);
          expect(ensured.providerInstanceId).toBe(ProviderInstanceId.make("pool_main"));
          expect(ensured.nativeMetadata?.modelSelection?.instanceId).toBe(laSnapshot.instanceId);

          // Simulate LA hitting usage_limit while Albert is still available.
          yield* Queue.offer(laEvents, {
            type: "turn.terminal",
            driver: ProviderDriverKind.make("antigravity"),
            providerThreadId: ProviderThreadId.make("pt-1"),
            providerTurnId: ProviderTurnId.make("turn-1"),
            runOrdinal: PositiveInt.make(1),
            failureItemOrdinal: PositiveInt.make(1),
            status: "failed",
            failure: makeProviderFailure({
              class: "usage_limit",
              message: "Quota exhausted",
              resetAt: "2099-01-01T05:00:00.000Z",
            }),
            threadDisposition: "reusable",
          });

          const emitted = yield* session.events.pipe(Stream.take(2), Stream.runCollect);
          expect(emitted).toHaveLength(2);
          expect(emitted[0]?.type).toBe("turn_item.updated");
          expect(emitted[1]?.type).toBe("turn.terminal");
          // No usage_limit error emitted on T1 so "auto continue on reset" banner does not appear.
          if (emitted[1]?.type === "turn.terminal") {
            expect(emitted[1].status).toBe("completed");
          }

          const failover = yield* poolRegistry.takeFailover;
          expect(failover.sourceThreadId).toBe(threadId);
          expect(failover.targetMemberInstanceId).toBe(albertSnapshot.instanceId);
        }).pipe(Effect.provide(PoolRuntimeRegistry.layerMemory)),
      ),
  );

  it.effect(
    "surfaces usage_limit with the earliest reset across all accounts when the entire pool is depleted",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const poolRegistry = yield* PoolRuntimeRegistry.PoolRuntimeRegistry;
          const albertReset = "2099-01-01T01:30:00.000Z";
          const laReset = "2099-01-01T04:00:00.000Z";
          const albertSnapshot = makeMemberSnapshot("ag_albert", "Albert", 100, albertReset);
          const laSnapshot = makeMemberSnapshot("ag_la", "LA", 50, laReset);

          const albertEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const laEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const albert = makeFakeMemberInstance(albertSnapshot, albertEvents);
          const la = makeFakeMemberInstance(laSnapshot, laEvents);

          const byId = new Map<ProviderInstanceId, ProviderInstance>([
            [albertSnapshot.instanceId, albert.instance],
            [laSnapshot.instanceId, la.instance],
          ]);

          yield* poolRegistry.attachHost({
            getInstance: (id) => Effect.succeed(byId.get(id)),
            refreshInstance: () => Effect.void,
          });
          yield* poolRegistry.publishSnapshots([albertSnapshot, laSnapshot]);

          const pool = yield* PoolDriver.create({
            instanceId: ProviderInstanceId.make("pool_main"),
            displayName: "Pool",
            accentColor: undefined,
            environment: [],
            enabled: true,
            config: {
              memberDriver: "antigravity",
              memberInstanceIds: [albertSnapshot.instanceId, laSnapshot.instanceId],
            },
          });

          const session = yield* pool.orchestrationAdapter.openSession({
            threadId: ThreadId.make("thread-2"),
            providerSessionId: ProviderSessionId.make("ps-2"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("pool_main"),
              model: "gemini-4-neon",
            },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/tmp",
            },
          });

          // LA was the only non-depleted account; now LA hits usage_limit resetting at 04:00,
          // while Albert resets sooner at 01:30.
          yield* Queue.offer(laEvents, {
            type: "turn.terminal",
            driver: ProviderDriverKind.make("antigravity"),
            providerThreadId: ProviderThreadId.make("pt-1"),
            providerTurnId: ProviderTurnId.make("turn-1"),
            runOrdinal: PositiveInt.make(1),
            failureItemOrdinal: PositiveInt.make(1),
            status: "failed",
            failure: makeProviderFailure({
              class: "usage_limit",
              message: "Quota exhausted",
              resetAt: laReset,
            }),
            threadDisposition: "reusable",
          });

          const emitted = yield* session.events.pipe(Stream.take(1), Stream.runCollect);
          expect(emitted).toHaveLength(1);
          const terminal = emitted[0];
          expect(terminal?.type).toBe("turn.terminal");
          if (terminal?.type === "turn.terminal" && terminal.status === "failed") {
            expect(terminal.failure.class).toBe("usage_limit");
            expect(terminal.failure.resetAt).toBe(albertReset);
          } else {
            throw new Error("Expected failed usage_limit terminal event");
          }
        }).pipe(Effect.provide(PoolRuntimeRegistry.layerMemory)),
      ),
  );
});
