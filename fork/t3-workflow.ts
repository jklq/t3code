// Installed as ~/.t3/workflows/fork-sync.ts by `node fork/cli.ts setup` on every machine; the same
// file works on each. Bump `version` before changing a definition with unfinished runs. See FORK.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const { workflow, step, agent, ask, stop, skip, title, sleep, every, Tick } = T3;

const FORK_HOME = process.env.T3_FORK_HOME ?? NodePath.join(NodeOS.homedir(), ".t3", "fork");
const REPO = NodePath.join(FORK_HOME, "repo");

// fork-config:begin Settings → Fork and `cli.ts config` edit this; keep it JSON.
const FORK_CONFIG = {};
// fork-config:end

const cli = (...args) =>
  Effect.tryPromise({
    try: () =>
      new Promise((resolve, reject) => {
        // The server itself may be Electron or a single executable, so run a real Node.
        const node =
          FORK_CONFIG.node && NodeFS.existsSync(FORK_CONFIG.node) ? FORK_CONFIG.node : "node";
        NodeChildProcess.execFile(
          node,
          [`${FORK_HOME}/cli.ts`, ...args],
          { maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => {
            let result;
            try {
              result = JSON.parse(stdout);
            } catch {
              return reject(
                new Error(`cli ${args[0]}: ${stderr || stdout || error}`.slice(0, 2000)),
              );
            }
            if (error || result.status === "error")
              reject(new Error(`cli ${args[0]}: ${result.error ?? error}`));
            else resolve(result);
          },
        );
      }),
    catch: (error) => error,
  });

const Json = { returns: Schema.Unknown };
const Resolution = Schema.Struct({ resolved: Schema.Boolean, notes: Schema.String });
const Fix = Schema.Struct({ fixed: Schema.Boolean, notes: Schema.String });
const Review = Schema.Struct({
  verdict: Schema.Literals(["clean", "fixed", "needs-you"]),
  notes: Schema.String,
});

const reviewBrief = (
  r,
) => `Review a rebase of the T3 Code fork at ${r.repo} that git finished without conflicts. Git only catches overlapping lines; look for what it misses: a fork commit that applied cleanly but no longer does what its Intent says on the new upstream code.

The fork stack was ${r.oldBase}..${r.previous} and is now ${r.newBase}..HEAD (${r.upstreamCommits} upstream commits in between). Its commits and their Intent/Keep lines: \`git log --format='%h %s%n%b' ${r.newBase}..HEAD\`. Compare the stacks with \`git range-diff ${r.oldBase}..${r.previous} ${r.newBase}..HEAD\`.
Files both the fork and upstream changed: ${r.bothChanged.join(", ") || "none"}. All files the fork changes: ${r.forkFiles.join(", ")}.

Check, reading only what you need:
- what upstream changed (\`git diff ${r.oldBase} ${r.newBase} -- <file>\`) in code the fork edits, calls, imports or renders into: renamed or removed functions, props, routes or settings, changed behavior or order, moved code;
- that each fork hook still runs where its Keep line says, and the fork still keeps FORK.md's compatibility contract.
Do not run builds or test suites; CI typechecks and tests next.

If you find a real problem you can fix, fix it with the smallest change as \`git commit --fixup=<that fork commit>\` and \`git -c sequence.editor=: rebase -i --autosquash ${r.newBase}\`, and do not push. Submit {"verdict": "clean" | "fixed" | "needs-you", "notes": "<one line per finding>"}; use needs-you when a fix needs a decision.`;

const conflictBrief = (
  c,
) => `Resolve one git rebase conflict in the T3 Code fork at ${c.repo}. Stay small: read only what you need.

The fork commit being replayed onto a newer upstream T3 Code nightly (${c.progress ?? "?"}):
---
${c.commit.message}
---
Conflicted files: ${c.files.join(", ")}

1. In each conflicted file, keep upstream's new code and re-apply the fork commit's intent (its Intent/Keep lines) on top of it, as small as it was. Use \`git diff\` and \`git log -1 -p REBASE_HEAD -- <file>\` to see both sides.
2. Leave no conflict markers; \`git diff --check\` must be clean.
3. Do not run \`git rebase --continue\`, \`git commit\`, installs, builds or test suites, and do not edit other files. The workflow continues the rebase and CI checks it.

Submit {"resolved": true, "notes": "<one line>"}, or {"resolved": false, "notes": "<why>"} if the intent no longer fits upstream.`;

const ciBrief = (
  ci,
  base,
) => `The fork release build of the T3 Code fork at ${REPO} (branch \`fork\`) failed: ${ci.url}
Failed jobs: ${ci.failedJobs.join(", ") || "unknown"}.${
  ci.logTail
    ? ` End of the failing log:\n\`\`\`\n${ci.logTail}\n\`\`\``
    : " Its log is not available here; reproduce the failing job's check locally."
}
Fix the cause with the smallest change. Read FORK.md first. The fork's own commits are \`git log ${base}..HEAD\`; anything else is upstream code, which already passed upstream CI, so the cause is almost always a fork commit meeting new upstream code.
- Check only what failed (for example \`vp run --filter <package> typecheck\` after \`vp install\`), not the whole suite.
- Commit with \`git commit --fixup=<the fork commit the fix belongs to>\`, then \`git -c sequence.editor=: rebase -i --autosquash ${base}\`. Do not push; the workflow publishes.
- If the failure is a runner or network problem rather than code, change nothing.
Submit {"fixed": true, "notes": "<one line>"} or {"fixed": false, "notes": "<why>"}.`;

workflow(
  "fork-update",
  {
    version: 3,
    payload: Tick,
    // Frequent and cheap: `due` acts only on the merging machine, on cadenceHours or "Check now".
    triggers: [every("5 minutes")],
    onEnd: (_tick, end) => cli("unlock", end.id),
  },
  Effect.fn(function* (tick, run) {
    if (tick.scheduledAt !== "manual") {
      const due = yield* step("due", Json, cli("due"));
      if (!due.due) return yield* skip("not due");
    }
    const lock = yield* step("lock", Json, cli("lock", run.id));
    if (!lock.acquired) return yield* skip("another fork update is running");
    const cfg = yield* step("config", Json, cli("config"));
    const plan = yield* step("plan", Json, cli("plan"));
    if (plan.action === "none") return yield* skip(plan.reason);
    yield* title(`Fork: ${plan.reason}`);

    const agentOptions = (model) => ({
      project: REPO,
      model,
      runtimeMode: "full-access",
      timeout: "45 minutes",
    });

    let rebase = yield* step("rebase", Json, cli("rebase", plan.target));
    for (let i = 0; rebase.status === "conflict"; i++) {
      if (i >= 25)
        return yield* stop("too many conflict rounds; finish by hand in ~/.t3/fork/repo");
      yield* agent.try(`resolve-${i}`, {
        ...agentOptions(cfg.models.resolve),
        brief: conflictBrief(rebase),
        returns: Resolution,
      });
      let next = yield* step(`continue-${i}`, Json, cli("continue"));
      const stuck = (r) => r.status === "conflict" && r.commit.sha === rebase.commit.sha;
      if (stuck(next)) {
        yield* agent.try(`resolve-${i}-escalate`, {
          ...agentOptions(cfg.models.escalate),
          brief: conflictBrief(next),
          returns: Resolution,
        });
        next = yield* step(`continue-${i}-escalate`, Json, cli("continue"));
      }
      if (stuck(next)) {
        const answer = yield* ask(`resolve-${i}-human`, {
          title: `Fork rebase is stuck on "${next.commit.message.split("\n")[0]}". Resolve it in ${REPO}, then continue.`,
          choices: ["continue", "abort"],
          data: next,
          timeout: "7 days",
        });
        if (Option.isNone(answer) || answer.value.choice === "abort") {
          yield* step(`abort-${i}`, Json, cli("abort"));
          return yield* stop("rebase aborted");
        }
        next = yield* step(`continue-${i}-human`, Json, cli("continue"));
      }
      rebase = next;
    }

    if (cfg.reviewMerges && rebase.changed !== false) {
      const scope = yield* step("review-scope", Json, cli("review-scope"));
      const review = yield* agent.try("review", {
        ...agentOptions(cfg.models.review ?? cfg.models.resolve),
        brief: reviewBrief(scope),
        returns: Review,
      });
      const needsYou = review.outcome === "failed" || review.value.verdict === "needs-you";
      if (needsYou) {
        const answer = yield* ask("review-human", {
          title: `The merge review of ${plan.target} needs you: ${review.outcome === "failed" ? review.reason : review.value.notes}`,
          choices: ["publish", "abort"],
          data: scope,
          timeout: "7 days",
        });
        if (Option.isNone(answer) || answer.value.choice === "abort") {
          return yield* stop("merge review stopped the update");
        }
      }
    }

    let pub = yield* step("publish", Json, cli("publish"));
    for (let i = 0; ; i++) {
      const ci = yield* step(`ci-${i}`, Json, cli("await-ci", pub.tag));
      if (ci.status === "success") {
        yield* step("unlock", Json, cli("unlock", run.id));
        break;
      }
      if (ci.status === "timeout" || i >= 3)
        return yield* stop(`fork release build did not pass: ${ci.url}`);
      if (ci.failedJobs.some((job) => /compatib/i.test(job))) {
        return yield* stop(
          `a fork commit breaks compatibility with official clients (see FORK.md): ${ci.url}`,
        );
      }
      const codeFailure =
        ci.failedJobs.some((job) => /typecheck|test/i.test(job)) ||
        /error TS\d+|FAIL /.test(ci.logTail);
      if (!codeFailure && i === 0) {
        const rerun = yield* step(`rerun-${i}`, Json, cli("rerun-ci", ci.runId));
        if (rerun.status === "rerun") continue;
      }
      const fix = yield* agent.try(`fix-ci-${i}`, {
        ...agentOptions(i === 0 ? cfg.models.resolve : cfg.models.escalate),
        brief: ciBrief(ci, pub.base),
        returns: Fix,
        timeout: "90 minutes",
      });
      if (fix.outcome === "failed" || !fix.value.fixed)
        return yield* stop(`fork release build failed: ${ci.url}`);
      pub = yield* step(`publish-${i + 1}`, Json, cli("publish", "--replace"));
    }

    // Each machine with the desktop app installs it through fork-install.
    return pub;
  }),
);

// On machines with the desktop app: offer each new fork release, wherever it was merged.
workflow(
  "fork-install",
  {
    version: 1,
    payload: Tick,
    triggers: [every("5 minutes")],
    onEnd: (_tick, end) => cli("unlock", end.id, "install"),
  },
  Effect.fn(function* (_tick, run) {
    const check = yield* step("check", Json, cli("install-check"));
    if (check.action !== "install") return yield* skip(check.reason);
    const lock = yield* step("lock", Json, cli("lock", run.id, "install"));
    if (!lock.acquired) return yield* skip("already offered");
    yield* title(`Fork: install ${check.version}`);
    const cfg = yield* step("config", Json, cli("config"));
    if (!cfg.autoInstall) {
      const answer = yield* ask("install", {
        title: `Install T3 Code fork ${check.version}? T3 Code restarts.`,
        choices: ["install", "skip"],
        data: { version: check.version },
        timeout: "7 days",
      });
      if (Option.isNone(answer)) return yield* stop(`${check.version} not installed`);
      if (answer.value.choice === "skip") {
        yield* step("decline", Json, cli("decline", check.key));
        return yield* stop(`${check.version} skipped`);
      }
    }
    yield* step("install", Json, cli("install-desktop", check.version));
    yield* sleep("restart", "3 minutes");
    return yield* step("rollout", Json, cli("rollout", check.version));
  }),
);
