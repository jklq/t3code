import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { formatRelativeTimeLabel } from "../timestampFormat";
import {
  CADENCE_PRESETS,
  FORK_WORKFLOW_FILE,
  type ForkConfig,
  latestForkRun,
  NIGHTLY_AGE_PRESETS,
  parseTagList,
  pendingInstall,
  readForkConfig,
  writeForkConfig,
} from "./forkConfig";

const FALLBACK_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const requestStamp = () => new Date().toISOString();

// Every machine keeps its own copy of the settings, so read the fork workflow file on each of them.
const forkDefinitionsAcross = Atom.family((environmentIdsKey: string) => {
  const sources = (JSON.parse(environmentIdsKey) as EnvironmentId[]).map((environmentId) => ({
    environmentId,
    atom: serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  }));
  return Atom.make((get) =>
    sources.map(({ environmentId, atom }) => {
      const files = AsyncResult.getOrElse(get(atom), () => null);
      const file = files?.files.find((entry) => entry.name === FORK_WORKFLOW_FILE) ?? null;
      return { environmentId, loaded: files !== null, source: file?.source ?? null };
    }),
  );
});

/** Settings → Fork: how this fork follows upstream nightlies and which machines it updates. */
export function ForkSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId ? <ForkSettings environmentId={environmentId} /> : null}
    </SettingsPageContainer>
  );
}

function ForkSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const environmentIds = environments.map((environment) => environment.environmentId);
  if (!environmentIds.includes(environmentId)) environmentIds.unshift(environmentId);
  const copies = useAtomValue(forkDefinitionsAcross(JSON.stringify(environmentIds)));
  const save = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "fork settings save",
  });
  const [failure, setFailure] = useState<string | null>(null);
  const here = copies.find((copy) => copy.environmentId === environmentId);
  const config = here?.source ? readForkConfig(here.source) : null;
  if (!here?.loaded) return null;

  if (!here.source || !config) {
    return (
      <SettingsSection id="fork-updates" title={gt("Updates")}>
        <SettingsRow
          title={gt("Fork updates are not set up on this machine")}
          description={
            <T>
              Turn on Settings → Labs → Workflows, then run <code>node fork/cli.ts setup</code> in
              the fork checkout.
            </T>
          }
        />
      </SettingsSection>
    );
  }

  const mergeEnvironmentId = (config.mergeEnvironmentId as EnvironmentId | null) ?? environmentId;
  const setUp = new Set(copies.filter((copy) => copy.source).map((copy) => copy.environmentId));
  // Every machine that has the fork gets the same settings, so the one that merges agrees.
  const update = async (patch: Partial<ForkConfig>) => {
    setFailure(null);
    for (const copy of copies) {
      if (!copy.source) continue;
      const result = await save({
        environmentId: copy.environmentId,
        input: { name: FORK_WORKFLOW_FILE, source: writeForkConfig(copy.source, patch) },
      });
      if (result._tag === "Failure") setFailure(gt("Could not save the fork settings."));
      else if (result.value.problems.length > 0) {
        setFailure(result.value.problems.map((problem) => problem.message).join("\n"));
      }
    }
  };

  return (
    <>
      <SettingsSection id="fork-updates" title={gt("Updates")}>
        <UpdateStatusRow
          environmentId={environmentId}
          mergeEnvironmentId={mergeEnvironmentId}
          config={config}
          failure={failure}
          onCheckNow={() => void update({ requestedAt: requestStamp() })}
        />
        <SettingsRow
          title={gt("Check for nightlies")}
          description={gt("How often the fork looks for a newer upstream nightly.")}
          control={
            <HoursSelect
              label={gt("Check for nightlies")}
              value={config.cadenceHours}
              presets={CADENCE_PRESETS}
              onChange={(cadenceHours) => void update({ cadenceHours })}
            />
          }
        />
        <SettingsRow
          title={gt("Minimum nightly age")}
          description={gt(
            "How long a nightly must be out first, so a broken one can be replaced upstream.",
          )}
          control={
            <HoursSelect
              label={gt("Minimum nightly age")}
              value={config.minNightlyAgeHours}
              presets={NIGHTLY_AGE_PRESETS}
              onChange={(minNightlyAgeHours) => void update({ minNightlyAgeHours })}
            />
          }
        />
        <SettingsRow
          title={gt("Hold at nightly")}
          description={gt("Stay on one nightly tag instead of following the newest.")}
          control={
            <Input
              key={`pin:${config.pinTag ?? ""}`}
              aria-label={gt("Hold at nightly")}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={gt("Newest nightly")}
              defaultValue={config.pinTag ?? ""}
              onBlur={(event) => {
                const pinTag = event.target.value.trim() || null;
                if (pinTag !== config.pinTag) void update({ pinTag });
              }}
            />
          }
        />
        <SettingsRow
          title={gt("Skip nightlies")}
          description={gt("Nightly tags the fork never moves to, separated by commas.")}
          control={
            <Input
              key={`skip:${config.skipTags.join(",")}`}
              aria-label={gt("Skip nightlies")}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={gt("None")}
              defaultValue={config.skipTags.join(", ")}
              onBlur={(event) => {
                const skipTags = parseTagList(event.target.value);
                if (skipTags.join(",") !== config.skipTags.join(",")) void update({ skipTags });
              }}
            />
          }
        />
        <SettingsRow
          title={gt("Install updates automatically")}
          description={gt(
            "Install each update once it builds, instead of asking. T3 Code restarts to install.",
          )}
          control={
            <Switch
              checked={config.autoInstall}
              aria-label={gt("Install updates automatically")}
              onCheckedChange={(autoInstall) => void update({ autoInstall })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="fork-merging" title={gt("Merging")}>
        <SettingsRow
          title={gt("Merges on")}
          description={
            <T>
              Rebases your fork onto each nightly and runs the agents below. Pick a machine that is
              always on. To add one, run <code>node ~/.t3/fork/cli.ts setup-host</code> with its SSH
              host on this machine.
            </T>
          }
          control={
            <MergeHostSelect
              environments={environments}
              value={mergeEnvironmentId}
              setUp={setUp}
              onChange={(next) =>
                void update({ mergeEnvironmentId: next === environmentId ? null : next })
              }
            />
          }
        />
        <ForkModelRow
          environmentId={mergeEnvironmentId}
          title={gt("Conflict model")}
          description={gt(
            "Resolves a conflict between an update and your changes, or fixes a failed build. Runs only when an update needs it.",
          )}
          selection={config.models.resolve}
          onChange={(resolve) => void update({ models: { ...config.models, resolve } })}
        />
        <ForkModelRow
          environmentId={mergeEnvironmentId}
          title={gt("Fallback model")}
          description={gt("Tries once when the conflict model gives up, before asking you.")}
          selection={config.models.escalate}
          onChange={(escalate) => void update({ models: { ...config.models, escalate } })}
        />
        <SettingsRow
          title={gt("Review merges")}
          description={gt(
            "After every rebase git finishes on its own, a model checks for what git misses: fork changes that still apply but no longer fit the new upstream code. Uses tokens on every update.",
          )}
          control={
            <Switch
              checked={config.reviewMerges === true}
              aria-label={gt("Review merges")}
              onCheckedChange={(reviewMerges) => void update({ reviewMerges })}
            />
          }
        />
        {config.reviewMerges === true ? (
          <ForkModelRow
            environmentId={mergeEnvironmentId}
            title={gt("Review model")}
            description={gt("Fixes what it finds, or asks you before the update is published.")}
            selection={config.models.review ?? config.models.resolve}
            onChange={(review) => void update({ models: { ...config.models, review } })}
          />
        ) : null}
      </SettingsSection>
    </>
  );
}

function MergeHostSelect(props: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly value: EnvironmentId;
  readonly setUp: ReadonlySet<EnvironmentId>;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const selected = props.environments.find(
    (environment) => environment.environmentId === props.value,
  );
  const option = (environment: EnvironmentPresentation) => (
    <span className="flex min-w-0 items-center gap-2">
      <EnvironmentMachineIcon
        aria-hidden
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate">{environment.label}</span>
    </span>
  );
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (value && value !== props.value) props.onChange(value as EnvironmentId);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={gt("Merges on")}>
        <SelectValue>{selected ? option(selected) : gt("Unavailable machine")}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.environments.map((environment) => {
          const ready = props.setUp.has(environment.environmentId);
          return (
            <SelectItem
              key={environment.environmentId}
              hideIndicator
              value={environment.environmentId}
              disabled={!ready}
            >
              <span className="flex w-full items-center justify-between gap-3">
                {option(environment)}
                {ready ? null : (
                  <span className="text-xs text-muted-foreground">{gt("Not set up")}</span>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

function UpdateStatusRow(props: {
  readonly environmentId: EnvironmentId;
  readonly mergeEnvironmentId: EnvironmentId;
  readonly config: ForkConfig;
  readonly failure: string | null;
  readonly onCheckNow: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const live = useEnvironmentQuery(
    serverEnvironment.workflowsLive({ environmentId: props.environmentId, input: {} }),
  );
  const merging = useEnvironmentQuery(
    serverEnvironment.workflowsLive({ environmentId: props.mergeEnvironmentId, input: {} }),
  );
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "fork install answer",
  });
  const install = pendingInstall(live.data?.questions ?? [], live.data?.runs ?? []);
  const latest = latestForkRun(merging.data?.runs ?? []);
  const running = latest !== null && latest.endedAt === null;
  const requested =
    props.config.requestedAt !== null && (!latest || latest.startedAt < props.config.requestedAt);

  if (install) {
    const respond = (choice: "install" | "skip") =>
      void answer({
        environmentId: props.environmentId,
        input: { runId: install.runId, name: install.name, choice },
      });
    return (
      <SettingsRow
        title={
          install.version
            ? gt("Version {version} is ready to install", { version: install.version })
            : gt("An update is ready to install")
        }
        description={gt("Installing restarts T3 Code. Your other machines follow it.")}
        control={
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => respond("skip")}>
              <T>Skip</T>
            </Button>
            <Button size="xs" onClick={() => respond("install")}>
              <T>Install</T>
            </Button>
          </div>
        }
      />
    );
  }

  const description = requested
    ? gt("A check starts within 5 minutes.")
    : latest
      ? gt("{detail} · {when}", {
          detail: latest.detail ?? latest.title,
          when: formatRelativeTimeLabel(latest.startedAt, undefined, messages),
        })
      : gt("No update has run yet.");
  return (
    <SettingsRow
      title={running ? gt("Updating") : gt("Last check")}
      description={description}
      status={props.failure}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={running || requested}
          onClick={props.onCheckNow}
        >
          <T>Check now</T>
        </Button>
      }
    />
  );
}

function HoursSelect(props: {
  readonly label: string;
  readonly value: number;
  readonly presets: ReadonlyArray<number>;
  readonly onChange: (hours: number) => void;
}) {
  const gt = useGT();
  const hoursLabel = (hours: number) =>
    hours === 0
      ? gt("No minimum")
      : hours === 24
        ? gt("Daily")
        : hours === 168
          ? gt("Weekly")
          : hours % 24 === 0
            ? gt("{count} days", { count: hours / 24 })
            : gt("{count, plural, one {{count} hour} other {{count} hours}}", { count: hours });
  const options = props.presets.includes(props.value)
    ? props.presets
    : [...props.presets, props.value].toSorted((a, b) => a - b);
  return (
    <Select
      value={String(props.value)}
      onValueChange={(value) => {
        const hours = Number(value);
        if (hours !== props.value) props.onChange(hours);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={props.label}>
        <SelectValue>{hoursLabel(props.value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((hours) => (
          <SelectItem key={hours} hideIndicator value={String(hours)}>
            {hoursLabel(hours)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The same pickers as the text generation model: provider and model, then its traits. */
function ForkModelRow(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly description: string;
  readonly selection: ModelSelection;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const { instanceId, model, options } = props.selection;
  const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ProviderModelPicker
            environmentId={props.environmentId}
            activeInstanceId={instanceId}
            model={model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={getCustomModelOptionsByInstance(
              settings,
              providers,
              instanceId,
              model,
            )}
            isComposerOwned={false}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onOpenProviderSetup={(setupInstanceId: ProviderInstanceId) => {
              void navigate({
                to: "/settings/providers",
                search: { environmentId: props.environmentId, instanceId: setupInstanceId },
              });
            }}
            onInstanceModelChange={(nextInstanceId, nextModel) =>
              props.onChange(pickModelSelection(props.selection, nextInstanceId, nextModel))
            }
          />
          {entry ? (
            <TraitsPicker
              provider={entry.driverKind ?? FALLBACK_DRIVER_KIND}
              models={entry.models}
              model={model}
              modelOptions={options}
              allowPromptInjectedEffort={false}
              includePlanAgent={selectsPlanAgent(options)}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(nextOptions) =>
                props.onChange(createModelSelection(instanceId, model, nextOptions))
              }
            />
          ) : null}
        </div>
      }
    />
  );
}
