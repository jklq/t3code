import type {
  EnvironmentId,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  POOL_SUPPORTED_MEMBER_DRIVER,
  rolloverExpiredUsageLimits,
} from "@t3tools/shared/usageLimits";

const STORAGE_KEY = "t3code:fork:pool-usage-cache:v1";

interface CachedMemberUsageEntry {
  readonly limits: ServerProviderUsageLimits;
  readonly email?: string | undefined;
  readonly fingerprint?: string | undefined;
}

type PersistedCacheShape = Record<string, CachedMemberUsageEntry>;

let memoryCache: Map<string, CachedMemberUsageEntry> | null = null;

function isValidUsageLimits(
  limits: ServerProviderUsageLimits | undefined,
): limits is ServerProviderUsageLimits {
  return Boolean(limits && !limits.unavailable && limits.windows.length > 0);
}

function readCache(): Map<string, CachedMemberUsageEntry> {
  if (memoryCache !== null) return memoryCache;
  memoryCache = new Map();
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return memoryCache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryCache;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as PersistedCacheShape)) {
        if (
          value &&
          typeof value === "object" &&
          value.limits &&
          Array.isArray(value.limits.windows) &&
          typeof value.limits.checkedAt === "string"
        ) {
          memoryCache.set(key, value);
        }
      }
    }
  } catch {
    // Ignore malformed localStorage cache entries.
  }
  return memoryCache;
}

function writeCache(cache: Map<string, CachedMemberUsageEntry>): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;
  try {
    const serialized: PersistedCacheShape = Object.fromEntries(cache.entries());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage quota or private-mode failures.
  }
}

function cacheKeysFor(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly email?: string | undefined;
  readonly fingerprint?: string | undefined;
}): ReadonlyArray<string> {
  const keys = [`env:${input.environmentId}:${input.instanceId}`];
  const fp = input.fingerprint?.trim();
  if (fp) keys.push(`fp:${fp}`);
  const email = input.email?.trim().toLowerCase();
  if (email) keys.push(`email:${email}`);
  return keys;
}

/** Clears the in-memory and localStorage cache (intended for tests). */
export function clearPoolUsageCache(): void {
  memoryCache = new Map();
  if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage errors in tests.
    }
  }
}

export function persistPoolMemberUsageSnapshots(input: {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<ServerProvider>;
}): void {
  const cache = readCache();
  let dirty = false;
  for (const member of input.members) {
    if (!isValidUsageLimits(member.usageLimits)) continue;
    const nextEntry: CachedMemberUsageEntry = {
      limits: member.usageLimits,
      ...(member.auth.email ? { email: member.auth.email } : {}),
      ...(member.usageLimits.credentialFingerprint
        ? { fingerprint: member.usageLimits.credentialFingerprint }
        : {}),
    };
    const nextCheckedMs = Date.parse(member.usageLimits.checkedAt);
    for (const key of cacheKeysFor({
      environmentId: input.environmentId,
      instanceId: member.instanceId,
      email: nextEntry.email,
      fingerprint: nextEntry.fingerprint,
    })) {
      const existing = cache.get(key);
      const existingMs = existing ? Date.parse(existing.limits.checkedAt) : NaN;
      if (
        existing &&
        Number.isFinite(existingMs) &&
        Number.isFinite(nextCheckedMs) &&
        existingMs >= nextCheckedMs
      ) {
        continue;
      }
      cache.set(key, nextEntry);
      dirty = true;
    }
  }
  if (dirty) writeCache(cache);
}

function findCrossEnvironmentLimits(input: {
  readonly environmentId: EnvironmentId;
  readonly member: ServerProvider;
  readonly cachedFingerprint: string | undefined;
  readonly cachedEmail: string | undefined;
  readonly allEnvironmentProviders:
    | ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>
    | undefined;
}): ServerProviderUsageLimits | null {
  if (!input.allEnvironmentProviders || input.allEnvironmentProviders.size <= 1) return null;
  const targetFp = input.member.usageLimits?.credentialFingerprint ?? input.cachedFingerprint;
  const targetEmail = (input.member.auth.email ?? input.cachedEmail)?.trim().toLowerCase();
  const targetDisplay = input.member.displayName?.trim().toLowerCase();

  let best: ServerProviderUsageLimits | null = null;
  let bestCheckedMs = -1;

  for (const [otherEnvId, providers] of input.allEnvironmentProviders) {
    if (otherEnvId === input.environmentId) continue;
    for (const candidate of providers) {
      if (candidate.driver !== POOL_SUPPORTED_MEMBER_DRIVER) continue;
      if (!isValidUsageLimits(candidate.usageLimits)) continue;
      const candFp = candidate.usageLimits.credentialFingerprint;
      const candEmail = candidate.auth.email?.trim().toLowerCase();
      const candDisplay = candidate.displayName?.trim().toLowerCase();
      const matched =
        (targetFp !== undefined && candFp === targetFp) ||
        (targetEmail !== undefined && candEmail === targetEmail) ||
        (candidate.instanceId === input.member.instanceId &&
          (!targetDisplay || !candDisplay || targetDisplay === candDisplay));
      if (!matched) continue;
      const checkedMs = Date.parse(candidate.usageLimits.checkedAt);
      const score = Number.isFinite(checkedMs) ? checkedMs : 0;
      if (best === null || score > bestCheckedMs) {
        best = candidate.usageLimits;
        bestCheckedMs = score;
      }
    }
  }
  return best;
}

export interface HydratedPoolMembersResult {
  readonly members: ReadonlyArray<ServerProvider>;
  readonly memberStatusByKey: ReadonlyMap<string, "live" | "cached">;
  readonly accentColorOverrides: ReadonlyMap<ProviderInstanceId, string>;
}

/**
 * Hydrates pool members from live local limits, fresher cross-environment limits, or persisted
 * localStorage cache (rolling forward expired windows) while preserving configured accent colors.
 */
export function hydratePoolMembers(input: {
  readonly environmentId: EnvironmentId;
  readonly memberIds: ReadonlyArray<ProviderInstanceId>;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly allEnvironmentProviders:
    | ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>
    | undefined;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly now: number;
}): HydratedPoolMembersResult {
  const byId = new Map(
    input.providerStatuses.map((provider) => [provider.instanceId, provider] as const),
  );
  const cache = readCache();
  const members: ServerProvider[] = [];
  const memberStatusByKey = new Map<string, "live" | "cached">();
  const accentColorOverrides = new Map<ProviderInstanceId, string>();

  for (const id of input.memberIds) {
    const found = byId.get(id);
    if (!found) continue;
    const key = `${input.environmentId}:${found.instanceId}`;
    const configuredAccent = normalizeProviderAccentColor(
      found.accentColor ?? input.providerInstances?.[id]?.accentColor,
    );
    if (configuredAccent) accentColorOverrides.set(found.instanceId, configuredAccent);

    const rawFingerprint = found.usageLimits?.credentialFingerprint;
    if (isValidUsageLimits(found.usageLimits)) {
      memberStatusByKey.set(key, "live");
      members.push(
        configuredAccent && found.accentColor !== configuredAccent
          ? { ...found, accentColor: configuredAccent }
          : found,
      );
      continue;
    }

    const envCacheEntry = cache.get(`env:${input.environmentId}:${found.instanceId}`);
    const crossEnvLimits = findCrossEnvironmentLimits({
      environmentId: input.environmentId,
      member: found,
      cachedFingerprint: envCacheEntry?.fingerprint,
      cachedEmail: envCacheEntry?.email,
      allEnvironmentProviders: input.allEnvironmentProviders,
    });
    if (crossEnvLimits) {
      memberStatusByKey.set(key, "live");
      members.push({
        ...found,
        ...(configuredAccent ? { accentColor: configuredAccent } : {}),
        usageLimits: crossEnvLimits,
      });
      continue;
    }

    let cachedEntry: CachedMemberUsageEntry | undefined = envCacheEntry;
    if (!cachedEntry) {
      for (const cacheKey of cacheKeysFor({
        environmentId: input.environmentId,
        instanceId: found.instanceId,
        email: found.auth.email,
        fingerprint: rawFingerprint,
      })) {
        const hit = cache.get(cacheKey);
        if (hit) {
          cachedEntry = hit;
          break;
        }
      }
    }

    if (cachedEntry && isValidUsageLimits(cachedEntry.limits)) {
      const rolledLimits = rolloverExpiredUsageLimits(cachedEntry.limits, input.now);
      memberStatusByKey.set(key, "cached");
      members.push({
        ...found,
        ...(configuredAccent ? { accentColor: configuredAccent } : {}),
        usageLimits: rolledLimits,
      });
      continue;
    }

    members.push(
      configuredAccent && found.accentColor !== configuredAccent
        ? { ...found, accentColor: configuredAccent }
        : found,
    );
  }

  return { members, memberStatusByKey, accentColorOverrides };
}
