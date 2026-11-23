#!/usr/bin/env node
// Fork maintenance engine. Deterministic: git, gh and ssh only. Agents are never called from
// here; the T3 workflow (fork/t3-workflow.ts) calls an agent only when a command below reports a
// conflict or a failed build. Every command prints one JSON object on stdout. See FORK.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

type Model = { instanceId: string; model: string };
type Machine =
  | { name: string; kind: "ssh-launched"; ssh: string; environmentId?: string }
  | { name: string; kind: "ssh-service"; ssh: string; t3?: string; environmentId?: string }
  | { name: string; kind: "command"; run: string; environmentId?: string };
type Config = {
  repo: string;
  upstream: string;
  branch: string;
  cadenceHours: number;
  minNightlyAgeHours: number;
  pinTag: string | null;
  skipTags: string[];
  autoInstall: boolean;
  app: string;
  node: string;
  models: { resolve: Model; escalate: Model; review?: Model };
  fleet: Machine[];
  /** codesign identity for installed apps; null picks a Developer ID or Apple Development one. */
  signingIdentity?: string | null;
  /** Review each finished rebase with models.review before publishing. */
  reviewMerges: boolean;
  /** Set by Settings → Fork's "Check now"; the next tick runs an update. */
  requestedAt: string | null;
  /** The T3 Code environment that merges (rebases, runs agents, publishes). Null: the machine
   * with the desktop app. Every machine keeps the same settings; only that one merges. */
  mergeEnvironmentId: string | null;
};

const FORK_HOME = process.env.T3_FORK_HOME ?? NodePath.join(NodeOS.homedir(), ".t3", "fork");
const REPO = NodePath.join(FORK_HOME, "repo");
const LEGACY_CONFIG_PATH = NodePath.join(FORK_HOME, "config.json");
const WORKFLOWS =
  process.env.T3CODE_WORKFLOWS ?? NodePath.join(NodeOS.homedir(), ".t3", "workflows");
// The settings live in the installed workflow file, so T3 Code's settings page can edit them
// through the workflow definition API. Keep in sync with apps/web/src/fork/forkConfig.ts.
const WORKFLOW_FILE = NodePath.join(WORKFLOWS, "fork-sync.ts");
const CONFIG_BLOCK =
  /(\/\/ fork-config:begin[^\n]*\nconst FORK_CONFIG = )([\s\S]*?);\n(\/\/ fork-config:end)/;
const T3_HOME = process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3");
const lockPath = (name: string) => NodePath.join(FORK_HOME, `lock-${name}.json`);
const LOCK_TTL_HOURS: Record<string, number> = { update: 6, install: 8 * 24 };
const STATE_PATH = NodePath.join(FORK_HOME, "state.json");
const BUILD = NodePath.join(FORK_HOME, "build");
const BUNDLE_DIRS = ["apps/server/dist", "apps/desktop/dist-electron"];
const NIGHTLY = /^v(\d+\.\d+\.\d+-nightly\.\d{8}\.)(\d+)$/;

const DEFAULTS: Config = {
  repo: "jklq/t3code",
  upstream: "pingdotgg/t3code",
  branch: "fork",
  cadenceHours: 24,
  minNightlyAgeHours: 6,
  pinTag: null,
  skipTags: [],
  autoInstall: false,
  app: "/Applications/T3 Code (Nightly).app",
  node: process.execPath,
  models: {
    resolve: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    escalate: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  },
  fleet: [],
  requestedAt: null,
  mergeEnvironmentId: null,
  reviewMerges: false,
};

const readJson = <T>(path: string, fallback: T): T =>
  NodeFS.existsSync(path) ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as T) : fallback;
function storedConfig(): Partial<Config> {
  if (NodeFS.existsSync(WORKFLOW_FILE)) {
    const block = CONFIG_BLOCK.exec(NodeFS.readFileSync(WORKFLOW_FILE, "utf8"));
    if (block) return JSON.parse(block[2]!) as Partial<Config>;
  }
  return readJson<Partial<Config>>(LEGACY_CONFIG_PATH, {});
}
const config = (): Config => ({ ...DEFAULTS, ...storedConfig() });
function writeConfig(next: Partial<Config>) {
  const source = NodeFS.readFileSync(WORKFLOW_FILE, "utf8");
  if (!CONFIG_BLOCK.test(source))
    throw new Error(`${WORKFLOW_FILE} has no fork-config block; run setup.`);
  NodeFS.writeFileSync(
    WORKFLOW_FILE,
    source.replace(
      CONFIG_BLOCK,
      (_, head: string, _body, tail: string) => `${head}${JSON.stringify(next, null, 2)};\n${tail}`,
    ),
  );
}
const ownEnvironmentId = () =>
  readText(NodePath.join(T3_HOME, "userdata", "environment-id"))?.trim() ?? null;
const readText = (path: string) =>
  NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null;
const hasDesktopApp = (cfg: Config) => NodeFS.existsSync(cfg.app);
const state = () =>
  readJson<{ lastCheckAt?: string; lastRequestAt?: string; declined?: string[] }>(STATE_PATH, {});
const saveState = (patch: object) =>
  NodeFS.writeFileSync(STATE_PATH, JSON.stringify({ ...state(), ...patch }, null, 2) + "\n");

const PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  NodePath.join(NodeOS.homedir(), ".local/bin"),
  process.env.PATH,
].join(":");

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; allowFail?: boolean; env?: object; input?: string } = {},
) {
  return new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      cmd,
      args,
      {
        cwd: opts.cwd ?? REPO,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PATH, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", ...opts.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (code !== 0 && !opts.allowFail) {
          reject(
            new Error(
              `${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`.slice(0, 4000),
            ),
          );
        } else resolve({ code, out: stdout.trim(), err: stderr.trim() });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
const git = async (...args: string[]) => (await sh("git", args)).out;
const gitTry = (...args: string[]) => sh("git", args, { allowFail: true });

/** Upstream nightly tags, newest first. */
async function upstreamNightlies(): Promise<string[]> {
  const refs = await git("for-each-ref", "--format=%(refname:lstrip=2)", "refs/upstream-tags/");
  return refs
    .split("\n")
    .filter((tag) => NIGHTLY.test(tag))
    .sort((a, b) => Number(NIGHTLY.exec(b)![2]) - Number(NIGHTLY.exec(a)![2]));
}

const tagCommit = (tag: string) => git("rev-parse", `refs/upstream-tags/${tag}^{commit}`);

async function baseOf(ref: string): Promise<{ commit: string; tag: string | null }> {
  const commit = await git("merge-base", ref, "upstream/main");
  const tags = await git(
    "for-each-ref",
    "--points-at",
    commit,
    "--format=%(refname:lstrip=2)",
    "refs/upstream-tags/",
  );
  return { commit, tag: tags.split("\n").find((tag) => NIGHTLY.test(tag)) ?? null };
}

/** Fork releases on origin, tagged with the upstream nightly they are built on. */
async function forkReleases(): Promise<Array<{ tag: string; commit: string }>> {
  const { out } = await sh("git", ["ls-remote", "--tags", "origin", "v*-nightly.*"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, ref] = line.split("\t");
      return {
        tag: ref!.replace(/^refs\/tags\/|\^\{\}$/g, ""),
        commit: commit!,
        peeled: ref!.endsWith("^{}"),
      };
    })
    .filter((r, _, all) => r.peeled || !all.some((o) => o.peeled && o.tag === r.tag))
    .map(({ tag, commit }) => ({ tag, commit }));
}

async function ensureRepo(cfg: Config) {
  NodeFS.mkdirSync(FORK_HOME, { recursive: true });
  if (!NodeFS.existsSync(NodePath.join(REPO, ".git"))) {
    await sh(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--branch",
        cfg.branch,
        `git@github.com:${cfg.repo}.git`,
        REPO,
      ],
      {
        cwd: FORK_HOME,
      },
    );
  }
  if ((await gitTry("remote", "get-url", "upstream")).code !== 0) {
    await git("remote", "add", "upstream", `https://github.com/${cfg.upstream}.git`);
    await git("config", "remote.upstream.tagOpt", "--no-tags");
    await git("config", "remote.upstream.fetch", "+refs/heads/main:refs/remotes/upstream/main");
    await git("config", "--add", "remote.upstream.fetch", "+refs/tags/v*:refs/upstream-tags/v*");
    await git("config", "rerere.enabled", "true");
    await git("config", "rerere.autoupdate", "true");
  }
  // Commits need an author on machines that never set one.
  if ((await gitTry("config", "user.email")).code !== 0) {
    await git("config", "user.name", "t3code fork");
    await git("config", "user.email", "t3code-fork@users.noreply.github.com");
  }
}

async function fetchAll(cfg: Config) {
  await ensureRepo(cfg);
  await git(
    "fetch",
    "--quiet",
    "--prune",
    "origin",
    `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`,
  );
  await git("fetch", "--quiet", "upstream");
}

const rebaseInProgress = () =>
  NodeFS.existsSync(NodePath.join(REPO, ".git", "rebase-merge")) ||
  NodeFS.existsSync(NodePath.join(REPO, ".git", "rebase-apply"));

let ghToken: Promise<string | null> | undefined;
/** gh is optional (a merging Linux machine may lack it); reads go through GitHub's REST API. */
const hasGh = async () =>
  (await sh("gh", ["--version"], { allowFail: true, cwd: FORK_HOME })).code === 0;
async function github<T>(path: string): Promise<T | null> {
  ghToken ??= (async () => {
    const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (env) return env;
    const r = await sh("gh", ["auth", "token"], { allowFail: true, cwd: FORK_HOME });
    return r.code === 0 && r.out ? r.out : null;
  })();
  const token = await ghToken;
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "t3code-fork",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => null);
  return response?.ok ? ((await response.json()) as T) : null;
}

async function nightlyPublishedAt(cfg: Config, tag: string): Promise<number | null> {
  const release = await github<{ published_at: string | null; draft: boolean }>(
    `repos/${cfg.upstream}/releases/tags/${tag}`,
  );
  return release && !release.draft && release.published_at
    ? Date.parse(release.published_at)
    : null;
}

const commands: Record<string, (args: string[]) => Promise<unknown>> = {
  /** Whether the timer should start an update now (cadenceHours since the last check). */
  async due() {
    const cfg = config();
    const mergesHere = cfg.mergeEnvironmentId
      ? cfg.mergeEnvironmentId === ownEnvironmentId()
      : hasDesktopApp(cfg);
    if (!mergesHere) return { due: false, reason: "merges on another machine" };
    const { lastCheckAt: last, lastRequestAt } = state();
    const requested = cfg.requestedAt !== null && cfg.requestedAt !== lastRequestAt;
    const due =
      requested ||
      !last ||
      Date.now() - Date.parse(last) >= cfg.cadenceHours * 3600_000 - 5 * 60_000;
    if (due)
      saveState({
        lastCheckAt: new Date().toISOString(),
        lastRequestAt: cfg.requestedAt ?? undefined,
      });
    return { due, requested, lastCheckAt: last ?? null, cadenceHours: cfg.cadenceHours };
  },

  /** One update at a time: a run takes the lock, and its onEnd (or a passed build) releases it. */
  async lock([id, name = "update"]) {
    const path = lockPath(name);
    const held = readJson<{ id: string; at: string } | null>(path, null);
    const ttl = (LOCK_TTL_HOURS[name] ?? 6) * 3600_000;
    if (held && held.id !== id && Date.now() - Date.parse(held.at) < ttl)
      return { acquired: false, heldBy: held.id };
    NodeFS.writeFileSync(path, JSON.stringify({ id, at: new Date().toISOString() }) + "\n");
    return { acquired: true };
  },

  async unlock([id, name = "update"]) {
    const path = lockPath(name);
    const held = readJson<{ id: string } | null>(path, null);
    if (held?.id === id) NodeFS.rmSync(path, { force: true });
    return { released: held?.id === id };
  },

  /** On a machine with the desktop app: a fork release it should offer to install, if any. A build
   * from `ship` is newer than the GitHub release of its own version, so only a newer version or a
   * replaced release of a version the app got from GitHub counts. */
  async "install-check"() {
    const cfg = config();
    if (!hasDesktopApp(cfg)) return { action: "none", reason: "no desktop app here" };
    const marker = installedMarker(cfg);
    const installed = await installedDesktopVersion(cfg);
    if (!marker || !installed) return { action: "none", reason: "the app is not a fork build" };
    await ensureRepo(cfg);
    const newest = (await forkReleases())
      .filter((r) => NIGHTLY.test(r.tag))
      .sort((a, b) => nightlyRun(b.tag) - nightlyRun(a.tag))[0];
    if (!newest) return { action: "none", reason: "no fork release yet" };
    const published = await github<{ draft: boolean }>(
      `repos/${cfg.repo}/releases/tags/${newest.tag}`,
    );
    if (!published || published.draft)
      return { action: "none", reason: `${newest.tag} is still building` };
    const newer = nightlyRun(newest.tag) > nightlyRun(`v${installed}`);
    const replaced =
      newest.tag === `v${installed}` && !marker.local && newest.commit !== marker.commit;
    const key = `${newest.tag}@${newest.commit.slice(0, 10)}`;
    if (!newer && !replaced) return { action: "none", reason: `up to date on v${installed}` };
    if (state().declined?.includes(key))
      return { action: "none", reason: `${newest.tag} was skipped` };
    return { action: "install", version: newest.tag.slice(1), key };
  },

  async decline([key]) {
    saveState({ declined: [...(state().declined ?? []), key!].slice(-20) });
    return { declined: key };
  },

  /** Decide what to do: rebase onto a newer nightly, release new fork commits, or nothing. */
  async plan() {
    const cfg = config();
    await fetchAll(cfg);
    if (rebaseInProgress()) await gitTry("rebase", "--abort");
    const head = await git("rev-parse", `origin/${cfg.branch}`);
    const base = await baseOf(head);
    let target: string | null = cfg.pinTag;
    if (!target) {
      for (const tag of await upstreamNightlies()) {
        if (cfg.skipTags.includes(tag)) continue;
        if (tag === base.tag) break;
        const publishedAt = await nightlyPublishedAt(cfg, tag);
        if (publishedAt !== null && Date.now() - publishedAt >= cfg.minNightlyAgeHours * 3600_000) {
          target = tag;
          break;
        }
      }
    }
    if (target && target !== base.tag && (await tagCommit(target)) !== base.commit) {
      return {
        action: "update",
        target,
        from: base.tag,
        reason: `${base.tag ?? base.commit.slice(0, 10)} → ${target}`,
      };
    }
    const releases = await forkReleases();
    if (releases.some((r) => r.commit === head)) {
      return {
        action: "none",
        target: base.tag,
        from: base.tag,
        reason: `up to date on ${base.tag}`,
      };
    }
    // New fork commits reach GitHub releases with the next nightly; `ship` puts them on
    // this Mac at once. Only a base the fork never released is built now.
    if (base.tag && !releases.some((r) => r.tag === base.tag)) {
      return {
        action: "update",
        target: base.tag,
        from: base.tag,
        reason: `first fork build of ${base.tag}`,
      };
    }
    return {
      action: "none",
      target: base.tag,
      from: base.tag,
      reason: `new fork commits ship with the next nightly (ship puts them on your machines now)`,
    };
  },

  /** Reset to origin's fork branch, then rebase it onto an upstream nightly tag (a no-op for the
   * current base). Stops at the first conflict rerere cannot resolve. */
  async rebase([target]) {
    const cfg = config();
    if (!target || !NIGHTLY.test(target)) throw new Error("usage: rebase <upstream nightly tag>");
    if (rebaseInProgress()) await gitTry("rebase", "--abort");
    await fetchAll(cfg);
    await git("checkout", "--quiet", "-B", cfg.branch, `origin/${cfg.branch}`);
    await git("reset", "--quiet", "--hard", `origin/${cfg.branch}`);
    const { commit: oldBase } = await baseOf("HEAD");
    const onto = await tagCommit(target);
    if (onto === oldBase) return { status: "done", changed: false };
    await gitTry("rebase", "--onto", onto, oldBase, cfg.branch);
    return settle();
  },

  /** After conflicts were fixed in the working tree: stage them and keep rebasing. */
  async continue() {
    if (!rebaseInProgress()) return settle();
    const files = await conflictedFiles();
    const marked = await markerFiles(files);
    if (marked.length > 0)
      return { status: "conflict", ...(await conflictInfo()), stillMarked: marked };
    if (files.length > 0) await git("add", "--", ...files);
    await gitTry("rebase", "--continue");
    return settle();
  },

  /** What a merge review looks at, after a rebase finished and before publish: the stack before and
   * after, and the files both the fork and upstream changed in between. */
  async "review-scope"() {
    const cfg = config();
    const previous = await git("rev-parse", `origin/${cfg.branch}`);
    const oldBase = (await baseOf(previous)).commit;
    const newBase = (await baseOf("HEAD")).commit;
    const files = async (...range: string[]) =>
      (await git("diff", "--name-only", ...range)).split("\n").filter(Boolean);
    const forkFiles = await files(newBase, "HEAD");
    const upstreamFiles = new Set(await files(oldBase, newBase));
    return {
      repo: REPO,
      oldBase: oldBase.slice(0, 12),
      newBase: newBase.slice(0, 12),
      previous: previous.slice(0, 12),
      forkFiles,
      bothChanged: forkFiles.filter((file) => upstreamFiles.has(file)),
      upstreamCommits: Number(await git("rev-list", "--count", `${oldBase}..${newBase}`)),
    };
  },

  async abort() {
    if (rebaseInProgress()) await git("rebase", "--abort");
    return { status: "aborted" };
  },

  /** Push the fork branch and tag it with its upstream nightly's version; fork-release.yml builds
   * it. `--replace` moves an existing tag (only for fixing a build that never passed). */
  async publish([flag]) {
    const cfg = config();
    if (rebaseInProgress()) throw new Error("A rebase is still in progress.");
    await ensureRepo(cfg);
    if ((await git("rev-parse", "--abbrev-ref", "HEAD")) !== cfg.branch) {
      throw new Error(`Run rebase first; ${REPO} is not on ${cfg.branch}.`);
    }
    const commit = await git("rev-parse", "HEAD");
    const base = await baseOf(commit);
    if (!base.tag)
      throw new Error(`The fork's base ${base.commit} is not an upstream nightly tag.`);
    const tag = base.tag;
    const existing = (await forkReleases()).find((r) => r.tag === tag);
    if (existing && existing.commit !== commit && flag !== "--replace") {
      throw new Error(
        `${tag} is already released from ${existing.commit.slice(0, 10)}; fork commits ship with the next nightly.`,
      );
    }
    await lockdownActions(cfg);
    await sh("git", [
      "push",
      "--quiet",
      `--force-with-lease=${cfg.branch}`,
      "origin",
      `${commit}:refs/heads/${cfg.branch}`,
    ]);
    if (existing?.commit !== commit) {
      await git("-c", "tag.gpgSign=false", "tag", "--force", tag, commit);
      await git("push", "--quiet", "--force", "origin", `refs/tags/${tag}`);
    }
    await ensureReleaseRun(cfg, tag, commit);
    // The workflow runs the engine from this copy, which stays usable while the repo is mid-rebase.
    NodeFS.copyFileSync(NodePath.join(REPO, "fork", "cli.ts"), NodePath.join(FORK_HOME, "cli.ts"));
    return { tag, version: tag.slice(1), commit, base: base.tag };
  },

  /** Wait for fork-release.yml on a tag. Reports the failing jobs, and their log tail when gh is
   * available (logs need a signed-in client). */
  async "await-ci"([tag, timeoutMinutes = "180"]) {
    const cfg = config();
    await ensureRepo(cfg);
    const tagSha = (await forkReleases()).find((r) => r.tag === tag)?.commit ?? null;
    const deadline = Date.now() + Number(timeoutMinutes) * 60_000;
    for (;;) {
      const run = await findReleaseRun(cfg, tag!, tagSha);
      if (run?.status === "completed") {
        if (run.conclusion === "success") return { status: "success", url: run.html_url };
        const jobs = await github<{ jobs: Array<{ name: string; conclusion: string | null }> }>(
          `repos/${cfg.repo}/actions/runs/${run.id}/jobs?per_page=100`,
        );
        const failedJobs = (jobs?.jobs ?? [])
          .filter((j) => j.conclusion === "failure")
          .map((j) => j.name);
        const log = (await hasGh())
          ? await sh("gh", ["run", "view", String(run.id), "-R", cfg.repo, "--log-failed"], {
              allowFail: true,
            })
          : { out: "" };
        const logTail = log.out
          .split("\n")
          .slice(-120)
          .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ /, ""))
          .join("\n");
        return { status: "failure", url: run.html_url, runId: String(run.id), failedJobs, logTail };
      }
      if (Date.now() > deadline) return { status: "timeout", url: run?.html_url ?? null };
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  },

  /** Re-run only the failed jobs of a fork release run (for runner flakes). Needs gh. */
  async "rerun-ci"([runId]) {
    if (!(await hasGh())) return { status: "unavailable", runId };
    await sh("gh", ["run", "rerun", runId!, "--failed", "-R", config().repo]);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return { status: "rerun", runId };
  },

  async "install-desktop"([version, flag]) {
    const cfg = config();
    if (!version) throw new Error("usage: install-desktop <version> [--now]");
    await ensureRepo(cfg);
    const release = (await forkReleases()).find((r) => r.tag === `v${version}`);
    if (!release) throw new Error(`No fork release v${version}.`);
    // Fork builds share upstream's version numbers, so a marker tells the two apart.
    if ((await installedForkCommit(cfg)) === release.commit)
      return { status: "already-installed", version };
    const dir = NodePath.join(FORK_HOME, "downloads", version);
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.mkdirSync(dir, { recursive: true });
    await sh("gh", [
      "release",
      "download",
      `v${version}`,
      "-R",
      cfg.repo,
      "--pattern",
      "*arm64*.zip",
      "--dir",
      dir,
    ]);
    const zip = NodeFS.readdirSync(dir).find((f) => f.endsWith(".zip"))!;
    await sh("ditto", ["-x", "-k", NodePath.join(dir, zip), NodePath.join(dir, "app")]);
    const app = NodeFS.readdirSync(NodePath.join(dir, "app")).find((f) => f.endsWith(".app"));
    if (!app) throw new Error(`${zip} holds no .app bundle.`);
    const staged = NodePath.join(dir, "app", app);
    // No feed: this unsigned build cannot self-update, so its updater stays off instead of failing.
    NodeFS.rmSync(NodePath.join(staged, "Contents", "Resources", "app-update.yml"), {
      force: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(staged, "Contents", "Resources", "fork-build.json"),
      JSON.stringify({ version, commit: release.commit }) + "\n",
    );
    await sh("xattr", ["-cr", staged]);
    await sh("codesign", ["--force", "--deep", "--sign", await signingIdentity(cfg), staged]);
    const previous = NodePath.join(FORK_HOME, "previous");
    const script = NodePath.join(FORK_HOME, "swap.sh");
    NodeFS.writeFileSync(script, swapScript(cfg.app, staged, previous, flag === "--now" ? 0 : 20));
    const child = NodeChildProcess.spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
    child.unref();
    return {
      status: "scheduled",
      version,
      app: cfg.app,
      log: NodePath.join(FORK_HOME, "swap.log"),
    };
  },

  /** Fast path: build `ref` (default origin/fork) on this Mac and on every SSH host in `fleet` at
   * once, patch each install in place, then restart T3 Code here. Only for commits on the installed
   * upstream base that change no dependencies or native code; the rest ships with the nightly. */
  async ship([ref, flag]) {
    const cfg = config();
    await fetchAll(cfg);
    const commit = await git("rev-parse", `${ref ?? `origin/${cfg.branch}`}^{commit}`);
    const version = await installedDesktopVersion(cfg);
    const installed = await installedForkCommit(cfg);
    if (!version || !installed) {
      throw new Error("The installed app is not a fork build; run install-desktop first.");
    }
    const base = await baseOf(commit);
    if (base.tag !== `v${version}`) {
      throw new Error(
        `${commit.slice(0, 10)} is on ${base.tag}, the app on v${version}; install that release first.`,
      );
    }
    if ((await gitTry("cat-file", "-e", `${installed}^{commit}`)).code !== 0) {
      await git("fetch", "--quiet", "origin", installed);
    }
    const native = (
      await git(
        "diff",
        "--name-only",
        installed,
        commit,
        "--",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "patches",
        "native",
        ":(glob)**/package.json",
      )
    )
      .split("\n")
      .filter(Boolean);
    if (native.length > 0) {
      throw new Error(
        `Dependencies or native code changed (${native.join(", ")}); this ships with the next nightly.`,
      );
    }
    const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
    const hosts = (await devices(cfg)).filter((d) => d.kind !== "command");
    const remote = hosts.map(async (m) => {
      const restart =
        m.kind === "ssh-service"
          ? `${m.t3 ?? "t3"} service restart`
          : `pkill -f "$R/t3 serve" || true`;
      const r = await sh("ssh", [...sshArgs, m.ssh, "bash -s"], {
        allowFail: true,
        cwd: FORK_HOME,
        input: buildScript(cfg, commit, version, "linux", restart),
      });
      return {
        name: m.name,
        ok: r.code === 0,
        status: (r.out || r.err).split("\n").slice(-6).join("\n"),
      };
    });
    const local = (async () => {
      const r = await sh("/bin/bash", ["-s"], {
        allowFail: true,
        cwd: FORK_HOME,
        input: buildScript(cfg, commit, version, "mac", ""),
      });
      if (r.code !== 0)
        throw new Error(`Mac build failed:\n${(r.out || r.err).split("\n").slice(-20).join("\n")}`);
      const stage = NodePath.join(FORK_HOME, "local");
      NodeFS.rmSync(stage, { recursive: true, force: true });
      NodeFS.mkdirSync(stage, { recursive: true });
      const staged = NodePath.join(stage, "app.app");
      await sh("cp", ["-cR", cfg.app, staged], { cwd: stage });
      await repackAsar(
        BUILD,
        NodePath.join(staged, "Contents", "Resources"),
        NodePath.join(stage, "asar"),
      );
      NodeFS.writeFileSync(
        NodePath.join(staged, "Contents", "Resources", "fork-build.json"),
        JSON.stringify({ version, commit, local: true }) + "\n",
      );
      await sh("xattr", ["-cr", staged], { cwd: stage });
      await sh("codesign", ["--force", "--deep", "--sign", await signingIdentity(cfg), staged], {
        cwd: stage,
      });
      return staged;
    })();
    const [staged, hostResults] = await Promise.all([local, Promise.all(remote)]);
    if (flag === "--no-restart")
      return {
        status: "staged",
        version,
        commit: commit.slice(0, 10),
        mac: staged,
        hosts: hostResults,
      };
    // Restart this Mac last, so the hosts already run the new build when the desktop reconnects.
    const grace = flag === "--now" ? 0 : 15;
    const script = NodePath.join(FORK_HOME, "swap.sh");
    NodeFS.writeFileSync(
      script,
      swapScript(cfg.app, staged, NodePath.join(FORK_HOME, "previous"), grace),
    );
    NodeChildProcess.spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    return {
      status: "shipped",
      version,
      commit: commit.slice(0, 10),
      mac: `restarts in ${grace}s`,
      hosts: hostResults,
    };
  },

  /** Put the app that the last install replaced back. */
  async rollback() {
    const cfg = config();
    const previous = NodePath.join(FORK_HOME, "previous", "app.app");
    if (!NodeFS.existsSync(previous)) throw new Error("No previous app to roll back to.");
    const staged = NodePath.join(FORK_HOME, "rollback.app");
    NodeFS.rmSync(staged, { recursive: true, force: true });
    await sh("ditto", [previous, staged]);
    const script = NodePath.join(FORK_HOME, "swap.sh");
    NodeFS.writeFileSync(
      script,
      swapScript(cfg.app, staged, NodePath.join(FORK_HOME, "previous"), 0),
    );
    NodeChildProcess.spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    return { status: "scheduled" };
  },

  /** Bring every fleet machine to a version. SSH-launched hosts follow the desktop on their own. */
  async rollout([version]) {
    const cfg = config();
    if (!version) throw new Error("usage: rollout <version>");
    const releaseBase = `https://github.com/${cfg.repo}/releases/download`;
    const results = [];
    const machines: Array<Device | Extract<Machine, { kind: "command" }>> = [
      ...(await devices(cfg)),
      ...cfg.fleet.filter((m): m is Extract<Machine, { kind: "command" }> => m.kind === "command"),
    ];
    for (const m of machines) {
      let r: { code: number; out: string; err: string };
      if (m.kind === "ssh-launched") {
        // The binary embeds the release repository, which tells a fork build from upstream's.
        r = await sh(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=20",
            m.ssh,
            `f=~/.t3/runtime/versions/${version}/t3; [ -f "$f" ] || { echo missing; exit 0; }; LC_ALL=C grep -aqF ${q(`CLI_RELEASE_REPOSITORY = "${cfg.repo}"`)} "$f" && echo fork || echo upstream`,
          ],
          { allowFail: true },
        );
        const status =
          {
            fork: "fork build installed",
            upstream: "upstream build of this version (fork build lands with the next version)",
            missing: "installs when the desktop next connects",
          }[r.out] ??
          (r.err || r.out);
        results.push({ name: m.name, ok: r.code === 0, status });
        continue;
      }
      if (m.kind === "ssh-service" && "ssh" in m) {
        const t3 = m.t3 ?? "t3";
        r = await sh(
          "ssh",
          [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=20",
            m.ssh,
            `T3CODE_RELEASE_BASE_URL=${releaseBase} ${t3} update ${version} --yes && ${t3} service restart`,
          ],
          { allowFail: true },
        );
      } else if (m.kind === "command" && "run" in m) {
        r = await sh(
          "/bin/sh",
          ["-c", m.run.replaceAll("{version}", version).replaceAll("{releaseBase}", releaseBase)],
          { allowFail: true, cwd: FORK_HOME },
        );
      } else continue;
      results.push({
        name: m.name,
        ok: r.code === 0,
        status: (r.code === 0 ? r.out : r.err || r.out).split("\n").slice(-5).join("\n"),
      });
    }
    return { version, results };
  },

  async status() {
    const cfg = config();
    await fetchAll(cfg);
    const head = await git("rev-parse", `origin/${cfg.branch}`);
    const base = await baseOf(head);
    const releases = await forkReleases();
    const stack = await git("log", "--format=%h %s", `${base.commit}..${head}`);
    return {
      installedDesktop: await installedDesktopVersion(cfg),
      installedDesktopIsFork: (await installedForkCommit(cfg)) !== null,
      latestUpstreamNightly: (await upstreamNightlies())[0] ?? null,
      base: base.tag,
      head: head.slice(0, 10),
      released: releases.find((r) => r.commit === head)?.tag ?? null,
      stack: stack.split("\n").filter(Boolean),
      lastCheckAt: state().lastCheckAt ?? null,
      thisEnvironment: ownEnvironmentId(),
      mergeEnvironmentId: cfg.mergeEnvironmentId,
      devices: (await devices(cfg)).map((d) => `${d.name} (${d.ssh})`),
      config: {
        cadenceHours: cfg.cadenceHours,
        minNightlyAgeHours: cfg.minNightlyAgeHours,
        pinTag: cfg.pinTag,
        autoInstall: cfg.autoInstall,
      },
    };
  },

  async config([key, value]) {
    const current = storedConfig() as Record<string, unknown>;
    if (key && value !== undefined) {
      current[key] = JSON.parse(value);
      writeConfig(current as Partial<Config>);
    }
    return { ...DEFAULTS, ...current };
  },

  /** One-time setup on the machine that runs the T3 workflow. Safe to re-run. */
  async setup() {
    const cfg = config();
    NodeFS.mkdirSync(FORK_HOME, { recursive: true });
    await fetchAll(cfg);
    const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    NodeFS.copyFileSync(NodePath.join(here, "cli.ts"), NodePath.join(FORK_HOME, "cli.ts"));
    NodeFS.mkdirSync(WORKFLOWS, { recursive: true });
    // Keep the settings already saved (or migrate the old config.json) across reinstalls.
    const saved = { ...storedConfig() };
    const source = NodeFS.readFileSync(NodePath.join(here, "t3-workflow.ts"), "utf8").replaceAll(
      "@@FORK_HOME@@",
      FORK_HOME,
    );
    if (!CONFIG_BLOCK.test(source))
      throw new Error("fork/t3-workflow.ts lost its fork-config block.");
    const seeded = process.env.T3_FORK_CONFIG
      ? (JSON.parse(process.env.T3_FORK_CONFIG) as Partial<Config>)
      : {};
    NodeFS.writeFileSync(WORKFLOW_FILE, source);
    // Host-specific keys (node, app) stay this machine's; the rest is shared across machines.
    writeConfig({
      ...DEFAULTS,
      ...seeded,
      ...saved,
      node: process.execPath,
      app: saved.app ?? DEFAULTS.app,
    });
    NodeFS.rmSync(LEGACY_CONFIG_PATH, { force: true });
    // The conflict agents work in the automation clone, which must be a T3 Code project.
    const t3 = t3Command();
    if (t3)
      await sh(t3, ["project", "add", REPO, "--title", "t3code fork (automation)"], {
        allowFail: true,
        cwd: FORK_HOME,
      });
    await lockdownActions(cfg);
    return { forkHome: FORK_HOME, repo: REPO, workflow: WORKFLOW_FILE, project: t3 !== null };
  },

  /** Make another machine able to merge: clone the fork there and run setup with these settings.
   * Pick it afterwards in Settings → Fork → Merges on. */
  async "setup-host"([ssh]) {
    if (!ssh) throw new Error("usage: setup-host <ssh host>");
    const shared = { ...storedConfig() };
    delete shared.node;
    delete shared.app;
    const script = `set -euo pipefail
mkdir -p ~/.t3/fork
[ -d ~/.t3/fork/repo/.git ] || git clone -q --filter=blob:none --branch ${config().branch} git@github.com:${config().repo}.git ~/.t3/fork/repo
cd ~/.t3/fork/repo && git fetch -q origin ${config().branch} && git checkout -q -B ${config().branch} origin/${config().branch}
T3_FORK_CONFIG=${q(JSON.stringify(shared))} node fork/cli.ts setup`;
    const r = await sh("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", ssh, "bash -s"], {
      allowFail: true,
      cwd: FORK_HOME,
      input: script,
    });
    if (r.code !== 0) throw new Error((r.err || r.out).split("\n").slice(-15).join("\n"));
    return { host: ssh, setup: JSON.parse(r.out.slice(r.out.indexOf("{"))) as unknown };
  },
};

async function conflictedFiles() {
  return (await git("diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
}

async function markerFiles(files: string[]) {
  const marked = [];
  for (const file of files) {
    const path = NodePath.join(REPO, file);
    if (NodeFS.existsSync(path) && /^(<{7}|>{7}) /m.test(NodeFS.readFileSync(path, "utf8")))
      marked.push(file);
  }
  return marked;
}

async function conflictInfo() {
  const stopped = await gitTry("rev-parse", "REBASE_HEAD");
  const sha = stopped.code === 0 ? stopped.out : "";
  const message = sha ? await git("log", "-1", "--format=%s%n%n%b", sha) : "";
  const done = readJson<null>(NodePath.join(REPO, ".git", "rebase-merge", "msgnum"), null);
  return {
    repo: REPO,
    files: await conflictedFiles(),
    commit: { sha: sha.slice(0, 10), message: message.trim() },
    progress:
      done === null
        ? null
        : `${done}/${NodeFS.readFileSync(NodePath.join(REPO, ".git", "rebase-merge", "end"), "utf8").trim()}`,
  };
}

/** Continue past every stop that rerere already resolved; report the first one it did not. */
async function settle(): Promise<unknown> {
  for (let i = 0; i < 500 && rebaseInProgress(); i++) {
    const files = await conflictedFiles();
    if (files.length > 0 && (await markerFiles(files)).length > 0)
      return { status: "conflict", ...(await conflictInfo()) };
    if (files.length > 0) await git("add", "--", ...files);
    const r = await gitTry("rebase", "--continue");
    // An empty commit (its change already landed upstream) stops the rebase; drop it.
    if (r.code !== 0 && /nothing to commit|empty/i.test(r.out + r.err))
      await gitTry("rebase", "--skip");
  }
  if (rebaseInProgress()) return { status: "conflict", ...(await conflictInfo()) };
  return { status: "done", changed: true, head: await git("rev-parse", "HEAD") };
}

/** Builds `commit` in ~/.t3/fork/build on this machine (bootstrapping Vite+ and the clone the first
 * time). On Linux it also patches the installed server of `version` in place and restarts it. */
function buildScript(
  cfg: Config,
  commit: string,
  version: string,
  target: "mac" | "linux",
  restart: string,
) {
  const build =
    target === "mac"
      ? `rm -rf ${BUNDLE_DIRS.join(" ")} && run vp run build:desktop:bundle`
      : `rm -rf apps/server/dist apps/server/dist-exe && run vp run --filter t3 build && run vp run --filter t3 build:exe`;
  const patch =
    target === "mac"
      ? ""
      : `R="$HOME/.t3/runtime/versions/${version}"
if [ ! -d "$R" ]; then echo "no ${version} install here; it installs the GitHub build on its next update"; exit 0; fi
cp apps/server/dist-exe/t3 "$R/t3.new" && mv -f "$R/t3.new" "$R/t3"
rm -rf "$R/client.new" "$R/client.old" && cp -R apps/server/dist/client "$R/client.new"
find "$R/client.new" -name '*.map' -delete
mv "$R/client" "$R/client.old" && mv "$R/client.new" "$R/client" && rm -rf "$R/client.old"
${restart}
echo "patched $R"`;
  return `set -euo pipefail
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
LOG="$HOME/.t3/fork/build.log"; mkdir -p "$HOME/.t3/fork"
{
command -v vp >/dev/null || curl -fsSL https://vite.plus | bash
B="${target === "mac" ? BUILD : "$HOME/.t3/fork/build"}"
[ -e "$B/.git" ] || git clone -q --filter=blob:none https://github.com/${cfg.repo}.git "$B"
cd "$B"
git fetch -q origin ${cfg.branch} && git checkout -q -f --detach ${commit}
N=$(grep -o '"node": *"[0-9.]*"' package.json | head -1 | grep -o '[0-9][0-9.]*')
PM=$(grep -o '"packageManager": *"[^"]*"' package.json | grep -o 'pnpm@[0-9.]*')
# Pin both: a system pnpm or Node on PATH would otherwise ignore the lockfile.
run() { vp env exec --node "$N" --package-manager "$PM" "$@"; }
run vp i
run node scripts/update-release-package-versions.ts ${version}
for k in CLERK_PUBLISHABLE_KEY CLERK_JWT_TEMPLATE CLERK_CLI_OAUTH_CLIENT_ID RELAY_URL; do
  export "T3CODE_$k=$(sed -n "s|^T3CODE_$k=||p" .env.example)"
done
export T3CODE_TELEMETRY_CHANNEL=dev
${build}
} >"$LOG" 2>&1 || { tail -25 "$LOG"; exit 1; }
${patch}
`;
}

/** Swaps the freshly built bundle into a copy of the installed app's app.asar, keeping the same
 * files unpacked beside it. */
async function repackAsar(build: string, resources: string, workDir: string) {
  const pnpm = NodePath.join(build, "node_modules", ".pnpm");
  const pkg = NodeFS.readdirSync(pnpm).find((dir) => dir.startsWith("@electron+asar@"));
  if (!pkg) throw new Error("@electron/asar is not installed in the build checkout.");
  const asar = await import(
    NodeURL.pathToFileURL(NodePath.join(pnpm, pkg, "node_modules/@electron/asar/lib/asar.js")).href
  );
  const archive = NodePath.join(resources, "app.asar");
  const unpackedDir = `${archive}.unpacked`;
  const unpacked = NodeFS.existsSync(unpackedDir)
    ? (NodeFS.readdirSync(unpackedDir, { recursive: true }) as string[]).filter((f) =>
        NodeFS.statSync(NodePath.join(unpackedDir, f)).isFile(),
      )
    : [];
  NodeFS.rmSync(workDir, { recursive: true, force: true });
  asar.extractAll(archive, workDir);
  for (const dir of BUNDLE_DIRS) {
    const from = NodePath.join(build, dir);
    const to = NodePath.join(workDir, dir);
    NodeFS.rmSync(to, { recursive: true, force: true });
    // electron-builder leaves out source maps and dot-folders such as client/.vite.
    NodeFS.cpSync(from, to, {
      recursive: true,
      filter: (src) =>
        !src.endsWith(".map") &&
        !NodePath.relative(from, src)
          .split(NodePath.sep)
          .some((part) => part.startsWith(".")),
    });
  }
  NodeFS.rmSync(archive, { force: true });
  NodeFS.rmSync(unpackedDir, { recursive: true, force: true });
  await asar.createPackageWithOptions(workDir, archive, {
    unpack: `{${unpacked.map((f) => NodePath.join(workDir, f)).join(",")}}`,
  });
  const after = NodeFS.existsSync(unpackedDir)
    ? (NodeFS.readdirSync(unpackedDir, { recursive: true }) as string[]).filter((f) =>
        NodeFS.statSync(NodePath.join(unpackedDir, f)).isFile(),
      ).length
    : 0;
  if (after !== unpacked.length)
    throw new Error(`Repacked app.asar unpacked ${after} files, expected ${unpacked.length}.`);
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}

function installedMarker(cfg: Config) {
  const text = readText(NodePath.join(cfg.app, "Contents", "Resources", "fork-build.json"));
  return text ? (JSON.parse(text) as { version: string; commit: string; local?: boolean }) : null;
}

async function installedForkCommit(cfg: Config) {
  return installedMarker(cfg)?.commit ?? null;
}

const nightlyRun = (tag: string) => Number(NIGHTLY.exec(tag)?.[2] ?? 0);

type Device = {
  environmentId: string | null;
  name: string;
  ssh: string;
  kind: Machine["kind"];
  t3?: string;
};

/** Every SSH device T3 Code knows (its own connection catalog, unlocked with the app's Keychain
 * key), plus the hand-written `fleet` entries for machines T3 Code does not connect to. */
async function devices(cfg: Config): Promise<Device[]> {
  const found: Device[] = [];
  const catalogText = readText(NodePath.join(T3_HOME, "userdata", "connection-catalog.json"));
  if (catalogText) {
    const key = await sh("security", ["find-generic-password", "-s", "t3code Safe Storage", "-w"], {
      allowFail: true,
      cwd: FORK_HOME,
    });
    const raw = Buffer.from(
      (JSON.parse(catalogText) as { encryptedCatalog: string }).encryptedCatalog,
      "base64",
    );
    if (key.code === 0 && raw.subarray(0, 3).toString() === "v10") {
      // Chromium's safeStorage format, which Electron uses on macOS.
      const decipher = NodeCrypto.createDecipheriv(
        "aes-128-cbc",
        NodeCrypto.pbkdf2Sync(key.out, "saltysalt", 1003, 16, "sha1"),
        Buffer.alloc(16, " "),
      );
      const catalog = JSON.parse(
        Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]).toString("utf8"),
      ) as {
        profiles?: Array<{
          _tag: string;
          environmentId: string;
          label: string;
          target: { alias?: string; hostname: string; username?: string; port?: number };
        }>;
        disabledEnvironmentIds?: string[];
      };
      for (const profile of catalog.profiles ?? []) {
        if (profile._tag !== "SshConnectionProfile") continue;
        if (catalog.disabledEnvironmentIds?.includes(profile.environmentId)) continue;
        const { alias, hostname, username, port } = profile.target;
        const authority = username ? `${username}@${hostname}` : hostname;
        found.push({
          environmentId: profile.environmentId,
          name: profile.label,
          // The alias keeps the user's SSH config (proxies, keys) in play.
          ssh: alias || (port && port !== 22 ? `ssh://${authority}:${port}` : authority),
          kind: "ssh-launched",
        });
      }
    }
  }
  for (const m of cfg.fleet) {
    if (
      !("ssh" in m) ||
      found.some((d) => d.ssh === m.ssh || (m.environmentId && d.environmentId === m.environmentId))
    )
      continue;
    found.push({
      environmentId: m.environmentId ?? null,
      name: m.name,
      ssh: m.ssh,
      kind: m.kind,
      ...(m.kind === "ssh-service" && m.t3 ? { t3: m.t3 } : {}),
    });
  }
  return found;
}

async function installedDesktopVersion(cfg: Config) {
  const r = await sh(
    "/usr/bin/defaults",
    ["read", NodePath.join(cfg.app, "Contents", "Info.plist"), "CFBundleShortVersionString"],
    { allowFail: true, cwd: FORK_HOME },
  );
  return r.code === 0 ? r.out : null;
}

type ReleaseRun = {
  id: number;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
};

async function findReleaseRun(
  cfg: Config,
  tag: string,
  commit: string | null,
): Promise<ReleaseRun | undefined> {
  const page = await github<{ workflow_runs: ReleaseRun[] }>(
    `repos/${cfg.repo}/actions/workflows/fork-release.yml/runs?per_page=30`,
  );
  return (page?.workflow_runs ?? [])
    .filter(
      (x) =>
        (commit ? x.head_sha === commit : true) &&
        (x.head_branch === tag || x.event === "workflow_dispatch"),
    )
    .sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
}

async function ensureReleaseRun(cfg: Config, tag: string, commit: string) {
  // Give GitHub's tag-push trigger a moment; forks can silently drop push-tag events, so fall back
  // to workflow_dispatch when no active or completed run appeared for this commit.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const existing = await findReleaseRun(cfg, tag, commit);
  if (existing && existing.conclusion !== "cancelled") return;
  if (!(await hasGh())) return;
  await sh(
    "gh",
    ["workflow", "run", "fork-release.yml", "-R", cfg.repo, "--ref", cfg.branch, "-f", `tag=${tag}`],
    { allowFail: true, cwd: FORK_HOME },
  );
}

async function lockdownActions(cfg: Config) {
  if (!(await hasGh())) return;
  // Upstream's own workflows must not run here; only the fork release does.
  await sh(
    "gh",
    [
      "api",
      "-X",
      "PUT",
      `repos/${cfg.repo}/actions/permissions`,
      "-F",
      "enabled=true",
      "-f",
      "allowed_actions=all",
    ],
    { allowFail: true },
  );
  const r = await sh(
    "gh",
    ["workflow", "list", "-R", cfg.repo, "--all", "--json", "id,path,state"],
    { allowFail: true },
  );
  if (r.code !== 0) return;
  for (const wf of JSON.parse(r.out) as Array<{ id: number; path: string; state: string }>) {
    const wanted = wf.path.endsWith("/fork-release.yml");
    if (wanted && wf.state !== "active")
      await sh("gh", ["workflow", "enable", String(wf.id), "-R", cfg.repo], { allowFail: true });
    if (!wanted && wf.state === "active")
      await sh("gh", ["workflow", "disable", String(wf.id), "-R", cfg.repo], { allowFail: true });
  }
}

/** A certificate identity keeps the app's code requirement the same from build to build, so
 * Keychain "Always Allow" answers survive updates; an ad-hoc signature changes with every build. */
async function signingIdentity(cfg: Config): Promise<string> {
  if (cfg.signingIdentity) return cfg.signingIdentity;
  const r = await sh("security", ["find-identity", "-v", "-p", "codesigning"], {
    allowFail: true,
    cwd: FORK_HOME,
  });
  const identities = [...r.out.matchAll(/\b([0-9A-F]{40}) "([^"]+)"/g)];
  const pick = (prefix: string) => identities.find((m) => m[2]!.startsWith(prefix))?.[1];
  return pick("Developer ID Application") ?? pick("Apple Development") ?? "-";
}

/** The t3 CLI of this machine: the desktop's launcher, or the newest installed server. */
function t3Command(): string | null {
  const launcher = NodePath.join(T3_HOME, "bin", "t3");
  if (NodeFS.existsSync(launcher)) return launcher;
  const versions = NodePath.join(T3_HOME, "runtime", "versions");
  const newest = NodeFS.existsSync(versions)
    ? NodeFS.readdirSync(versions)
        .filter((v) => NodeFS.existsSync(NodePath.join(versions, v, "t3")))
        .sort((a, b) => nightlyRun(`v${a}`) - nightlyRun(`v${b}`))
        .pop()
    : undefined;
  return newest ? NodePath.join(versions, newest, "t3") : null;
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function swapScript(app: string, staged: string, previousDir: string, graceSeconds: number) {
  const exe = `${app}/Contents/MacOS/`;
  return `#!/bin/sh
exec >>${q(NodePath.join(FORK_HOME, "swap.log"))} 2>&1
echo "$(date) swapping ${app}"
sleep ${graceSeconds}
osascript -e ${q(
    `quit app "${app
      .split("/")
      .pop()!
      .replace(/\.app$/, "")}"`,
  )} || true
for _ in $(seq 1 60); do pgrep -f ${q(exe)} >/dev/null || break; sleep 1; done
pkill -f ${q(exe)} || true
sleep 2
mkdir -p ${q(previousDir)}
rm -rf ${q(`${previousDir}/app.app`)}
[ -d ${q(app)} ] && mv ${q(app)} ${q(`${previousDir}/app.app`)}
mv ${q(staged)} ${q(app)}
open ${q(app)}
echo "$(date) done"
`;
}

const [name, ...rest] = process.argv.slice(2);
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`usage: cli.ts <${Object.keys(commands).join("|")}> [args]`);
  process.exit(2);
}
command(rest).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error: Error) => {
    console.log(JSON.stringify({ status: "error", error: error.message }));
    process.exit(1);
  },
);
