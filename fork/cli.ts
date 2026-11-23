#!/usr/bin/env node
// Fork maintenance engine. Deterministic: git, gh and ssh only. Agents are never called from
// here; the T3 workflow (fork/t3-workflow.ts) calls an agent only when a command below reports a
// conflict or a failed build. Every command prints one JSON object on stdout. See FORK.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

type Model = { instanceId: string; model: string };
type Machine =
  | { name: string; kind: "ssh-launched"; ssh: string }
  | { name: string; kind: "ssh-service"; ssh: string; t3?: string }
  | { name: string; kind: "command"; run: string };
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
  models: { resolve: Model; escalate: Model };
  fleet: Machine[];
};

const FORK_HOME = process.env.T3_FORK_HOME ?? NodePath.join(NodeOS.homedir(), ".t3", "fork");
const REPO = NodePath.join(FORK_HOME, "repo");
const CONFIG_PATH = NodePath.join(FORK_HOME, "config.json");
const STATE_PATH = NodePath.join(FORK_HOME, "state.json");
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
};

const readJson = <T>(path: string, fallback: T): T =>
  NodeFS.existsSync(path) ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as T) : fallback;
const config = (): Config => ({ ...DEFAULTS, ...readJson<Partial<Config>>(CONFIG_PATH, {}) });
const state = () => readJson<{ lastCheckAt?: string }>(STATE_PATH, {});
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
  opts: { cwd?: string; allowFail?: boolean; env?: object } = {},
) {
  return new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    NodeChildProcess.execFile(
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
    await git("remote", "add", "upstream", `https://github.com/${cfg.upstream}.git`);
    await git("config", "remote.upstream.tagOpt", "--no-tags");
    await git("config", "remote.upstream.fetch", "+refs/heads/main:refs/remotes/upstream/main");
    await git("config", "--add", "remote.upstream.fetch", "+refs/tags/v*:refs/upstream-tags/v*");
    await git("config", "rerere.enabled", "true");
    await git("config", "rerere.autoupdate", "true");
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

async function nightlyPublishedAt(cfg: Config, tag: string): Promise<number | null> {
  const r = await sh(
    "gh",
    ["release", "view", tag, "-R", cfg.upstream, "--json", "publishedAt,isDraft"],
    { allowFail: true },
  );
  if (r.code !== 0) return null;
  const release = JSON.parse(r.out) as { publishedAt: string; isDraft: boolean };
  return release.isDraft ? null : Date.parse(release.publishedAt);
}

const commands: Record<string, (args: string[]) => Promise<unknown>> = {
  /** Whether the timer should start an update now: cadenceHours since the last check, or pushed
   * fork commits that are not released yet (those ship right away). */
  async due() {
    const cfg = config();
    await ensureRepo(cfg);
    const last = state().lastCheckAt;
    const cadence =
      !last || Date.now() - Date.parse(last) >= cfg.cadenceHours * 3600_000 - 5 * 60_000;
    const head = (await git("ls-remote", "origin", `refs/heads/${cfg.branch}`)).split("\t")[0];
    const unreleased = !(await forkReleases()).some((r) => r.commit === head);
    if (cadence) saveState({ lastCheckAt: new Date().toISOString() });
    return {
      due: cadence || unreleased,
      unreleased,
      lastCheckAt: last ?? null,
      cadenceHours: cfg.cadenceHours,
    };
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
    // New fork commits ship now. A fork build carries its upstream nightly's exact version, so they
    // move to a nightly the fork has not released when one exists (regardless of age), or else
    // replace the current base's release. SSH hosts that already installed that version keep their
    // build until the next version; the desktop reinstalls because its marker names the commit.
    const unreleasedTag = (tag: string | null) =>
      tag !== null && !releases.some((r) => r.tag === tag);
    if (unreleasedTag(base.tag)) {
      return {
        action: "update",
        target: base.tag,
        from: base.tag,
        replace: false,
        reason: `first fork build of ${base.tag}`,
      };
    }
    const newest = cfg.pinTag
      ? null
      : (await upstreamNightlies()).find((tag) => !cfg.skipTags.includes(tag));
    if (newest && newest !== base.tag) {
      return {
        action: "update",
        target: newest,
        from: base.tag,
        replace: false,
        reason: `new fork commits → ${newest}`,
      };
    }
    return {
      action: "update",
      target: base.tag,
      from: base.tag,
      replace: true,
      reason: `new fork commits, rebuilding ${base.tag}`,
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
    await sh("git", [
      "push",
      "--quiet",
      `--force-with-lease=${cfg.branch}`,
      "origin",
      `${commit}:refs/heads/${cfg.branch}`,
    ]);
    if (existing?.commit !== commit) {
      await git("tag", "--force", tag, commit);
      await git("push", "--quiet", "--force", "origin", `refs/tags/${tag}`);
    }
    await lockdownActions(cfg);
    // The workflow runs the engine from this copy, which stays usable while the repo is mid-rebase.
    NodeFS.copyFileSync(NodePath.join(REPO, "fork", "cli.ts"), NodePath.join(FORK_HOME, "cli.ts"));
    return { tag, version: tag.slice(1), commit, base: base.tag };
  },

  /** Wait for fork-release.yml on a tag. Reports the failing log tail on failure. */
  async "await-ci"([tag, timeoutMinutes = "180"]) {
    const cfg = config();
    const deadline = Date.now() + Number(timeoutMinutes) * 60_000;
    for (;;) {
      const r = await sh(
        "gh",
        [
          "run",
          "list",
          "-R",
          cfg.repo,
          "--workflow",
          "fork-release.yml",
          "--limit",
          "30",
          "--json",
          "databaseId,headBranch,status,conclusion,url,createdAt",
        ],
        { allowFail: true },
      );
      const runs = r.code === 0 ? (JSON.parse(r.out) as Array<Record<string, string>>) : [];
      const run = runs
        .filter((x) => x.headBranch === tag)
        .sort((a, b) => b.createdAt!.localeCompare(a.createdAt!))[0];
      if (run?.status === "completed") {
        if (run.conclusion === "success") return { status: "success", url: run.url };
        const jobs = await sh(
          "gh",
          ["run", "view", String(run.databaseId), "-R", cfg.repo, "--json", "jobs"],
          { allowFail: true },
        );
        const failedJobs =
          jobs.code === 0
            ? (JSON.parse(jobs.out).jobs as Array<{ name: string; conclusion: string }>)
                .filter((j) => j.conclusion === "failure")
                .map((j) => j.name)
            : [];
        const log = await sh(
          "gh",
          ["run", "view", String(run.databaseId), "-R", cfg.repo, "--log-failed"],
          { allowFail: true },
        );
        const logTail = log.out
          .split("\n")
          .slice(-120)
          .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+ /, ""))
          .join("\n");
        return {
          status: "failure",
          url: run.url,
          runId: String(run.databaseId),
          failedJobs,
          logTail,
        };
      }
      if (Date.now() > deadline) return { status: "timeout", url: run?.url ?? null };
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  },

  /** Re-run only the failed jobs of a fork release run (for runner flakes). */
  async "rerun-ci"([runId]) {
    await sh("gh", ["run", "rerun", runId!, "--failed", "-R", config().repo]);
    return { status: "rerun", runId };
  },

  /** Download the release's macOS app and swap it in. `--now` skips the grace period. */
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
    await sh("codesign", ["--force", "--deep", "--sign", "-", staged]);
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
    for (const m of cfg.fleet) {
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
      if (m.kind === "ssh-service") {
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
      } else {
        r = await sh(
          "/bin/sh",
          ["-c", m.run.replaceAll("{version}", version).replaceAll("{releaseBase}", releaseBase)],
          { allowFail: true, cwd: FORK_HOME },
        );
      }
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
      config: {
        cadenceHours: cfg.cadenceHours,
        minNightlyAgeHours: cfg.minNightlyAgeHours,
        pinTag: cfg.pinTag,
        autoInstall: cfg.autoInstall,
        fleet: cfg.fleet.map((m) => `${m.name} (${m.kind})`),
      },
    };
  },

  async config([key, value]) {
    const current = readJson<Record<string, unknown>>(CONFIG_PATH, {});
    if (key && value !== undefined) {
      current[key] = JSON.parse(value);
      NodeFS.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + "\n");
    }
    return { ...DEFAULTS, ...current };
  },

  /** One-time setup on the machine that runs the T3 workflow. Safe to re-run. */
  async setup() {
    const cfg = config();
    NodeFS.mkdirSync(FORK_HOME, { recursive: true });
    if (!NodeFS.existsSync(CONFIG_PATH))
      NodeFS.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ ...DEFAULTS, node: process.execPath }, null, 2) + "\n",
      );
    await fetchAll(cfg);
    const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    NodeFS.copyFileSync(NodePath.join(here, "cli.ts"), NodePath.join(FORK_HOME, "cli.ts"));
    const workflows =
      process.env.T3CODE_WORKFLOWS ?? NodePath.join(NodeOS.homedir(), ".t3", "workflows");
    NodeFS.mkdirSync(workflows, { recursive: true });
    const source = NodeFS.readFileSync(NodePath.join(here, "t3-workflow.ts"), "utf8").replaceAll(
      "@@FORK_HOME@@",
      FORK_HOME,
    );
    NodeFS.writeFileSync(NodePath.join(workflows, "fork-sync.ts"), source);
    await lockdownActions(cfg);
    return { forkHome: FORK_HOME, repo: REPO, workflow: NodePath.join(workflows, "fork-sync.ts") };
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

async function installedForkCommit(cfg: Config) {
  const marker = NodePath.join(cfg.app, "Contents", "Resources", "fork-build.json");
  return NodeFS.existsSync(marker)
    ? (JSON.parse(NodeFS.readFileSync(marker, "utf8")) as { commit: string }).commit
    : null;
}

async function installedDesktopVersion(cfg: Config) {
  const r = await sh(
    "/usr/bin/defaults",
    ["read", NodePath.join(cfg.app, "Contents", "Info.plist"), "CFBundleShortVersionString"],
    { allowFail: true, cwd: FORK_HOME },
  );
  return r.code === 0 ? r.out : null;
}

async function lockdownActions(cfg: Config) {
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
