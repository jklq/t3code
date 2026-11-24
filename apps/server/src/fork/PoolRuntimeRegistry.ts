import type { ProviderInstanceId, ServerProvider, ThreadId } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { type AntigravityModelFamily, poolCooldownKey } from "@t3tools/shared/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

export interface PoolThreadBinding {
  readonly poolInstanceId: ProviderInstanceId;
  readonly memberInstanceId: ProviderInstanceId;
  readonly updatedAt: string;
}

export interface PoolFailoverRequest {
  readonly sourceThreadId: ThreadId;
  readonly poolInstanceId: ProviderInstanceId;
  readonly targetMemberInstanceId: ProviderInstanceId;
  readonly failedMemberLabel: string;
  readonly targetMemberLabel: string;
  readonly runOrdinal: number;
  readonly chainDepth: number;
}

interface PersistedPoolState {
  readonly threadBindings: Record<string, PoolThreadBinding>;
  readonly cooldowns: Record<string, number>;
  readonly failoverDepths: Record<string, number>;
}

const EMPTY_STATE: PersistedPoolState = {
  threadBindings: {},
  cooldowns: {},
  failoverDepths: {},
};

const PersistedPoolStateSchema = Schema.Struct({
  threadBindings: Schema.Record(
    Schema.String,
    Schema.Struct({
      poolInstanceId: Schema.String,
      memberInstanceId: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
  cooldowns: Schema.Record(Schema.String, Schema.Number),
  failoverDepths: Schema.Record(Schema.String, Schema.Number),
});
const decodePersistedState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedPoolStateSchema),
);

const MAX_PERSISTED_BINDINGS = 512;

function pruneState(state: PersistedPoolState, nowMs: number): PersistedPoolState {
  const cooldowns: Record<string, number> = {};
  for (const [key, until] of Object.entries(state.cooldowns)) {
    if (Number.isFinite(until) && until > nowMs) {
      cooldowns[key] = until;
    }
  }
  const entries = Object.entries(state.threadBindings);
  const kept =
    entries.length <= MAX_PERSISTED_BINDINGS
      ? entries
      : entries
          .toSorted(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, MAX_PERSISTED_BINDINGS);
  const keptIds = new Set(kept.map(([id]) => id));
  const failoverDepths: Record<string, number> = {};
  for (const [id, depth] of Object.entries(state.failoverDepths)) {
    if (keptIds.has(id) && depth > 0) failoverDepths[id] = depth;
  }
  return {
    threadBindings: Object.fromEntries(kept),
    cooldowns,
    failoverDepths,
  };
}

export interface PoolRuntimeRegistryHost {
  readonly getInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstance | undefined>;
  readonly refreshInstance: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

export interface PoolRuntimeRegistryShape {
  readonly attachHost: (host: PoolRuntimeRegistryHost) => Effect.Effect<void>;
  readonly publishSnapshots: (snapshots: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  readonly getSnapshots: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly streamSnapshots: Stream.Stream<ReadonlyArray<ServerProvider>>;
  readonly getMemberInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstance | undefined>;
  readonly refreshMemberInstance: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
  readonly getThreadBinding: (threadId: ThreadId) => Effect.Effect<PoolThreadBinding | undefined>;
  readonly setThreadBinding: (input: {
    readonly threadId: ThreadId;
    readonly poolInstanceId: ProviderInstanceId;
    readonly memberInstanceId: ProviderInstanceId;
  }) => Effect.Effect<void>;
  readonly getFailoverDepth: (threadId: ThreadId) => Effect.Effect<number>;
  readonly setFailoverDepth: (threadId: ThreadId, depth: number) => Effect.Effect<void>;
  readonly getCooldowns: (nowMs: number) => Effect.Effect<ReadonlyMap<string, number>>;
  readonly recordCooldown: (input: {
    readonly memberInstanceId: ProviderInstanceId;
    readonly family: AntigravityModelFamily | "all";
    readonly resetAtMs: number;
  }) => Effect.Effect<void>;
  readonly enqueueFailover: (request: PoolFailoverRequest) => Effect.Effect<void>;
  readonly takeFailover: Effect.Effect<PoolFailoverRequest>;
}

export class PoolRuntimeRegistry extends Context.Service<
  PoolRuntimeRegistry,
  PoolRuntimeRegistryShape
>()("t3/fork/PoolRuntimeRegistry") {}

const makeRegistryFromState = Effect.fn("PoolRuntimeRegistry.make")(function* (
  initialState: PersistedPoolState,
  persist: (next: PersistedPoolState) => Effect.Effect<void>,
) {
  const snapshotsRef = yield* SubscriptionRef.make<ReadonlyArray<ServerProvider>>([]);
  const hostRef = yield* Ref.make<PoolRuntimeRegistryHost | null>(null);
  const failoverQueue = yield* Queue.unbounded<PoolFailoverRequest>();
  const stateRef = yield* Ref.make<PersistedPoolState>(initialState);

  const updateState = Effect.fn("PoolRuntimeRegistry.updateState")(function* (
    fn: (current: PersistedPoolState, nowMs: number) => PersistedPoolState,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const next = yield* Ref.updateAndGet(stateRef, (current) =>
      pruneState(fn(current, nowMs), nowMs),
    );
    yield* persist(next);
  });

  return PoolRuntimeRegistry.of({
    attachHost: Effect.fn("PoolRuntimeRegistry.attachHost")((host: PoolRuntimeRegistryHost) =>
      Ref.set(hostRef, host),
    ),
    publishSnapshots: Effect.fn("PoolRuntimeRegistry.publishSnapshots")(
      (snapshots: ReadonlyArray<ServerProvider>) => SubscriptionRef.set(snapshotsRef, snapshots),
    ),
    getSnapshots: SubscriptionRef.get(snapshotsRef),
    streamSnapshots: SubscriptionRef.changes(snapshotsRef),
    getMemberInstance: Effect.fn("PoolRuntimeRegistry.getMemberInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const host = yield* Ref.get(hostRef);
      if (host === null) return undefined;
      return yield* host.getInstance(instanceId);
    }),
    refreshMemberInstance: Effect.fn("PoolRuntimeRegistry.refreshMemberInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const host = yield* Ref.get(hostRef);
      if (host === null) return;
      yield* host.refreshInstance(instanceId);
    }),
    getThreadBinding: Effect.fn("PoolRuntimeRegistry.getThreadBinding")((threadId: ThreadId) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.threadBindings[threadId])),
    ),
    setThreadBinding: Effect.fn("PoolRuntimeRegistry.setThreadBinding")(function* ({
      threadId,
      poolInstanceId,
      memberInstanceId,
    }: {
      readonly threadId: ThreadId;
      readonly poolInstanceId: ProviderInstanceId;
      readonly memberInstanceId: ProviderInstanceId;
    }) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* updateState((current) => ({
        ...current,
        threadBindings: {
          ...current.threadBindings,
          [threadId]: { poolInstanceId, memberInstanceId, updatedAt },
        },
      }));
    }),
    getFailoverDepth: Effect.fn("PoolRuntimeRegistry.getFailoverDepth")((threadId: ThreadId) =>
      Ref.get(stateRef).pipe(Effect.map((state) => state.failoverDepths[threadId] ?? 0)),
    ),
    setFailoverDepth: Effect.fn("PoolRuntimeRegistry.setFailoverDepth")(
      (threadId: ThreadId, depth: number) =>
        updateState((current) => ({
          ...current,
          failoverDepths: {
            ...current.failoverDepths,
            [threadId]: depth,
          },
        })),
    ),
    getCooldowns: Effect.fn("PoolRuntimeRegistry.getCooldowns")((nowMs: number) =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const active = new Map<string, number>();
          for (const [key, until] of Object.entries(state.cooldowns)) {
            if (until > nowMs) active.set(key, until);
          }
          return active;
        }),
      ),
    ),
    recordCooldown: Effect.fn("PoolRuntimeRegistry.recordCooldown")(
      ({
        memberInstanceId,
        family,
        resetAtMs,
      }: {
        readonly memberInstanceId: ProviderInstanceId;
        readonly family: AntigravityModelFamily | "all";
        readonly resetAtMs: number;
      }) =>
        updateState((current) => {
          const key = poolCooldownKey(memberInstanceId, family);
          const existing = current.cooldowns[key] ?? 0;
          if (resetAtMs <= existing) return current;
          return {
            ...current,
            cooldowns: { ...current.cooldowns, [key]: resetAtMs },
          };
        }),
    ),
    enqueueFailover: Effect.fn("PoolRuntimeRegistry.enqueueFailover")(
      (request: PoolFailoverRequest) => Queue.offer(failoverQueue, request).pipe(Effect.asVoid),
    ),
    takeFailover: Queue.take(failoverQueue),
  });
});

export const makeMemoryPoolRuntimeRegistry = Effect.fn("PoolRuntimeRegistry.makeMemory")(
  function* () {
    return yield* makeRegistryFromState(EMPTY_STATE, () => Effect.void);
  },
);

const makePersistedPoolRuntimeRegistry = Effect.fn("PoolRuntimeRegistry.makePersisted")(function* (
  persistPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;

  let initialState = EMPTY_STATE;
  const raw = yield* fileSystem.readFileString(persistPath).pipe(Effect.orElseSucceed(() => null));
  if (raw !== null) {
    const decoded = decodePersistedState(raw);
    if (decoded._tag === "Some") {
      initialState = {
        threadBindings: Object.fromEntries(
          Object.entries(decoded.value.threadBindings).map(([id, binding]) => [
            id,
            {
              poolInstanceId: binding.poolInstanceId as ProviderInstanceId,
              memberInstanceId: binding.memberInstanceId as ProviderInstanceId,
              updatedAt: binding.updatedAt,
            },
          ]),
        ),
        cooldowns: { ...decoded.value.cooldowns },
        failoverDepths: { ...decoded.value.failoverDepths },
      };
    }
  }

  return yield* makeRegistryFromState(initialState, (next) =>
    writeFileStringAtomically({
      filePath: persistPath,
      contents: JSON.stringify(next, null, 2),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.ignoreCause({ log: true }),
    ),
  );
});

export const layer: Layer.Layer<
  PoolRuntimeRegistry,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  PoolRuntimeRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makePersistedPoolRuntimeRegistry(
      path.join(config.stateDir, "fork-pool-state.json"),
    );
  }),
);

export const layerMemory: Layer.Layer<PoolRuntimeRegistry> = Layer.effect(
  PoolRuntimeRegistry,
  makeMemoryPoolRuntimeRegistry(),
);
