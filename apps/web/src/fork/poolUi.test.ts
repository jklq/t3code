import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { POOL_DRIVER_KIND } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { defaultPoolMemberIds } from "./PoolMembersSection";
import { resolveActivePoolMember, resolveSidebarPoolMember } from "./PoolProviderIcon";
import {
  clearPoolUsageCache,
  hydratePoolMembers,
  persistPoolMemberUsageSnapshots,
} from "./poolUsageCache";

const NOW = Date.parse("2026-11-24T01:00:00.000Z");

function makeProvider(
  id: string,
  driver: string,
  options: {
    displayName?: string;
    accentColor?: string;
    usedPercent?: number;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: options.displayName ?? id,
    ...(options.accentColor ? { accentColor: options.accentColor } : {}),
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: new Date(NOW).toISOString(),
    models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(options.usedPercent === undefined
      ? {}
      : {
          usageLimits: {
            checkedAt: new Date(NOW).toISOString(),
            windows: [
              {
                id: "gemini-5h",
                label: "Gemini · 5-hour",
                kind: "session",
                usedPercent: options.usedPercent,
                windowDurationMins: 300,
              },
            ],
          },
        }),
  };
}

describe("fork/pool web helpers", () => {
  it("resolves the bound account on active threads and the least-limited account on drafts", () => {
    const albert = makeProvider("ag_albert", "antigravity", {
      displayName: "Albert",
      accentColor: "#8a8a2e",
      usedPercent: 80,
    });
    const la = makeProvider("ag_la", "antigravity", {
      displayName: "LA",
      accentColor: "#2d7a46",
      usedPercent: 10,
    });
    const pool = makeProvider("pool_main", "pool", { displayName: "Pool" });

    const entries = deriveProviderInstanceEntries([pool, albert, la]);
    const poolEntry = entries.find((entry) => entry.driverKind === POOL_DRIVER_KIND)!;
    const providerInstances: ProviderInstanceConfigMap = {
      [pool.instanceId]: {
        driver: POOL_DRIVER_KIND,
        displayName: "Pool",
        enabled: true,
        config: {
          memberDriver: "antigravity",
          memberInstanceIds: [albert.instanceId, la.instanceId],
        },
      },
      [albert.instanceId]: {
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "Albert",
        accentColor: "#8a8a2e",
        enabled: true,
      },
      [la.instanceId]: {
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "LA",
        accentColor: "#2d7a46",
        enabled: true,
      },
    };

    // Draft thread: picks LA (10% used vs Albert's 80%).
    const draftMember = resolveActivePoolMember({
      poolEntry,
      selectedModel: "gemini-4-neon",
      reportedModelSelection: null,
      providerInstances,
      providerInstanceEntries: entries,
      now: NOW,
    });
    expect(draftMember?.instanceId).toBe(la.instanceId);
    expect(draftMember?.accentColor).toBe("#2d7a46");
    expect(draftMember?.isBoundToThread).toBe(false);

    // Server thread bound to Albert: sticks to Albert's icon & accent color even though LA has more headroom.
    const boundMember = resolveActivePoolMember({
      poolEntry,
      selectedModel: "gemini-4-neon",
      reportedModelSelection: { instanceId: albert.instanceId, model: "gemini-4-neon" },
      providerInstances,
      providerInstanceEntries: entries,
      now: NOW,
    });
    expect(boundMember?.instanceId).toBe(albert.instanceId);
    expect(boundMember?.accentColor).toBe("#8a8a2e");
    expect(boundMember?.isBoundToThread).toBe(true);
  });

  it("collects registered Antigravity instances as default pool members", () => {
    const albert = makeProvider("ag_albert", "antigravity", { displayName: "Albert" });
    const codex = makeProvider("codex", "codex", { displayName: "Codex" });
    const la = makeProvider("ag_la", "antigravity", { displayName: "LA" });

    const defaults = defaultPoolMemberIds(undefined, [codex, la, albert]);
    expect(defaults).toEqual([albert.instanceId, la.instanceId]);
  });

  it("resolves sidebar and composer bound members from activeProviderThreadId", () => {
    const albert = makeProvider("antigravity_antigravity_4", "antigravity", {
      displayName: "Albert",
      accentColor: "#ffe500",
      usedPercent: 80,
    });
    const la = makeProvider("antigravity_antigravity_2", "antigravity", {
      displayName: "langel",
      accentColor: "#00ff63",
      usedPercent: 10,
    });
    const pool = makeProvider("pool", "pool", {
      displayName: "Pool",
      accentColor: "#ff0000",
    });

    const entries = deriveProviderInstanceEntries([pool, albert, la]);
    const entryMap = new Map(entries.map((entry) => [entry.instanceId as string, entry] as const));
    const activeProviderThreadId =
      "provider-thread:provider:antigravity:provider-instance:antigravity_antigravity_4:native-thread:abc";

    const sidebarMember = resolveSidebarPoolMember({
      activeProviderThreadId,
      poolInstanceId: pool.instanceId,
      providerEntryByInstanceId: entryMap,
    });
    expect(sidebarMember?.instanceId).toBe(albert.instanceId);
    expect(sidebarMember?.accentColor).toBe("#ffe500");

    const poolEntry = entries.find((entry) => entry.driverKind === POOL_DRIVER_KIND)!;
    const composerFallback = resolveActivePoolMember({
      poolEntry,
      selectedModel: "gemini-4-neon",
      reportedModelSelection: null,
      activeProviderThreadId,
      providerInstances: {
        [pool.instanceId]: {
          driver: POOL_DRIVER_KIND,
          displayName: "Pool",
          accentColor: "#ff0000",
          enabled: true,
          config: {
            memberDriver: "antigravity",
            memberInstanceIds: [albert.instanceId, la.instanceId],
          },
        },
      },
      providerInstanceEntries: entries,
      now: NOW,
    });
    expect(composerFallback?.instanceId).toBe(albert.instanceId);
    expect(composerFallback?.isBoundToThread).toBe(true);
  });

  it("hydrates probeFailed members from cross-environment live data or persisted cache", () => {
    clearPoolUsageCache();
    const localEnv = EnvironmentId.make("local");
    const remoteEnv = EnvironmentId.make("home");

    const albertLive = makeProvider("ag_albert", "antigravity", {
      displayName: "Albert",
      accentColor: "#ffe500",
      usedPercent: 6,
    });
    const laLiveRemote = makeProvider("ag_la", "antigravity", {
      displayName: "langel",
      accentColor: "#00ff63",
      usedPercent: 20,
    });
    const mainLiveEarlier: ServerProvider = {
      ...makeProvider("ag_main", "antigravity", {
        displayName: "Main",
        accentColor: "#b07147",
        usedPercent: 40,
      }),
      usageLimits: {
        checkedAt: new Date(NOW - 6 * 60 * 60_000).toISOString(),
        windows: [
          {
            id: "gemini-5h",
            label: "Gemini · 5-hour",
            kind: "session",
            usedPercent: 40,
            windowDurationMins: 300,
            resetsAt: new Date(NOW - 60_000).toISOString(),
          },
        ],
      },
    };
    persistPoolMemberUsageSnapshots({
      environmentId: localEnv,
      members: [mainLiveEarlier],
    });

    const laFailedLocal: ServerProvider = {
      ...makeProvider("ag_la", "antigravity", { displayName: "langel" }),
      usageLimits: {
        checkedAt: new Date(NOW).toISOString(),
        windows: [],
        unavailable: { reason: "probeFailed", message: "Expired" },
      },
    };
    const mainFailedLocal: ServerProvider = {
      ...makeProvider("ag_main", "antigravity", { displayName: "Main" }),
      usageLimits: {
        checkedAt: new Date(NOW).toISOString(),
        windows: [],
        unavailable: { reason: "probeFailed", message: "Expired" },
      },
    };

    const hydrated = hydratePoolMembers({
      environmentId: localEnv,
      memberIds: [albertLive.instanceId, laFailedLocal.instanceId, mainFailedLocal.instanceId],
      providerStatuses: [albertLive, laFailedLocal, mainFailedLocal],
      allEnvironmentProviders: new Map([
        [localEnv, [albertLive, laFailedLocal, mainFailedLocal]],
        [remoteEnv, [laLiveRemote]],
      ]),
      providerInstances: {
        [laFailedLocal.instanceId]: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "langel",
          accentColor: "#00ff63",
          enabled: true,
        },
        [mainFailedLocal.instanceId]: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "Main",
          accentColor: "#b07147",
          enabled: true,
        },
      },
      now: NOW,
    });

    expect(hydrated.memberStatusByKey.get(`${localEnv}:${albertLive.instanceId}`)).toBe("live");
    expect(hydrated.memberStatusByKey.get(`${localEnv}:${laFailedLocal.instanceId}`)).toBe("live");
    expect(hydrated.memberStatusByKey.get(`${localEnv}:${mainFailedLocal.instanceId}`)).toBe(
      "cached",
    );
    expect(hydrated.members[1]?.usageLimits?.windows[0]?.usedPercent).toBe(20);
    // Main's cached 5h window had resetsAt in the past, so it rolls forward to 0% used.
    expect(hydrated.members[2]?.usageLimits?.windows[0]?.usedPercent).toBe(0);
    expect(hydrated.members[1]?.accentColor).toBe("#00ff63");
    expect(hydrated.members[2]?.accentColor).toBe("#b07147");
    clearPoolUsageCache();
  });
});
