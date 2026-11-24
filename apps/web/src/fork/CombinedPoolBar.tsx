import type {
  EnvironmentId,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  computeCombinedPoolWindowMetrics,
  type CombinedPoolWindowMetricsOptions,
  findPoolChatWindows,
  type LimitPoolWindow,
  parsePoolConfig,
  POOL_DRIVER_KIND,
} from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";
import { Fragment, useEffect } from "react";

import { useNowMinute } from "../hooks/useNowMinute";
import { usePrimarySettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { useEnvironmentProviders } from "../state/environments";
import { formatUpcomingTimestamp } from "../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { barColor, PaceIcon, usePaceMark } from "../components/usage/UsageLimits";
import { hydratePoolMembers, persistPoolMemberUsageSnapshots } from "./poolUsageCache";

function CombinedBarTrack({
  pool,
  color,
  now,
  compact = false,
  metricsOptions,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly compact?: boolean;
  readonly metricsOptions?: CombinedPoolWindowMetricsOptions | undefined;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const metrics = computeCombinedPoolWindowMetrics(pool, now, metricsOptions);
  const [barRef, paceMark] = usePaceMark(metrics.combinedTimeLeftPercent);

  const nextReset = metrics.nextReset;
  const nextResetIn = nextReset ? formatResetsIn(nextReset.member.window, now, m, "in") : null;
  const nextResetAt = nextReset?.member.window.resetsAt
    ? formatUpcomingTimestamp(nextReset.member.window.resetsAt, timestampFormat, now, undefined, m)
    : null;

  const knownSegments = metrics.segments.filter(
    (segment) => segment.status !== "unavailable" && segment.widthPercent > 0,
  );
  const unavailableSegments = metrics.segments.filter(
    (segment) => segment.status === "unavailable" && segment.slotWidthPercent > 0,
  );
  const knownWidthSum = knownSegments.reduce((sum, segment) => sum + segment.widthPercent, 0);
  const unavailableWidthSum = unavailableSegments.reduce(
    (sum, segment) => sum + segment.slotWidthPercent,
    0,
  );
  const availableTrackForUnavailable = Math.max(0, 100 - metrics.filledPercent);
  const unavailableContainerWidth = Math.min(availableTrackForUnavailable, unavailableWidthSum);

  const ariaLabel =
    metrics.combinedTimeLeftPercent !== null
      ? gt("Combined {label}: {remaining}% left, {timeLeft}% of combined window left", {
          label: pool.label,
          remaining: metrics.remainingPercent,
          timeLeft: metrics.combinedTimeLeftPercent,
        })
      : gt("Combined {label}: {remaining}% left", {
          label: pool.label,
          remaining: metrics.remainingPercent,
        });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={barRef}
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            data-combined-pool-bar="true"
            className={cn(
              "relative min-w-0 cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              compact ? "h-4 w-full rounded-full" : "h-3.5 w-full rounded-md",
            )}
          />
        }
      >
        <div
          className={cn(
            "absolute inset-0 overflow-hidden",
            compact ? "rounded-full" : "rounded-md",
          )}
          style={paceMark?.gap}
        >
          <div
            className={cn(
              "absolute inset-x-0 bg-muted",
              compact ? "inset-y-1 rounded-full" : "inset-y-0 rounded-md",
            )}
          />
          {metrics.filledPercent > 0 && knownWidthSum > 0 ? (
            <div
              className={cn(
                "absolute left-0 flex overflow-hidden",
                compact
                  ? unavailableContainerWidth > 0
                    ? "inset-y-1 rounded-l-full"
                    : "inset-y-1 rounded-full"
                  : unavailableContainerWidth > 0
                    ? "inset-y-0 rounded-l-md"
                    : "inset-y-0 rounded-md",
              )}
              style={{ width: `${metrics.filledPercent}%` }}
            >
              {knownSegments.map((segment) => {
                const segmentShare = (segment.widthPercent / knownWidthSum) * 100;
                const fill = normalizeProviderAccentColor(segment.accentColor) ?? color;
                return (
                  <div
                    key={segment.key}
                    aria-hidden
                    data-pool-segment={segment.status}
                    data-pool-segment-color={fill}
                    className="h-full not-first:border-l not-first:border-background/60"
                    style={{ width: `${segmentShare}%`, backgroundColor: fill }}
                  />
                );
              })}
            </div>
          ) : null}
          {unavailableContainerWidth > 0 && unavailableWidthSum > 0 ? (
            <div
              className={cn(
                "absolute flex overflow-hidden",
                compact
                  ? metrics.filledPercent > 0
                    ? "inset-y-1 rounded-r-full"
                    : "inset-y-1 rounded-full"
                  : metrics.filledPercent > 0
                    ? "inset-y-0 rounded-r-md"
                    : "inset-y-0 rounded-md",
              )}
              style={{
                left: `${metrics.filledPercent}%`,
                width: `${unavailableContainerWidth}%`,
              }}
            >
              {unavailableSegments.map((segment) => {
                const segmentShare = (segment.slotWidthPercent / unavailableWidthSum) * 100;
                const fill = normalizeProviderAccentColor(segment.accentColor) ?? color;
                return (
                  <div
                    key={segment.key}
                    aria-hidden
                    data-pool-segment="unavailable"
                    data-pool-segment-color={fill}
                    className="h-full border-l border-background/60 opacity-40"
                    style={{
                      width: `${segmentShare}%`,
                      backgroundImage: `repeating-linear-gradient(-45deg, ${fill} 0 3px, transparent 3px 6px)`,
                    }}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
        {paceMark ? (
          <span
            aria-hidden
            data-combined-pool-pace-tick="true"
            className={cn(
              "absolute w-0.5 -translate-x-1/2 rounded-full bg-foreground",
              compact ? "inset-y-0.5" : "inset-y-0",
            )}
            style={paceMark.tick}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-foreground tabular-nums">
            {metrics.knownMemberCount < metrics.totalMemberCount
              ? gt("{remaining}% left ({known} of {total} accounts reporting)", {
                  remaining: metrics.remainingPercent,
                  known: metrics.knownMemberCount,
                  total: metrics.totalMemberCount,
                })
              : metrics.combinedTimeLeftPercent !== null
                ? gt("{remaining}% total left · {timeLeft}% of combined window left", {
                    remaining: metrics.remainingPercent,
                    timeLeft: metrics.combinedTimeLeftPercent,
                  })
                : gt("{remaining}% total left", { remaining: metrics.remainingPercent })}
          </span>
          {metrics.combinedTimeLeftPercent !== null ? (
            <span className="text-muted-foreground">
              <T>The line is where even spending across all accounts would be.</T>
            </span>
          ) : null}
          {nextResetAt ? (
            <span className="text-muted-foreground tabular-nums">
              {gt("Next refill: {name} · {time}", {
                name:
                  nextReset?.member.account.displayName ??
                  nextReset?.member.account.email ??
                  String(nextReset?.member.account.driver ?? ""),
                time: nextResetIn ? `${nextResetAt} (${nextResetIn})` : nextResetAt,
              })}
            </span>
          ) : null}
          <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 border-t border-border/60 pt-1 text-2xs text-muted-foreground tabular-nums">
            {metrics.segments.map((segment) => (
              <span key={segment.key} className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    segment.status === "unavailable" && "opacity-45",
                  )}
                  style={{
                    backgroundColor: normalizeProviderAccentColor(segment.accentColor) ?? color,
                  }}
                />
                <span>{segment.displayName}</span>
                <span className="font-medium text-foreground">
                  {segment.remainingPercent === null ? "-" : `${segment.remainingPercent}%`}
                </span>
                {segment.status === "cached" ? (
                  <span className="text-muted-foreground/75">{gt("(cached)")}</span>
                ) : null}
              </span>
            ))}
          </div>
          {unavailableSegments.length > 0 ? (
            <span className="text-2xs text-muted-foreground">
              <T>Expired sign-ins refresh automatically on next turn.</T>
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Full-width combined total + combined pace bar rendered under each multi-account bucket on the
 * Usage page.
 */
export function CombinedPoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  if (pool.members.length < 2) return null;
  const metrics = computeCombinedPoolWindowMetrics(pool, now);
  const nextReset = metrics.nextReset;
  const refillIn = nextReset ? formatResetsIn(nextReset.member.window, now, m, "refill") : null;

  return (
    <div data-usage-combined-bar={pool.id} className="flex min-w-0 flex-col gap-1.5 md:col-start-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{gt("Combined")}</span>
        <span className="font-semibold text-foreground tabular-nums">
          {gt("{remaining}% left", { remaining: metrics.remainingPercent })}
        </span>
        {metrics.pace ? <PaceIcon pace={metrics.pace} /> : null}
        {metrics.combinedTimeLeftPercent !== null ? (
          <span className="text-2xs text-muted-foreground tabular-nums">
            · {gt("pace {timeLeft}%", { timeLeft: metrics.combinedTimeLeftPercent })}
          </span>
        ) : null}
        {refillIn ? (
          <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
            {nextReset && nextReset.restoresPercent > 0
              ? `↻ +${nextReset.restoresPercent}% · ${refillIn.replace(/^↻\s*/, "")}`
              : refillIn}
          </span>
        ) : null}
      </div>
      <CombinedBarTrack pool={pool} color={color} now={now} />
    </div>
  );
}

/**
 * Compact combined 5-hour and weekly usage bars with pace, pinned at the bottom of the chat
 * window pane whenever a Pool provider is selected in the composer.
 */
export function ChatPoolUsageBar({
  environmentId,
  poolInstanceId,
  selectedModel,
  providerInstances,
  providerStatuses,
}: {
  readonly environmentId: EnvironmentId;
  readonly poolInstanceId: ProviderInstanceId | null;
  readonly selectedModel: string | undefined;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
}) {
  const m = useMessages();
  const allEnvironmentProviders = useEnvironmentProviders();
  const nowMinute = useNowMinute();

  const instanceConfig = poolInstanceId ? providerInstances?.[poolInstanceId] : undefined;
  const isPool = instanceConfig?.driver === POOL_DRIVER_KIND;
  const poolConfig = isPool ? parsePoolConfig(instanceConfig.config) : null;

  const latestChecked = providerStatuses.reduce((latest, provider) => {
    if (!poolConfig || !poolConfig.memberInstanceIds.includes(provider.instanceId)) return latest;
    const raw = provider.usageLimits?.checkedAt ?? provider.checkedAt;
    const checked = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(checked) && checked > latest ? checked : latest;
  }, 0);
  const minuteMs = Date.parse(`${nowMinute}:00.000Z`);
  // Use latestChecked when snapshots are ahead of wall clock (e.g. deterministic tests), otherwise live clock.
  const now =
    latestChecked > 0 && (!Number.isFinite(minuteMs) || latestChecked > minuteMs)
      ? latestChecked
      : Number.isFinite(minuteMs)
        ? minuteMs
        : latestChecked;

  const hydrated = poolConfig
    ? hydratePoolMembers({
        environmentId,
        memberIds: poolConfig.memberInstanceIds,
        providerStatuses,
        allEnvironmentProviders,
        providerInstances,
        now,
      })
    : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists live pool member usage limits to localStorage across restarts
  useEffect(() => {
    if (!hydrated || hydrated.members.length === 0) return;
    const liveMembers = hydrated.members.filter(
      (member) =>
        hydrated.memberStatusByKey.get(`${environmentId}:${member.instanceId}`) === "live",
    );
    if (liveMembers.length === 0) return;
    persistPoolMemberUsageSnapshots({ environmentId, members: liveMembers });
  }, [environmentId, hydrated]);

  if (!poolInstanceId || !isPool || !hydrated || hydrated.members.length === 0) return null;

  const { fiveHour, weekly, unavailableMembers, memberKeyOrder } = findPoolChatWindows({
    environmentId,
    members: hydrated.members,
    model: selectedModel,
    now,
    accentColorOverrides: hydrated.accentColorOverrides,
  });
  const windows = [fiveHour, weekly].filter((window): window is LimitPoolWindow => window !== null);
  if (windows.length === 0) return null;

  const metricsOptions: CombinedPoolWindowMetricsOptions = {
    unavailableMembers,
    memberStatusByKey: hydrated.memberStatusByKey,
    memberKeyOrder,
  };
  const color = barColor(hydrated.members[0]!.driver);
  const rows = windows.map((window) => {
    const metrics = computeCombinedPoolWindowMetrics(window, now, metricsOptions);
    const nextReset = metrics.nextReset;
    const refillIn = nextReset ? formatResetsIn(nextReset.member.window, now, m, "refill") : null;
    const shortLabel = window.label.replace(/\s*·\s*5-hour$/i, " · 5h");
    return { window, metrics, refillIn, shortLabel };
  });
  const hasPace = rows.some((row) => row.metrics.pace !== null);
  const hasRefill = rows.some((row) => row.refillIn !== null);
  const gridColsClass =
    hasPace && hasRefill
      ? "grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]"
      : hasPace || hasRefill
        ? "grid-cols-[auto_auto_minmax(0,1fr)_auto]"
        : "grid-cols-[auto_auto_minmax(0,1fr)]";

  return (
    <div
      data-chat-pool-usage-bar="true"
      className={cn(
        "surface-glass pointer-events-auto grid items-center gap-x-2.5 gap-y-0.5 px-2.5 pt-1.5 text-2xs text-muted-foreground",
        gridColsClass,
      )}
    >
      {rows.map(({ window, metrics, refillIn, shortLabel }) => (
        <Fragment key={window.id}>
          <span
            data-chat-pool-usage-row={window.kind}
            className="shrink-0 font-medium text-muted-foreground"
          >
            {shortLabel}
          </span>
          <span className="shrink-0 text-right font-semibold text-foreground tabular-nums">
            {metrics.remainingPercent}%
          </span>
          <CombinedBarTrack
            pool={window}
            color={color}
            now={now}
            compact
            metricsOptions={metricsOptions}
          />
          {hasPace ? (
            <span className="inline-flex shrink-0 items-center justify-center">
              {metrics.pace ? <PaceIcon pace={metrics.pace} /> : null}
            </span>
          ) : null}
          {hasRefill ? (
            <span className="shrink-0 text-right tabular-nums">{refillIn ?? ""}</span>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
