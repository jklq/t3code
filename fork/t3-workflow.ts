// Installed as ~/.t3/workflows/fork-sync.ts by `node fork/cli.ts setup`; bump `version` before
// changing a definition with unfinished runs. Agents run only on a failed step. See FORK.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const { workflow, step, agent, ask, stop, skip, title, sleep, every, Tick } = T3;

const FORK_HOME = "@@FORK_HOME@@";
const REPO = `${FORK_HOME}/repo`;

const cli = (...args) =>
  Effect.tryPromise({
    try: () =>
      new Promise((resolve, reject) => {
        const node =
          JSON.parse(NodeFS.readFileSync(`${FORK_HOME}/config.json`, "utf8")).node || "node";
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
Failed jobs: ${ci.failedJobs.join(", ") || "unknown"}. End of the failing log:
\`\`\`
${ci.logTail}
\`\`\`
Fix the cause with the smallest change. Read FORK.md first. The fork's own commits are \`git log ${base}..HEAD\`; anything else is upstream code, which already passed upstream CI, so the cause is almost always a fork commit meeting new upstream code.
- Check only what failed (for example \`vp run --filter <package> typecheck\` after \`vp install\`), not the whole suite.
- Commit with \`git commit --fixup=<the fork commit the fix belongs to>\`, then \`git -c sequence.editor=: rebase -i --autosquash ${base}\`. Do not push; the workflow publishes.
- If the failure is a runner or network problem rather than code, change nothing.
Submit {"fixed": true, "notes": "<one line>"} or {"fixed": false, "notes": "<why>"}.`;

workflow(
  "fork-update",
  { version: 1, payload: Tick, triggers: [every("1 hour")] },
  Effect.fn(function* (tick) {
    if (tick.scheduledAt !== "manual") {
      const due = yield* step("due", Json, cli("due"));
      if (!due.due) return yield* skip("not due");
    }
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

    let pub = yield* step(
      "publish",
      Json,
      plan.replace ? cli("publish", "--replace") : cli("publish"),
    );
    for (let i = 0; ; i++) {
      const ci = yield* step(`ci-${i}`, Json, cli("await-ci", pub.tag));
      if (ci.status === "success") break;
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
        yield* step(`rerun-${i}`, Json, cli("rerun-ci", ci.runId));
        continue;
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

    if (!cfg.autoInstall) {
      const answer = yield* ask("install", {
        title: `Install T3 Code fork ${pub.version}? T3 Code restarts.`,
        choices: ["install", "skip"],
        data: pub,
        timeout: "7 days",
      });
      if (Option.isNone(answer) || answer.value.choice === "skip")
        return yield* stop(`${pub.version} published, not installed`);
    }
    yield* step("install", Json, cli("install-desktop", pub.version));
    yield* sleep("restart", "3 minutes");
    return yield* step("rollout", Json, cli("rollout", pub.version));
  }),
);
