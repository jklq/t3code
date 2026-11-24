import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  parsePoolConfig,
  POOL_SUPPORTED_MEMBER_DRIVER,
  type PoolConfig,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "../components/settings/RedactedSensitiveText";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";

interface AntigravityCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly email: string | undefined;
  readonly status: ServerProvider["status"] | undefined;
  readonly summaryQuota: string | null;
}

function collectAntigravityCandidates(
  providerInstances: ProviderInstanceConfigMap | undefined,
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<AntigravityCandidate> {
  const liveById = new Map(
    serverProviders.map((provider) => [provider.instanceId, provider] as const),
  );
  const ids = new Set<ProviderInstanceId>();
  for (const [rawId, config] of Object.entries(providerInstances ?? {})) {
    if (config.driver === POOL_SUPPORTED_MEMBER_DRIVER) {
      ids.add(rawId as ProviderInstanceId);
    }
  }
  for (const provider of serverProviders) {
    if (provider.driver === POOL_SUPPORTED_MEMBER_DRIVER) {
      ids.add(provider.instanceId);
    }
  }
  const candidates: AntigravityCandidate[] = [];
  for (const instanceId of ids) {
    const config = providerInstances?.[instanceId];
    const live = liveById.get(instanceId);
    const displayName =
      config?.displayName?.trim() || live?.displayName?.trim() || String(instanceId);
    const sessionWindow = live?.usageLimits?.windows.find((w) => w.kind === "session");
    candidates.push({
      instanceId,
      displayName,
      accentColor: config?.accentColor ?? live?.accentColor,
      email: live?.auth.email,
      status: live?.status,
      summaryQuota: sessionWindow ? `${remainingPercent(sessionWindow)}% left` : null,
    });
  }
  return candidates.toSorted((a, b) => a.displayName.localeCompare(b.displayName));
}

export function defaultPoolMemberIds(
  providerInstances: ProviderInstanceConfigMap | undefined,
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceId> {
  return collectAntigravityCandidates(providerInstances, serverProviders).map(
    (candidate) => candidate.instanceId,
  );
}

export function PoolMembersPicker({
  memberInstanceIds,
  providerInstances,
  serverProviders,
  readOnly = false,
  onChange,
}: {
  readonly memberInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly readOnly?: boolean;
  readonly onChange: (next: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const gt = useGT();
  const candidates = collectAntigravityCandidates(providerInstances, serverProviders);
  const selectedSet = new Set(memberInstanceIds);
  const allSelected =
    candidates.length > 0 && candidates.every((candidate) => selectedSet.has(candidate.instanceId));

  const toggle = (instanceId: ProviderInstanceId, checked: boolean) => {
    const next = checked
      ? [...memberInstanceIds.filter((id) => id !== instanceId), instanceId]
      : memberInstanceIds.filter((id) => id !== instanceId);
    onChange(next);
  };

  if (candidates.length === 0) {
    return (
      <SettingsRow
        title={gt("Pooled accounts")}
        description={gt(
          "No Antigravity accounts are registered on this machine yet. Add Antigravity accounts first, then include them here.",
        )}
      />
    );
  }

  return (
    <>
      <SettingsRow
        title={gt("Antigravity accounts")}
        description={gt(
          "Threads automatically pick the account with the most remaining quota and continue in a new thread when an account runs out.",
        )}
        control={
          candidates.length > 1 ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={readOnly}
              onClick={() =>
                onChange(allSelected ? [] : candidates.map((candidate) => candidate.instanceId))
              }
            >
              {allSelected ? gt("Clear all") : gt("Select all")}
            </Button>
          ) : null
        }
      />
      {candidates.map((candidate) => {
        const checked = selectedSet.has(candidate.instanceId);
        return (
          <SettingsRow
            key={candidate.instanceId}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                <ProviderInstanceIcon
                  driverKind={POOL_SUPPORTED_MEMBER_DRIVER}
                  displayName={candidate.displayName}
                  accentColor={candidate.accentColor}
                  showBadge={candidates.length > 1}
                  size="compact"
                  className="size-4"
                  iconClassName="size-3.5"
                />
                <span className="truncate">{candidate.displayName}</span>
                {candidate.summaryQuota ? (
                  <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                    · {candidate.summaryQuota}
                  </span>
                ) : null}
              </span>
            }
            description={
              candidate.email ? (
                <RedactedSensitiveText
                  value={candidate.email}
                  ariaLabel={gt("Toggle account email visibility")}
                  revealTooltip={gt("Click to reveal email")}
                  hideTooltip={gt("Click to hide email")}
                />
              ) : (
                String(candidate.instanceId)
              )
            }
            control={
              <Switch
                checked={checked}
                disabled={readOnly}
                aria-label={gt("Include {name} in pool", { name: candidate.displayName })}
                onCheckedChange={(nextChecked) => toggle(candidate.instanceId, nextChecked)}
              />
            }
          />
        );
      })}
    </>
  );
}

export function PoolMembersSection({
  instance,
  providerInstances,
  serverProviders,
  readOnly = false,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly readOnly?: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const poolConfig = parsePoolConfig(instance.config);

  const handleChange = (memberInstanceIds: ReadonlyArray<ProviderInstanceId>) => {
    const nextConfig: PoolConfig = {
      ...poolConfig,
      memberDriver: "antigravity",
      memberInstanceIds: [...memberInstanceIds],
    };
    onUpdate({
      ...instance,
      config: nextConfig,
    });
  };

  return (
    <PoolMembersPicker
      memberInstanceIds={poolConfig.memberInstanceIds}
      providerInstances={providerInstances}
      serverProviders={serverProviders}
      readOnly={readOnly}
      onChange={handleChange}
    />
  );
}
