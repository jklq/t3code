import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  computeCombinedPoolWindowMetrics,
  extractBoundPoolMemberFromProviderThreadId,
  findPoolChatWindows,
  findPoolFiveHourWindow,
  findPoolWeeklyWindow,
  intersectPoolModels,
  parsePoolConfig,
  poolCooldownKey,
  rolloverExpiredUsageLimits,
  selectPoolMember,
} from "./pool.ts";

const NOW = Date.parse("2026-11-24T01:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeAntigravityMember(
  id: string,
  options: {
    displayName?: string;
    accentColor?: string;
    status?: ServerProvider["status"];
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    models?: ServerProvider["models"];
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: options.displayName ?? id,
    ...(options.accentColor ? { accentColor: options.accentColor } : {}),
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: options.status ?? "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: iso(NOW),
    models: options.models ?? [
      {
        slug: "gemini-4-neon",
        name: "Gemini 4 Neon",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...(options.windows
      ? {
          usageLimits: {
            checkedAt: iso(NOW),
            windows: [...options.windows],
          },
        }
      : {}),
  };
}

describe("fork/pool", () => {
  it("parses and deduplicates pool configs safely", () => {
    const parsed = parsePoolConfig({
      memberInstanceIds: ["ag_1", "ag_2", "ag_1"],
    });
    expect(parsed.memberDriver).toBe("antigravity");
    expect(parsed.memberInstanceIds).toEqual([
      ProviderInstanceId.make("ag_1"),
      ProviderInstanceId.make("ag_2"),
    ]);
  });

  it("picks the account with the least usage limits for the selected model family", () => {
    const albert = makeAntigravityMember("ag_albert", {
      displayName: "Albert",
      windows: [
        { id: "gemini-5h", label: "Gemini · 5-hour", kind: "session", usedPercent: 60 },
        { id: "gemini-weekly", label: "Gemini · Weekly", kind: "weekly", usedPercent: 20 },
        { id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", kind: "session", usedPercent: 5 },
      ],
    });
    const la = makeAntigravityMember("ag_la", {
      displayName: "LA",
      windows: [
        { id: "gemini-5h", label: "Gemini · 5-hour", kind: "session", usedPercent: 10 },
        { id: "gemini-weekly", label: "Gemini · Weekly", kind: "weekly", usedPercent: 15 },
        { id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", kind: "session", usedPercent: 80 },
      ],
    });
    const main = makeAntigravityMember("ag_main", {
      displayName: "Main",
      windows: [
        { id: "gemini-5h", label: "Gemini · 5-hour", kind: "session", usedPercent: 0 },
        { id: "gemini-weekly", label: "Gemini · Weekly", kind: "weekly", usedPercent: 90 },
      ],
    });

    // For Gemini: Main's weekly bottleneck is 90%, Albert's 5h is 60%, LA's bottleneck is 15% -> LA wins.
    const geminiPick = selectPoolMember({
      members: [albert, la, main],
      model: "gemini-4-neon",
      now: NOW,
    });
    expect(geminiPick.allDepleted).toBe(false);
    expect(geminiPick.selected?.instanceId).toBe(la.instanceId);

    // For Claude (3p): Albert has 5% used vs LA's 80% -> Albert wins.
    const claudePick = selectPoolMember({
      members: [albert, la],
      model: "claude-sonnet-4-6",
      now: NOW,
    });
    expect(claudePick.allDepleted).toBe(false);
    expect(claudePick.selected?.instanceId).toBe(albert.instanceId);
  });

  it("skips depleted and cooled-down accounts and picks the quickest renewal when all are depleted", () => {
    const resetIn45m = iso(NOW + 45 * 60_000);
    const resetIn2h = iso(NOW + 120 * 60_000);
    const resetIn5d = iso(NOW + 5 * 24 * 60 * 60_000);

    const albert = makeAntigravityMember("ag_albert", {
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: 100,
          resetsAt: resetIn2h,
        },
      ],
    });
    const la = makeAntigravityMember("ag_la", {
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: 100,
          resetsAt: resetIn45m,
        },
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          kind: "weekly",
          usedPercent: 100,
          resetsAt: resetIn5d,
        },
      ],
    });
    const main = makeAntigravityMember("ag_main", {
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: 0,
        },
      ],
    });

    // Main is still available even though Albert & LA are depleted.
    const availablePick = selectPoolMember({
      members: [albert, la, main],
      model: "gemini-4-neon",
      now: NOW,
    });
    expect(availablePick.allDepleted).toBe(false);
    expect(availablePick.selected?.instanceId).toBe(main.instanceId);

    // Once Main also hits a cooldown expiring in 30m, all are depleted and Main renews quickest.
    const resetIn30m = NOW + 30 * 60_000;
    const cooldowns = new Map([[poolCooldownKey(main.instanceId, "gemini"), resetIn30m]]);
    const allDepletedPick = selectPoolMember({
      members: [albert, la, main],
      model: "gemini-4-neon",
      now: NOW,
      cooldowns,
    });
    expect(allDepletedPick.allDepleted).toBe(true);
    expect(allDepletedPick.quickestResetMember?.instanceId).toBe(main.instanceId);
    expect(allDepletedPick.earliestResetAt).toBe(iso(resetIn30m));

    // Without Main, LA's weekly reset is 5d away while Albert's 5h reset is 2h away -> Albert wins.
    const albertVsLa = selectPoolMember({
      members: [albert, la],
      model: "gemini-4-neon",
      now: NOW,
    });
    expect(albertVsLa.allDepleted).toBe(true);
    expect(albertVsLa.quickestResetMember?.instanceId).toBe(albert.instanceId);
    expect(albertVsLa.earliestResetAt).toBe(resetIn2h);
  });

  it("intersects shared models and keeps thinking levels observed by another member", () => {
    const first = makeAntigravityMember("ag_1", {
      models: [
        { slug: ANTIGRAVITY_DEFAULT_MODEL, name: "Default", isCustom: false, capabilities: null },
        { slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null },
        { slug: "gemini-3-flash", name: "Gemini 3 Flash", isCustom: false, capabilities: null },
      ],
    });
    const second = makeAntigravityMember("ag_2");
    const loading = makeAntigravityMember("ag_3", { models: [] });

    const shared = intersectPoolModels([first, second, loading]);
    expect(shared.map((m) => m.slug)).toEqual(["gemini-4-neon"]);
    expect(shared[0]?.capabilities).toEqual(second.models[0]?.capabilities);
  });

  it("computes combined remaining and combined pace across all accounts in a bucket", () => {
    // 4 accounts: Albert spent 100% in 1h (80% of 5h window left), 3 accounts untouched (100% left, 0% elapsed).
    // Combined left = 75%. Combined time left = (80% + 100% + 100% + 100%) / 4 = 95%.
    // 75% left vs 95% time left -> spending ahead of pace ("ahead").
    const makeAccount = (
      id: string,
      usedPercent: number,
      resetsAt?: string,
      accentColor?: string,
    ): LimitAccount => ({
      key: `env:${id}`,
      driver: ProviderDriverKind.make("antigravity"),
      displayName: id,
      email: `${id}@example.com`,
      plan: undefined,
      accentColor,
      environments: [{ environmentId: EnvironmentId.make("env"), label: "Local" }],
      sourceLabel: null,
      redeem: null,
      limits: {
        checkedAt: iso(NOW),
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
    });

    const accounts = [
      makeAccount("Albert", 100, iso(NOW + 4 * 60 * 60_000), "#8a8a2e"),
      makeAccount("LA", 0, iso(NOW + 5 * 60 * 60_000), "#2d7a46"),
      makeAccount("Main", 0, undefined, "#7a5a2d"),
      makeAccount("musematten", 0, undefined, "#7a2d7a"),
    ];
    const [pool] = collectLimitPools(accounts, NOW);
    const window = pool!.windows[0]!;
    const metrics = computeCombinedPoolWindowMetrics(window, NOW);

    expect(metrics.remainingPercent).toBe(75);
    expect(metrics.combinedTimeLeftPercent).toBe(95);
    expect(metrics.pace).toBe("ahead");
    expect(metrics.segments).toHaveLength(4);
    expect(metrics.segments.reduce((sum, seg) => sum + seg.widthPercent, 0)).toBeCloseTo(75, 5);
    expect(metrics.nextReset?.member.account.displayName).toBe("Albert");
    expect(
      computeCombinedPoolWindowMetrics(window, NOW + 4 * 60 * 60_000).nextReset?.member.account
        .displayName,
    ).toBe("LA");
    expect(computeCombinedPoolWindowMetrics(window, NOW + 5 * 60 * 60_000).nextReset).toBeNull();
  });

  it("finds the matching 5-hour and weekly windows for the selected pool model", () => {
    const member = makeAntigravityMember("ag_albert", {
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: 20,
          windowDurationMins: 300,
        },
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          kind: "weekly",
          usedPercent: 35,
          windowDurationMins: 10_080,
        },
        {
          id: "3p-5h",
          label: "Claude & GPT (shared) · 5-hour",
          kind: "session",
          usedPercent: 50,
          windowDurationMins: 300,
        },
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          kind: "weekly",
          usedPercent: 65,
          windowDurationMins: 10_080,
        },
      ],
    });

    const geminiWindows = findPoolChatWindows({
      environmentId: EnvironmentId.make("env"),
      members: [member],
      model: "gemini-4-neon",
      now: NOW,
    });
    expect(geminiWindows.fiveHour?.id).toBe("gemini-5h");
    expect(geminiWindows.weekly?.id).toBe("gemini-weekly");
    expect(
      findPoolFiveHourWindow({
        environmentId: EnvironmentId.make("env"),
        members: [member],
        model: "gemini-4-neon",
        now: NOW,
      })?.id,
    ).toBe("gemini-5h");
    expect(
      findPoolWeeklyWindow({
        environmentId: EnvironmentId.make("env"),
        members: [member],
        model: "gemini-4-neon",
        now: NOW,
      })?.id,
    ).toBe("gemini-weekly");

    const claudeWindows = findPoolChatWindows({
      environmentId: EnvironmentId.make("env"),
      members: [member],
      model: "claude-sonnet-4-6",
      now: NOW,
    });
    expect(claudeWindows.fiveHour?.id).toBe("3p-5h");
    expect(claudeWindows.weekly?.id).toBe("3p-weekly");
  });

  it("extracts bound member instance ids from activeProviderThreadId", () => {
    expect(
      extractBoundPoolMemberFromProviderThreadId(
        "provider-thread:provider:antigravity:provider-instance:antigravity_antigravity_4:native-thread:abc-123",
      ),
    ).toBe("antigravity_antigravity_4");
    expect(
      extractBoundPoolMemberFromProviderThreadId(
        "provider-thread:provider:antigravity:native-thread:abc-123",
      ),
    ).toBe("antigravity");
    expect(
      extractBoundPoolMemberFromProviderThreadId(
        "provider-thread:provider:pool:provider-instance:pool:native-thread:abc-123",
      ),
    ).toBeNull();
    expect(extractBoundPoolMemberFromProviderThreadId(null)).toBeNull();
  });

  it("rolls forward expired cached windows and keeps unavailable members in the stacked bar", () => {
    const rolled = rolloverExpiredUsageLimits(
      {
        checkedAt: iso(NOW - 6 * 60 * 60_000),
        windows: [
          {
            id: "gemini-5h",
            label: "Gemini · 5-hour",
            kind: "session",
            usedPercent: 85,
            windowDurationMins: 300,
            resetsAt: iso(NOW - 60_000),
          },
          {
            id: "gemini-weekly",
            label: "Gemini · Weekly",
            kind: "weekly",
            usedPercent: 25,
            windowDurationMins: 10_080,
            resetsAt: iso(NOW + 2 * 24 * 60 * 60_000),
          },
        ],
      },
      NOW,
    );
    expect(rolled.windows[0]?.usedPercent).toBe(0);
    expect(rolled.windows[0]?.resetsAt).toBeUndefined();
    expect(rolled.windows[1]?.usedPercent).toBe(25);

    const albert = makeAntigravityMember("ag_albert", {
      displayName: "Albert",
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: 6,
          windowDurationMins: 300,
          resetsAt: iso(NOW + 66 * 60_000),
        },
      ],
    });
    const langel: ServerProvider = {
      ...makeAntigravityMember("ag_langel", { displayName: "langel", windows: [] }),
      accentColor: "#00ff63",
      usageLimits: {
        checkedAt: iso(NOW),
        windows: [],
        unavailable: { reason: "probeFailed", message: "Expired" },
      },
    };
    const result = findPoolChatWindows({
      environmentId: EnvironmentId.make("env"),
      members: [albert, langel],
      model: "gemini-4-neon",
      now: NOW,
      accentColorOverrides: new Map([[albert.instanceId, "#ffe500"]]),
    });
    expect(result.fiveHour).not.toBeNull();
    expect(result.unavailableMembers).toEqual([
      { key: "env:ag_langel", displayName: "langel", accentColor: "#00ff63" },
    ]);

    const metrics = computeCombinedPoolWindowMetrics(result.fiveHour!, NOW, {
      unavailableMembers: result.unavailableMembers,
      memberKeyOrder: result.memberKeyOrder,
    });
    expect(metrics.totalMemberCount).toBe(2);
    expect(metrics.knownMemberCount).toBe(1);
    expect(metrics.remainingPercent).toBe(94);
    expect(metrics.filledPercent).toBeCloseTo(47, 5);
    expect(metrics.segments).toHaveLength(2);
    expect(metrics.segments[0]?.accentColor).toBe("#ffe500");
    expect(metrics.segments[0]?.status).toBe("live");
    expect(metrics.segments[1]?.accentColor).toBe("#00ff63");
    expect(metrics.segments[1]?.status).toBe("unavailable");
    expect(metrics.segments[1]?.slotWidthPercent).toBeCloseTo(50, 5);
  });
});
