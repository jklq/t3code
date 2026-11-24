import "~/index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { POOL_DRIVER_KIND } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { ChatPoolUsageBar } from "./CombinedPoolBar";
import { PoolProviderIcon, SidebarPoolProviderIcon } from "./PoolProviderIcon";
import { clearPoolUsageCache } from "./poolUsageCache";

const NOW_ISO = "2026-11-24T01:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

function makeMember(
  id: string,
  options: {
    displayName: string;
    accentColor?: string;
    sessionUsed: number;
    weeklyUsed: number;
    sessionResetsAt?: string;
    weeklyResetsAt?: string;
  },
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("antigravity"),
    displayName: options.displayName,
    ...(options.accentColor ? { accentColor: options.accentColor } : {}),
    enabled: true,
    installed: true,
    version: "1.5.0",
    status: "ready",
    auth: { status: "authenticated", email: `${id}@example.com` },
    checkedAt: NOW_ISO,
    models: [{ slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: NOW_ISO,
      windows: [
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          kind: "session",
          usedPercent: options.sessionUsed,
          windowDurationMins: 300,
          ...(options.sessionResetsAt ? { resetsAt: options.sessionResetsAt } : {}),
        },
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          kind: "weekly",
          usedPercent: options.weeklyUsed,
          windowDurationMins: 10_080,
          ...(options.weeklyResetsAt ? { resetsAt: options.weeklyResetsAt } : {}),
        },
      ],
    },
  };
}

describe("fork/pool browser UI", () => {
  it("renders dual-corner Pool and active member badges opaquely without overlapping in composer and sidebar sizes", async () => {
    const albertId = ProviderInstanceId.make("ag_albert");
    const poolId = ProviderInstanceId.make("pool_main");
    const providerMap = new Map([
      [poolId as string, { instanceId: poolId, displayName: "Pool", accentColor: "#ff0000" }],
      [albertId as string, { instanceId: albertId, displayName: "Albert", accentColor: "#ffe500" }],
    ]);

    await using screen = await render(
      <div className="flex items-center gap-6 p-6">
        <PoolProviderIcon
          poolDisplayName="Pool"
          poolAccentColor="#ff0000"
          activeMember={{
            instanceId: albertId,
            displayName: "Albert",
            accentColor: "#ffe500",
            isBoundToThread: true,
          }}
          className="size-4"
        />
        <SidebarPoolProviderIcon
          activeProviderThreadId={`provider-thread:provider:antigravity:provider-instance:${albertId}:native-thread:t1`}
          poolEntry={{ instanceId: poolId, displayName: "Pool", accentColor: "#ff0000" }}
          providerEntryByInstanceId={providerMap}
        />
        <PoolProviderIcon
          poolDisplayName="Pool"
          poolAccentColor="#ff0000"
          activeMember={{
            instanceId: ProviderInstanceId.make("ag_main"),
            displayName: "Main",
            accentColor: undefined,
            isBoundToThread: false,
          }}
          className="size-4"
        />
      </div>,
    );

    const icons = [...screen.container.querySelectorAll<HTMLElement>('[data-pool-icon="true"]')];
    expect(icons).toHaveLength(3);

    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const iconRoot of icons) {
        const glyphWrapper = iconRoot.firstElementChild as HTMLElement | null;
        const poolBadge = iconRoot.querySelector<HTMLElement>('[data-pool-badge="true"]');
        const memberBadge = iconRoot.querySelector<HTMLElement>('[data-pool-active-badge="true"]');
        expect(glyphWrapper).not.toBeNull();
        expect(poolBadge).not.toBeNull();
        expect(memberBadge).not.toBeNull();

        const glyphZ = Number.parseInt(getComputedStyle(glyphWrapper!).zIndex || "0", 10);
        for (const badge of [poolBadge!, memberBadge!]) {
          const badgeZ = Number.parseInt(getComputedStyle(badge).zIndex || "0", 10);
          expect(badgeZ).toBeGreaterThan(glyphZ);
          const badgeStyles = getComputedStyle(badge);
          expect(badgeStyles.opacity).toBe("1");
          expect(badgeStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
          expect(badgeStyles.backgroundColor).not.toBe("transparent");
          expect(badgeStyles.backgroundColor).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\s*\)/);
          expect(badgeStyles.backgroundColor).not.toMatch(/\/\s*0(\.\d+)?\s*\)/);
        }

        // Top-left pool badge and bottom-right member badge must not intersect.
        const poolRect = poolBadge!.getBoundingClientRect();
        const memberRect = memberBadge!.getBoundingClientRect();
        const separated =
          poolRect.right <= memberRect.left + 0.5 || poolRect.bottom <= memberRect.top + 0.5;
        expect(separated).toBe(true);
      }
    }
    document.documentElement.classList.remove("dark");
  });

  it("renders both 5-hour and weekly combined bars under the chat input with all pool member colors", async () => {
    clearPoolUsageCache();
    const albert = makeMember("ag_albert", {
      displayName: "Albert",
      accentColor: "#ffe500",
      sessionUsed: 40,
      weeklyUsed: 20,
      sessionResetsAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
      weeklyResetsAt: new Date(NOW + 3 * 24 * 60 * 60_000).toISOString(),
    });
    const la = makeMember("ag_la", {
      displayName: "langel",
      accentColor: "#00ff63",
      sessionUsed: 0,
      weeklyUsed: 10,
    });
    const mainExpired: ServerProvider = {
      ...makeMember("ag_main", {
        displayName: "Main",
        accentColor: "#b07147",
        sessionUsed: 0,
        weeklyUsed: 0,
      }),
      usageLimits: {
        checkedAt: NOW_ISO,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Expired" },
      },
    };
    const poolId = ProviderInstanceId.make("pool_main");
    const providerInstances: ProviderInstanceConfigMap = {
      [poolId]: {
        driver: POOL_DRIVER_KIND,
        displayName: "Pool",
        accentColor: "#ff0000",
        enabled: true,
        config: {
          memberDriver: "antigravity",
          memberInstanceIds: [albert.instanceId, la.instanceId, mainExpired.instanceId],
        },
      },
    };

    await using screen = await render(
      <div className="w-[520px] p-4">
        <ChatPoolUsageBar
          environmentId={EnvironmentId.make("env")}
          poolInstanceId={poolId}
          selectedModel="gemini-4-neon"
          providerInstances={providerInstances}
          providerStatuses={[albert, la, mainExpired]}
        />
      </div>,
    );

    await expect.element(screen.getByText("Gemini · 5h")).toBeVisible();
    await expect.element(screen.getByText("Gemini · Weekly")).toBeVisible();
    await expect.element(screen.getByText("80%")).toBeVisible();
    await expect.element(screen.getByText("85%")).toBeVisible();

    const bars = [
      ...screen.container.querySelectorAll<HTMLElement>('[data-combined-pool-bar="true"]'),
    ];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      const liveSegments = bar.querySelectorAll<HTMLElement>('[data-pool-segment="live"]');
      const unavailableSegments = bar.querySelectorAll<HTMLElement>(
        '[data-pool-segment="unavailable"]',
      );
      expect(liveSegments).toHaveLength(2);
      expect(unavailableSegments).toHaveLength(1);
    }
    const fiveHourRect = bars[0]!.getBoundingClientRect();
    const weeklyRect = bars[1]!.getBoundingClientRect();
    expect(fiveHourRect.width).toBeGreaterThan(100);
    expect(Math.abs(fiveHourRect.left - weeklyRect.left)).toBeLessThan(1);
    expect(Math.abs(fiveHourRect.width - weeklyRect.width)).toBeLessThan(1);
    clearPoolUsageCache();
  });
});
