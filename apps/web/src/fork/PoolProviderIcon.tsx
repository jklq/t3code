import {
  type ModelSelection,
  type ProviderInstanceConfigMap,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  providerAccentForegroundColor,
  providerInstanceInitials,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  extractBoundPoolMemberFromProviderThreadId,
  parsePoolConfig,
  POOL_DRIVER_KIND,
  selectPoolMember,
} from "@t3tools/shared/usageLimits";
import { type CSSProperties, memo } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { cn } from "../lib/utils";
import type { ProviderInstanceEntry } from "../providerInstances";
import { useThreadShell } from "../state/entities";

export interface ActivePoolMemberPresentation {
  readonly instanceId: ProviderInstanceEntry["instanceId"];
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly isBoundToThread: boolean;
}

type PoolMemberLookupEntry = Pick<
  ProviderInstanceEntry,
  "instanceId" | "displayName" | "accentColor"
>;

/**
 * Resolves a started Pool thread's bound member directly from its `activeProviderThreadId`
 * (available on sidebar thread shells without loading full thread detail).
 */
export function resolveSidebarPoolMember(input: {
  readonly activeProviderThreadId: string | null | undefined;
  readonly poolInstanceId: string;
  readonly providerEntryByInstanceId: ReadonlyMap<string, PoolMemberLookupEntry>;
}): ActivePoolMemberPresentation | null {
  const memberId = extractBoundPoolMemberFromProviderThreadId(input.activeProviderThreadId);
  if (!memberId || memberId === input.poolInstanceId) return null;
  const entry = input.providerEntryByInstanceId.get(memberId);
  if (!entry) return null;
  return {
    instanceId: entry.instanceId,
    displayName: entry.displayName,
    accentColor: entry.accentColor,
    isBoundToThread: true,
  };
}

/**
 * Determines which member account a Pool selection is using (or will use next).
 * On an active server thread, prefers the member stamped on `reportedModelSelection`,
 * falling back to `activeProviderThreadId` before full detail loads.
 * On a draft thread, selects the least-limited member matching `selectedModel`.
 */
export function resolveActivePoolMember(input: {
  readonly poolEntry: ProviderInstanceEntry | null | undefined;
  readonly selectedModel: string | undefined;
  readonly reportedModelSelection?: ModelSelection | null | undefined;
  readonly activeProviderThreadId?: string | null | undefined;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly now?: number;
}): ActivePoolMemberPresentation | null {
  const {
    poolEntry,
    selectedModel,
    reportedModelSelection,
    activeProviderThreadId,
    providerInstances,
    providerInstanceEntries,
  } = input;
  if (!poolEntry || poolEntry.driverKind !== POOL_DRIVER_KIND) return null;
  const config = parsePoolConfig(providerInstances?.[poolEntry.instanceId]?.config);
  if (config.memberInstanceIds.length === 0) return null;

  const entryById = new Map(
    providerInstanceEntries.map((entry) => [entry.instanceId, entry] as const),
  );
  const memberEntries = config.memberInstanceIds.flatMap((id) => {
    const found = entryById.get(id);
    return found ? [found] : [];
  });
  if (memberEntries.length === 0) return null;

  const boundId =
    reportedModelSelection?.instanceId ??
    extractBoundPoolMemberFromProviderThreadId(activeProviderThreadId);
  if (boundId) {
    const bound = memberEntries.find((entry) => entry.instanceId === boundId);
    if (bound) {
      return {
        instanceId: bound.instanceId,
        displayName: bound.displayName,
        accentColor: bound.accentColor,
        isBoundToThread: true,
      };
    }
  }

  const memberSnapshots: ServerProvider[] = memberEntries.map((entry) => entry.snapshot);
  const now = input.now ?? Date.now();
  const selection = selectPoolMember({
    members: memberSnapshots,
    model: selectedModel,
    now,
  });
  const chosenId = selection.selected?.instanceId ?? memberEntries[0]!.instanceId;
  const chosen = entryById.get(chosenId) ?? memberEntries[0]!;
  return {
    instanceId: chosen.instanceId,
    displayName: chosen.displayName,
    accentColor: chosen.accentColor,
    isBoundToThread: false,
  };
}

/**
 * Composer hook that resolves the active Pool member, reading the thread shell's
 * `activeProviderThreadId` so the badge matches the sidebar immediately even before
 * full thread projection loads.
 */
export function useActivePoolMember(input: {
  readonly routeKind: "draft" | "server";
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly poolEntry: ProviderInstanceEntry | null | undefined;
  readonly selectedModel: string | undefined;
  readonly reportedModelSelection?: ModelSelection | null | undefined;
  readonly providerInstances: ProviderInstanceConfigMap | undefined;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
}): ActivePoolMemberPresentation | null {
  const threadShell = useThreadShell(
    input.routeKind === "server" && input.poolEntry ? input.routeThreadRef : null,
  );
  if (!input.poolEntry) return null;
  return resolveActivePoolMember({
    poolEntry: input.poolEntry,
    selectedModel: input.selectedModel,
    reportedModelSelection: input.reportedModelSelection,
    activeProviderThreadId: threadShell?.activeProviderThreadId,
    providerInstances: input.providerInstances,
    providerInstanceEntries: input.providerInstanceEntries,
  });
}

/**
 * Dual-corner Pool icon: Pool stacked-layers mark with a top-left Pool accent badge and a
 * bottom-right active member badge. Falls back to Pool's own badge when unbound.
 */
export const PoolProviderIcon = memo(function PoolProviderIcon(props: {
  readonly poolDisplayName: string;
  readonly poolAccentColor?: string | undefined;
  readonly activeMember: ActivePoolMemberPresentation | null;
  readonly size?: "default" | "compact";
  readonly badgeContent?: "initials" | "none";
  readonly className?: string;
  readonly iconClassName?: string;
  readonly badgeClassName?: string;
  readonly indicatorBackground?: string;
}) {
  const poolAccent = normalizeProviderAccentColor(props.poolAccentColor);
  const memberAccent = normalizeProviderAccentColor(props.activeMember?.accentColor);
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const size = props.size ?? "default";
  const badgeContent = props.badgeContent ?? "initials";

  if (!props.activeMember) {
    return (
      <ProviderInstanceIcon
        driverKind={POOL_DRIVER_KIND}
        displayName={props.poolDisplayName}
        accentColor={poolAccent}
        showBadge={Boolean(poolAccent)}
        badgeContent={badgeContent}
        size={size}
        indicatorBackground={indicatorBackground}
        {...(props.className ? { className: props.className } : {})}
        {...(props.iconClassName ? { iconClassName: props.iconClassName } : {})}
        {...(props.badgeClassName ? { badgeClassName: props.badgeClassName } : {})}
      />
    );
  }

  const accentStyle = memberAccent
    ? ({
        "--provider-accent": memberAccent,
        "--provider-accent-foreground": providerAccentForegroundColor(memberAccent),
      } as CSSProperties)
    : undefined;

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-pool-icon="true"
      data-pool-active-member={props.activeMember.instanceId}
      data-pool-accent-color={poolAccent}
      data-provider-accent-color={memberAccent}
    >
      <ProviderInstanceIcon
        driverKind={POOL_DRIVER_KIND}
        displayName={props.poolDisplayName}
        showBadge={false}
        size={size}
        className="z-0 size-full"
        iconClassName={cn(size === "compact" ? "size-3.5" : "size-4", props.iconClassName)}
      />
      {poolAccent ? (
        <span
          className={cn(
            "pointer-events-none absolute -top-0.5 -left-0.5 z-40 rounded-full border opacity-100",
            badgeContent === "none"
              ? "size-1.5"
              : size === "compact"
                ? "size-[7px] shadow-xs"
                : "size-2 shadow-xs",
          )}
          style={{
            borderColor: indicatorBackground,
            backgroundColor: poolAccent,
          }}
          data-pool-badge="true"
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          "pointer-events-none absolute z-40 flex items-center justify-center rounded-full border leading-none opacity-100",
          badgeContent === "none"
            ? "right-[-0.1875rem] bottom-[-0.1875rem] size-2 px-0"
            : size === "compact"
              ? "right-[-0.25rem] bottom-[-0.1875rem] h-[11px] min-w-[11px] px-0.5 text-5xs font-semibold shadow-sm"
              : "right-[-0.25rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs font-semibold shadow-sm",
          memberAccent
            ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
            : "bg-card text-foreground",
          props.badgeClassName,
        )}
        style={{
          borderColor: indicatorBackground,
          backgroundColor: memberAccent ?? "var(--card)",
          color: memberAccent ? providerAccentForegroundColor(memberAccent) : "var(--foreground)",
        }}
        data-pool-active-badge="true"
        aria-hidden
      >
        {badgeContent === "initials"
          ? providerInstanceInitials(props.activeMember.displayName)
          : null}
      </span>
    </span>
  );
});

export const SidebarPoolProviderIcon = memo(function SidebarPoolProviderIcon(props: {
  readonly activeProviderThreadId: string | null | undefined;
  readonly poolEntry: PoolMemberLookupEntry;
  readonly providerEntryByInstanceId: ReadonlyMap<string, PoolMemberLookupEntry>;
  readonly badgeContent?: "initials" | "none";
  readonly indicatorBackground?: string;
  readonly iconClassName?: string;
}) {
  const activeMember = resolveSidebarPoolMember({
    activeProviderThreadId: props.activeProviderThreadId,
    poolInstanceId: props.poolEntry.instanceId,
    providerEntryByInstanceId: props.providerEntryByInstanceId,
  });
  return (
    <PoolProviderIcon
      poolDisplayName={props.poolEntry.displayName}
      poolAccentColor={props.poolEntry.accentColor}
      activeMember={activeMember}
      size="compact"
      badgeContent={props.badgeContent ?? "initials"}
      indicatorBackground={props.indicatorBackground ?? "var(--card)"}
      iconClassName={props.iconClassName ?? "opacity-60"}
    />
  );
});
