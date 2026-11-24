import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  isProviderAvailable,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  antigravityWindowLimitsModel,
  collectLimitPools,
  displayLimitWindows,
  elapsedShare,
  exhaustedUsageWindow,
  type LimitAccount,
  type LimitPace,
  type LimitPoolWindow,
  remainingPercent,
} from "../usageLimits.ts";

export const POOL_DRIVER_KIND = ProviderDriverKind.make("pool");
export const POOL_SUPPORTED_MEMBER_DRIVER = ProviderDriverKind.make("antigravity");

export const PoolMemberDriver = Schema.Literals(["antigravity"]);
export type PoolMemberDriver = typeof PoolMemberDriver.Type;

export const PoolConfigSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  memberDriver: PoolMemberDriver.pipe(
    Schema.withDecodingDefault(Effect.succeed("antigravity" as const)),
  ),
  memberInstanceIds: Schema.Array(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<ProviderInstanceId>)),
  ),
});
export type PoolConfig = typeof PoolConfigSchema.Type;

const decodePoolConfigOption = Schema.decodeUnknownOption(PoolConfigSchema);

export function parsePoolConfig(raw: unknown): PoolConfig {
  const decoded = decodePoolConfigOption(raw ?? {});
  if (decoded._tag === "Some") {
    return {
      ...decoded.value,
      memberInstanceIds: [...new Set(decoded.value.memberInstanceIds)],
    };
  }
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const rawMembers = Array.isArray(obj?.memberInstanceIds) ? obj.memberInstanceIds : [];
  const memberInstanceIds: ProviderInstanceId[] = [];
  const seen = new Set<string>();
  for (const candidate of rawMembers) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    memberInstanceIds.push(ProviderInstanceId.make(trimmed));
  }
  return {
    ...(typeof obj?.enabled === "boolean" ? { enabled: obj.enabled } : {}),
    memberDriver: "antigravity",
    memberInstanceIds,
  };
}

export type AntigravityModelFamily = "gemini" | "3p";

export function antigravityModelFamily(model: string | undefined): AntigravityModelFamily | null {
  if (!model) return null;
  const match = model.match(/^(gemini|claude|gpt)-/);
  if (!match) return null;
  return match[1] === "gemini" ? "gemini" : "3p";
}

export function poolCooldownKey(
  instanceId: ProviderInstanceId,
  family: AntigravityModelFamily | "all",
): string {
  return `${instanceId}:${family}`;
}

function matchingAntigravityWindows(
  provider: ServerProvider,
  model: string | undefined,
): ReadonlyArray<ServerProviderUsageWindow> {
  const windows = provider.usageLimits?.windows ?? [];
  if (!model) return windows;
  return windows.filter((window) => {
    if (!/^(gemini|claude|gpt|3p)-/.test(window.id)) return true;
    return antigravityWindowLimitsModel(window, model);
  });
}

function parseResetMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface PoolMemberDepletion {
  readonly depleted: boolean;
  /** Earliest timestamp (epoch ms) when this member becomes usable again for the model. */
  readonly resetsAtMs: number | null;
}

function evaluatePoolMemberDepletion(input: {
  readonly provider: ServerProvider;
  readonly model: string | undefined;
  readonly now: number;
  readonly cooldowns?: ReadonlyMap<string, number> | undefined;
}): PoolMemberDepletion {
  const { provider, model, now, cooldowns } = input;
  const family = antigravityModelFamily(model);
  let resetsAtMs: number | null = null;
  let depleted = false;

  const cooldownKeys = family
    ? [poolCooldownKey(provider.instanceId, family), poolCooldownKey(provider.instanceId, "all")]
    : [poolCooldownKey(provider.instanceId, "all")];
  for (const key of cooldownKeys) {
    const until = cooldowns?.get(key);
    if (until !== undefined && until > now) {
      depleted = true;
      resetsAtMs = resetsAtMs === null ? until : Math.max(resetsAtMs, until);
    }
  }

  const windows = matchingAntigravityWindows(provider, model);
  for (const window of windows) {
    if ((window.usedPercent ?? 0) < 100) continue;
    const windowResetMs = parseResetMs(window.resetsAt);
    if (windowResetMs !== null && windowResetMs <= now) continue;
    depleted = true;
    if (windowResetMs !== null) {
      resetsAtMs = resetsAtMs === null ? windowResetMs : Math.max(resetsAtMs, windowResetMs);
    }
  }

  if (!depleted && exhaustedUsageWindow(provider, now, model) !== undefined) {
    depleted = true;
    const exhausted = exhaustedUsageWindow(provider, now, model);
    const ms = parseResetMs(exhausted?.resetsAt);
    if (ms !== null && ms > now) {
      resetsAtMs = resetsAtMs === null ? ms : Math.max(resetsAtMs, ms);
    }
  }

  return { depleted, resetsAtMs };
}

export function isEligiblePoolMember(provider: ServerProvider): boolean {
  return (
    provider.driver === POOL_SUPPORTED_MEMBER_DRIVER &&
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.auth.status !== "unauthenticated"
  );
}

export interface PoolSelectionResult {
  readonly selected: ServerProvider | null;
  readonly allDepleted: boolean;
  readonly earliestResetAt: string | null;
  readonly quickestResetMember: ServerProvider | null;
}

// One 5-hour Antigravity window consumes ~25% of a weekly allowance, so runway and pace share a 4:1 scale.
const SESSION_TO_WEEKLY_RATIO = 0.25;
const COMFORTABLE_RUNWAY_PERCENT = 20;

interface EffectiveWindowScore {
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly usedPercent: number;
  readonly runway: number;
  readonly pace: number;
}

function scoreMatchingWindow(window: ServerProviderUsageWindow, now: number): EffectiveWindowScore {
  const resetMs = parseResetMs(window.resetsAt);
  const expired = resetMs !== null && resetMs <= now;
  const usedPercent = expired ? 0 : Math.max(0, Math.min(100, window.usedPercent));
  const remaining = 100 - usedPercent;
  const elapsed = expired ? 0 : (elapsedShare(window, now) ?? 0);
  return {
    kind: window.kind,
    usedPercent,
    runway: window.kind === "weekly" ? remaining / SESSION_TO_WEEKLY_RATIO : remaining,
    pace: usedPercent - elapsed * 100,
  };
}

function worstWindowByKind(
  windows: ReadonlyArray<EffectiveWindowScore>,
  kind: ServerProviderUsageWindow["kind"],
): EffectiveWindowScore | undefined {
  let worst: EffectiveWindowScore | undefined;
  for (const entry of windows) {
    if (entry.kind !== kind) continue;
    if (
      worst === undefined ||
      entry.usedPercent > worst.usedPercent ||
      (entry.usedPercent === worst.usedPercent && entry.pace > worst.pace)
    ) {
      worst = entry;
    }
  }
  return worst;
}

function memberLimitScore(provider: ServerProvider, model: string | undefined, now: number) {
  const windows = matchingAntigravityWindows(provider, model);
  if (windows.length === 0) {
    return {
      hasLimits: false,
      hasComfortableHeadroom: false,
      runway: 50,
      paceScore: 50,
      bottleneckUsed: 50,
      sessionUsed: 50,
      weeklyUsed: 50,
      totalUsed: 100,
    };
  }
  const effective = windows.map((window) => scoreMatchingWindow(window, now));
  const session = worstWindowByKind(effective, "session");
  const weekly = worstWindowByKind(effective, "weekly");
  const bottleneckUsed = effective.reduce((max, entry) => Math.max(max, entry.usedPercent), 0);
  const totalUsed = effective.reduce((sum, entry) => sum + entry.usedPercent, 0);
  const runway = effective.reduce(
    (min, entry) => Math.min(min, entry.runway),
    Number.POSITIVE_INFINITY,
  );
  const paceScore =
    weekly !== undefined && session !== undefined
      ? weekly.pace + SESSION_TO_WEEKLY_RATIO * session.pace
      : weekly !== undefined
        ? weekly.pace
        : session !== undefined
          ? session.pace
          : effective.reduce((max, entry) => Math.max(max, entry.pace), Number.NEGATIVE_INFINITY);
  return {
    hasLimits: true,
    hasComfortableHeadroom: runway >= COMFORTABLE_RUNWAY_PERCENT,
    runway,
    paceScore,
    bottleneckUsed,
    sessionUsed: session?.usedPercent ?? bottleneckUsed,
    weeklyUsed: weekly?.usedPercent ?? bottleneckUsed,
    totalUsed,
  };
}

/**
 * Picks the best available pool member for `model`, preferring accounts with comfortable
 * single-thread runway and the most headroom relative to their weekly and 5-hour reset clocks.
 * When all eligible members are depleted, reports `allDepleted: true` along with the
 * member whose quota renews the quickest (`earliestResetAt`).
 */
export function selectPoolMember(input: {
  readonly members: readonly ServerProvider[];
  readonly model: string | undefined;
  readonly now: number;
  readonly cooldowns?: ReadonlyMap<string, number> | undefined;
  readonly excludeInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}): PoolSelectionResult {
  const eligible = input.members.filter(
    (member) => isEligiblePoolMember(member) && !input.excludeInstanceIds?.has(member.instanceId),
  );
  if (eligible.length === 0) {
    return {
      selected: null,
      allDepleted: false,
      earliestResetAt: null,
      quickestResetMember: null,
    };
  }

  const evaluated = eligible.map((provider, index) => ({
    provider,
    index,
    depletion: evaluatePoolMemberDepletion({
      provider,
      model: input.model,
      now: input.now,
      cooldowns: input.cooldowns,
    }),
    score: memberLimitScore(provider, input.model, input.now),
  }));

  const available = evaluated.filter((entry) => !entry.depletion.depleted);
  if (available.length > 0) {
    available.sort((a, b) => {
      // Ready instances ahead of warning/error instances.
      const readyDiff =
        Number(b.provider.status === "ready") - Number(a.provider.status === "ready");
      if (readyDiff !== 0) return readyDiff;
      // Known non-depleted usage readings ahead of unknown-quota members.
      const limitsDiff = Number(b.score.hasLimits) - Number(a.score.hasLimits);
      if (limitsDiff !== 0) return limitsDiff;
      // Members with comfortable single-thread runway ahead of near-empty ones.
      const headroomDiff =
        Number(b.score.hasComfortableHeadroom) - Number(a.score.hasComfortableHeadroom);
      if (headroomDiff !== 0) return headroomDiff;
      if (a.score.hasComfortableHeadroom) {
        if (a.score.paceScore !== b.score.paceScore) {
          return a.score.paceScore - b.score.paceScore;
        }
      } else if (a.score.runway !== b.score.runway) {
        return b.score.runway - a.score.runway;
      }
      if (a.score.bottleneckUsed !== b.score.bottleneckUsed) {
        return a.score.bottleneckUsed - b.score.bottleneckUsed;
      }
      if (a.score.sessionUsed !== b.score.sessionUsed) {
        return a.score.sessionUsed - b.score.sessionUsed;
      }
      if (a.score.weeklyUsed !== b.score.weeklyUsed) {
        return a.score.weeklyUsed - b.score.weeklyUsed;
      }
      if (a.score.totalUsed !== b.score.totalUsed) {
        return a.score.totalUsed - b.score.totalUsed;
      }
      return a.index - b.index;
    });
    return {
      selected: available[0]!.provider,
      allDepleted: false,
      earliestResetAt: null,
      quickestResetMember: null,
    };
  }

  // All eligible members are depleted: pick the one renewing soonest.
  const withReset = evaluated
    .filter(
      (entry) => entry.depletion.resetsAtMs !== null && entry.depletion.resetsAtMs > input.now,
    )
    .slice()
    .sort(
      (a, b) =>
        (a.depletion.resetsAtMs ?? Number.POSITIVE_INFINITY) -
          (b.depletion.resetsAtMs ?? Number.POSITIVE_INFINITY) || a.index - b.index,
    );
  const quickest = withReset[0] ?? evaluated[0]!;
  return {
    selected: quickest.provider,
    allDepleted: true,
    earliestResetAt:
      quickest.depletion.resetsAtMs !== null
        ? DateTime.formatIso(DateTime.makeUnsafe(quickest.depletion.resetsAtMs))
        : null,
    quickestResetMember: quickest.provider,
  };
}

/**
 * Shared models supported by all populated member accounts in a pool.
 * Members whose model catalog has not loaded yet are skipped so cold boot does not blank the pool.
 */
export function intersectPoolModels(
  members: readonly ServerProvider[],
): ReadonlyArray<ServerProviderModel> {
  const populated = members.filter(
    (member) =>
      isEligiblePoolMember(member) &&
      member.models.some((model) => !model.isCustom && model.slug !== ANTIGRAVITY_DEFAULT_MODEL),
  );
  if (populated.length === 0) return [];
  const firstModels = populated[0]!.models.filter(
    (model) => !model.isCustom && model.slug !== ANTIGRAVITY_DEFAULT_MODEL,
  );
  const memberModelsBySlug = populated
    .slice(1)
    .map((member) => new Map(member.models.map((model) => [model.slug, model] as const)));
  return firstModels.flatMap((model) => {
    const matches = memberModelsBySlug.map((models) => models.get(model.slug));
    if (matches.some((match) => match === undefined)) return [];
    if (model.capabilities?.optionDescriptors?.length) return [model];
    const observed = matches.find((match) => match?.capabilities?.optionDescriptors?.length);
    return [observed ? { ...model, capabilities: observed.capabilities } : model];
  });
}

export function intersectPoolRuntimeModes(
  members: readonly ServerProvider[],
): ReadonlyArray<RuntimeMode> | undefined {
  const lists = members
    .filter(isEligiblePoolMember)
    .map((member) => member.supportedRuntimeModes)
    .filter(
      (modes): modes is ReadonlyArray<RuntimeMode> => modes !== undefined && modes.length > 0,
    );
  if (lists.length === 0) return undefined;
  const [first, ...rest] = lists;
  const shared = first!.filter((mode) => rest.every((other) => other.includes(mode)));
  return shared.length > 0 ? shared : first;
}

export type CombinedPoolSegmentStatus = "live" | "cached" | "unavailable";

export interface CombinedPoolBarSegment {
  readonly key: string;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly remainingPercent: number | null;
  /** Portion of the 0-100 combined bar this member contributes when known. */
  readonly widthPercent: number;
  /** Equal share of the full 0-100 bar allocated to this member (100 / totalMembers). */
  readonly slotWidthPercent: number;
  readonly status: CombinedPoolSegmentStatus;
  readonly resetsAt: string | undefined;
}

export interface CombinedPoolUnavailableMember {
  readonly key: string;
  readonly displayName: string;
  readonly accentColor: string | undefined;
}

export interface CombinedPoolWindowMetricsOptions {
  readonly unavailableMembers?: ReadonlyArray<CombinedPoolUnavailableMember> | undefined;
  readonly memberStatusByKey?: ReadonlyMap<string, "live" | "cached"> | undefined;
  readonly memberKeyOrder?: ReadonlyArray<string> | undefined;
}

export interface CombinedPoolWindowMetrics {
  readonly remainingPercent: number;
  readonly usedPercent: number;
  /** Exact unrounded sum of known segment widths (0-100) across the full bar track. */
  readonly filledPercent: number;
  readonly knownMemberCount: number;
  readonly totalMemberCount: number;
  /** Weighted combined window time remaining (0-100), or null if no account clock is ticking. */
  readonly combinedTimeLeftPercent: number | null;
  readonly pace: LimitPace | null;
  readonly segments: ReadonlyArray<CombinedPoolBarSegment>;
  readonly nextReset: LimitPoolWindow["resets"][number] | null;
}

/**
 * Extracts the bound member instance id from a Pool thread's `activeProviderThreadId`.
 * ACP member adapters stamp `provider-thread:provider:<driver>:provider-instance:<encoded>:native-thread:...`.
 */
export function extractBoundPoolMemberFromProviderThreadId(
  activeProviderThreadId: string | null | undefined,
): ProviderInstanceId | null {
  if (!activeProviderThreadId) return null;
  const parts = activeProviderThreadId.split(":");
  const markerIndex = parts.indexOf("provider-instance");
  if (markerIndex >= 0) {
    const encoded = parts[markerIndex + 1];
    if (!encoded) return null;
    try {
      const decoded = decodeURIComponent(encoded).trim();
      if (!decoded || decoded === POOL_DRIVER_KIND) return null;
      return ProviderInstanceId.make(decoded);
    } catch {
      return null;
    }
  }
  if (parts[0] === "provider-thread" && parts[1] === "provider" && parts[2]) {
    try {
      const decoded = decodeURIComponent(parts[2]).trim();
      if (!decoded || decoded === POOL_DRIVER_KIND) return null;
      return ProviderInstanceId.make(decoded);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Rolls forward any cached usage window whose `resetsAt` has already passed so cached readings
 * do not stay stuck at spent quota after a 5-hour or weekly reset.
 */
export function rolloverExpiredUsageLimits(
  limits: ServerProviderUsageLimits,
  now: number,
): ServerProviderUsageLimits {
  let changed = false;
  const windows = limits.windows.map((window) => {
    const resetMs = parseResetMs(window.resetsAt);
    if (resetMs === null || resetMs > now) return window;
    changed = true;
    const { resetsAt: _expired, ...rest } = window;
    return { ...rest, usedPercent: 0 };
  });
  return changed ? { ...limits, windows } : limits;
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/**
 * Combined total remaining and pace across every account in a bucket.
 * Unavailable members still keep their 1/N slot so missing readings never collapse the stacked bar.
 */
export function computeCombinedPoolWindowMetrics(
  pool: LimitPoolWindow,
  now: number,
  options?: CombinedPoolWindowMetricsOptions,
): CombinedPoolWindowMetrics {
  const knownKeys = new Set(pool.members.map((member) => member.account.key));
  const unavailable = (options?.unavailableMembers ?? []).filter(
    (member) => !knownKeys.has(member.key),
  );
  const knownCount = pool.members.length;
  const totalCount = knownCount + unavailable.length;
  if (totalCount === 0 || knownCount === 0) {
    return {
      remainingPercent: pool.remainingPercent,
      usedPercent: pool.usedPercent,
      filledPercent: 0,
      knownMemberCount: knownCount,
      totalMemberCount: totalCount,
      combinedTimeLeftPercent: null,
      pace: null,
      segments: unavailable.map((member) => ({
        key: member.key,
        displayName: member.displayName,
        accentColor: member.accentColor,
        remainingPercent: null,
        widthPercent: 0,
        slotWidthPercent: totalCount > 0 ? 100 / totalCount : 0,
        status: "unavailable",
        resetsAt: undefined,
      })),
      nextReset: null,
    };
  }
  const slotWeight = 1 / totalCount;
  const knownWeight = 1 / knownCount;
  let knownRemainingSum = 0;
  let filledTotal = 0;
  let totalElapsed = 0;
  let hasActiveClock = false;
  const segments: CombinedPoolBarSegment[] = [];

  for (const member of pool.members) {
    const remaining = remainingPercent(member.window);
    knownRemainingSum += remaining * knownWeight;
    const widthPercent = remaining * slotWeight;
    filledTotal += widthPercent;
    const elapsed = elapsedShare(member.window, now);
    if (elapsed !== null) {
      hasActiveClock = true;
      totalElapsed += elapsed * slotWeight;
    }
    segments.push({
      key: member.account.key,
      displayName:
        member.account.displayName ?? member.account.email ?? String(member.account.driver),
      accentColor: member.account.accentColor,
      remainingPercent: remaining,
      widthPercent,
      slotWidthPercent: 100 * slotWeight,
      status: options?.memberStatusByKey?.get(member.account.key) ?? "live",
      resetsAt: member.window.resetsAt,
    });
  }

  for (const member of unavailable) {
    segments.push({
      key: member.key,
      displayName: member.displayName,
      accentColor: member.accentColor,
      remainingPercent: null,
      widthPercent: 0,
      slotWidthPercent: 100 * slotWeight,
      status: "unavailable",
      resetsAt: undefined,
    });
  }

  const order = options?.memberKeyOrder;
  if (order && order.length > 0) {
    const rank = new Map(order.map((key, index) => [key, index] as const));
    segments.sort((left, right) => {
      const leftRank = rank.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
  }

  const combinedRemaining = Math.round(knownRemainingSum);
  const combinedUsed = Math.max(0, Math.min(100, 100 - combinedRemaining));
  const filledPercent = Math.max(0, Math.min(100, filledTotal));
  const allMembersKnown = unavailable.length === 0;
  const combinedTimeLeftPercent =
    hasActiveClock && allMembersKnown
      ? Math.round((1 - Math.max(0, Math.min(1, totalElapsed))) * 100)
      : null;
  const pace =
    hasActiveClock && allMembersKnown ? paceOfShares(100 - filledTotal, totalElapsed) : null;
  const nextReset =
    pool.resets.find((reset) => reset.at > now && reset.restoresPercent > 0) ??
    pool.resets.find((reset) => reset.at > now) ??
    null;

  return {
    remainingPercent: combinedRemaining,
    usedPercent: combinedUsed,
    filledPercent,
    knownMemberCount: knownCount,
    totalMemberCount: totalCount,
    combinedTimeLeftPercent,
    pace,
    segments,
    nextReset,
  };
}

function collectPoolDriverWindows(input: {
  readonly environmentId: EnvironmentId;
  readonly members: readonly ServerProvider[];
  readonly now: number;
  readonly accentColorOverrides?: ReadonlyMap<ProviderInstanceId, string> | undefined;
}): {
  readonly windows: ReadonlyArray<LimitPoolWindow>;
  readonly unavailableMembers: ReadonlyArray<CombinedPoolUnavailableMember>;
  readonly memberKeyOrder: ReadonlyArray<string>;
} {
  const accounts: LimitAccount[] = [];
  const unavailableMembers: CombinedPoolUnavailableMember[] = [];
  const memberKeyOrder: string[] = [];
  for (const provider of input.members) {
    if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
    const key = `${input.environmentId}:${provider.instanceId}`;
    memberKeyOrder.push(key);
    const accentColor =
      provider.accentColor ?? input.accentColorOverrides?.get(provider.instanceId);
    const displayName = provider.displayName?.trim() || provider.instanceId;
    const limits = provider.usageLimits;
    if (!limits || limits.unavailable || limits.windows.length === 0) {
      unavailableMembers.push({ key, displayName, accentColor });
      continue;
    }
    accounts.push({
      key,
      driver: provider.driver,
      displayName,
      email: provider.auth.email,
      plan: provider.auth.label,
      accentColor,
      environments: [{ environmentId: input.environmentId, label: "" }],
      sourceLabel: null,
      redeem: null,
      limits,
    });
  }
  if (accounts.length === 0) {
    return { windows: [], unavailableMembers, memberKeyOrder };
  }
  const pools = collectLimitPools(accounts, input.now);
  const driverPool = pools.find((p) => p.driver === POOL_SUPPORTED_MEMBER_DRIVER) ?? pools[0];
  return {
    windows: driverPool ? displayLimitWindows(driverPool) : [],
    unavailableMembers,
    memberKeyOrder,
  };
}

function pickPoolWindowForModel(
  windows: ReadonlyArray<LimitPoolWindow>,
  kind: "session" | "weekly",
  model: string | undefined,
): LimitPoolWindow | null {
  const matchingKind = windows.filter((w) => w.kind === kind);
  if (matchingKind.length === 0) return null;
  const family = antigravityModelFamily(model);
  if (family === "gemini") {
    return matchingKind.find((w) => w.id.startsWith("gemini-")) ?? matchingKind[0]!;
  }
  if (family === "3p") {
    return (
      matchingKind.find(
        (w) => w.id.startsWith("3p-") || w.id.startsWith("claude-") || w.id.startsWith("gpt-"),
      ) ?? matchingKind[0]!
    );
  }
  return matchingKind[0]!;
}

/**
 * Finds the combined 5-hour (session) and weekly LimitPoolWindows across `members` matching `model`.
 */
export function findPoolChatWindows(input: {
  readonly environmentId: EnvironmentId;
  readonly members: readonly ServerProvider[];
  readonly model: string | undefined;
  readonly now: number;
  readonly accentColorOverrides?: ReadonlyMap<ProviderInstanceId, string> | undefined;
}): {
  readonly fiveHour: LimitPoolWindow | null;
  readonly weekly: LimitPoolWindow | null;
  readonly unavailableMembers: ReadonlyArray<CombinedPoolUnavailableMember>;
  readonly memberKeyOrder: ReadonlyArray<string>;
} {
  const { windows, unavailableMembers, memberKeyOrder } = collectPoolDriverWindows(input);
  return {
    fiveHour: pickPoolWindowForModel(windows, "session", input.model),
    weekly: pickPoolWindowForModel(windows, "weekly", input.model),
    unavailableMembers,
    memberKeyOrder,
  };
}

/**
 * Finds the combined 5-hour (session) LimitPoolWindow across `members` matching `model`.
 * Falls back to the first session window if `model` has no specific family match.
 */
export function findPoolFiveHourWindow(input: {
  readonly environmentId: EnvironmentId;
  readonly members: readonly ServerProvider[];
  readonly model: string | undefined;
  readonly now: number;
}): LimitPoolWindow | null {
  return findPoolChatWindows(input).fiveHour;
}

/**
 * Finds the combined weekly LimitPoolWindow across `members` matching `model`.
 * Falls back to the first weekly window if `model` has no specific family match.
 */
export function findPoolWeeklyWindow(input: {
  readonly environmentId: EnvironmentId;
  readonly members: readonly ServerProvider[];
  readonly model: string | undefined;
  readonly now: number;
}): LimitPoolWindow | null {
  return findPoolChatWindows(input).weekly;
}
