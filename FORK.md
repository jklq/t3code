# This fork

`jklq/t3code` is upstream T3 Code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) nightly
plus a short stack of fork commits on the **`fork`** branch (the default branch). `main` is an untouched
mirror of upstream and is not used.

```
upstream nightly tag ── fork commit 1 ── fork commit 2 ── … = fork branch = what ships
```

## How it stays current

Two paths:

- **Fast path, for fork features (about a minute):** `node ~/.t3/fork/cli.ts ship` builds the pushed
  `fork` commit on the Mac and, natively and at the same time, on every SSH device T3 Code connects
  to. It patches each install in place, restarts their servers, then restarts T3 Code on the Mac. It
  needs the commit to be on the installed upstream nightly and to change no dependencies or native
  code; otherwise it says so and the change ships with the next nightly.
- **Nightly path, in the background:** two T3 Code workflows in `fork/t3-workflow.ts` (installed as
  `~/.t3/workflows/fork-sync.ts` on every machine that has the fork set up).

`fork-update` runs only on the machine chosen under Settings → Fork → **Merges on** (by default the
one with the desktop app; pick one that is always on). Once `cadenceHours` has passed, or on **Check
now**, it:

1. picks the newest upstream nightly at least `minNightlyAgeHours` old (or `pinTag`),
2. rebases the fork stack onto it, with `git rerere` replaying earlier conflict resolutions,
3. with **Review merges** on, has `models.review` check the finished rebase for what git misses (a
   fork change that still applies but no longer fits upstream), fixing it or asking you,
4. pushes `fork` and tags it with **the upstream nightly's exact version**, which triggers
   `.github/workflows/fork-release.yml` (compatibility gate, typecheck, fork tests, CLI archives for
   macOS arm64 and Linux x64/arm64, the macOS app).

`fork-install` runs on each machine with the desktop app: when a new fork release is out, it asks
(unless `autoInstall`), swaps the app in `/Applications`, restarts it, and reports the devices.

Agents run only when a step needs them: a conflict rerere cannot resolve (`models.resolve`, then
`models.escalate`, then you), a red build, or the optional merge review. A clean update costs no
tokens unless the review is on.

### Devices

`packages/shared/src/cliRelease.ts` points release downloads at this repository, so every T3 server a
fork build installs comes from here. Devices need no list:

- **SSH devices** (added under Settings → Environments) install the desktop's exact version when it
  connects, so nightlies reach them on their own. `ship` finds them in T3 Code's own connection
  catalog, which it unlocks with the app's Keychain key (macOS asks once), and builds on each. The
  first build on a device installs Vite+ and clones the fork into `~/.t3/fork/build` there. ARM64
  works too: everything builds natively.
- **Machines T3 Code does not connect to**, such as a `t3 service` box, go in `fleet` with
  `cli.ts config fleet '<json>'`:

```json
[
  { "name": "vps", "kind": "ssh-service", "ssh": "vps", "t3": "~/.t3/bin/t3" },
  {
    "name": "other",
    "kind": "command",
    "run": "ssh other 'T3CODE_RELEASE_BASE_URL={releaseBase} t3 update {version} --yes'"
  }
]
```

To let another machine merge, run `node ~/.t3/fork/cli.ts setup-host <ssh host>` on the Mac (it clones
the fork there, installs the workflows with the same settings and registers the automation project),
then pick it under **Merges on**. It needs Git push access to this repository and Workflows turned on
in its T3 Code settings; `gh` is optional (without it, failed-build logs and re-runs are skipped).

## Compatibility contract

The official mobile app, the hosted web app, T3 Connect and machines on upstream builds must keep
working with fork builds, and fork builds with them. So a fork build:

- carries the upstream nightly's exact version (never a fork-only version),
- does not change anything they exchange with it: `packages/contracts` schemas, RPC/WebSocket
  messages, the relay (`infra/`), the mobile app, or the database (`apps/server/src/persistence/Migrations`).
  A database change also blocks switching back to upstream.

CI rejects a fork commit that touches those paths unless its message has a
`Fork-Compat: <why this stays compatible>` trailer. Use one only for changes that are additive and
ignorable, such as an optional field old clients drop.

## Adding a feature (for agents)

When the user asks for a feature in this repository, build it and ship it to their machines without
waiting to be asked: the steps below end with it installing. Upstream's [AGENTS.md](AGENTS.md) rules
still apply. On top of them, every fork change is paid for again on each upstream rebase, so:

1. **Start from `origin/fork`.** If `.t3/setup-running` exists, the `Setup Worktree` script is
   installing dependencies: wait for `.t3/setup-done`. Otherwise run `vp i` yourself (and
   `git pull --rebase` in the main checkout). Never work in `~/.t3/fork/repo`; that clone belongs to
   the automation.
2. **Prefer no fork code at all.** If T3 Code settings, `t3.json` scripts, skills, workflows in
   `~/.t3/workflows/` or keybindings can do it, do that instead and say so.
3. **Stay out of upstream code.** Put the feature in new files (a `fork` folder beside the code it
   extends, such as `apps/web/src/fork/`) and connect it to upstream with the smallest edit: one import
   and one call or JSX element. Do not reformat, rename, reorder or "clean up" upstream code, and do not
   touch lockfiles unless the feature needs a dependency. Keep to the
   [compatibility contract](#compatibility-contract).
4. **Test it.** Write a focused `*.test.ts(x)`; CI runs the test files the fork touches. Check only what
   you touched: `vp test run <files>` and `vp run --filter <package> typecheck`.
5. **One commit per feature:**

   ```
   feat(fork): <what the user gets>

   Intent: <what it does and why, one or two lines>
   Keep: <what a conflict resolution must preserve, such as "the button renders after upstream's X">
   ```

   The conflict resolver reads only this message, so make `Intent` and `Keep` enough to redo the change
   on new upstream code. Change an existing feature with `git commit --fixup=<its commit>` and
   `git rebase -i --autosquash $(git merge-base HEAD upstream/main)`, so it stays one commit.

6. **Ship it.** Push (it must fast-forward; if rejected, fetch, rebase and push again):

   ```sh
   git fetch origin && git rebase origin/fork && git push origin HEAD:fork
   ```

   Then write your final summary to the user, saying T3 Code restarts in about a minute. Make
   `node ~/.t3/fork/cli.ts ship` your very last command: it builds on every machine and restarts T3
   Code 15 seconds after it returns, which ends your turn. If it reports an error (a host down,
   dependencies changed), relay it instead; the nightly path ships the change later.

## Resolving conflicts (for agents)

You get the fork commit's message and the conflicted files. Keep upstream's new code and redo the
commit's `Intent` on top of it, keeping its `Keep` line true and the change as small as it was. If the
feature no longer makes sense on the new upstream, say so instead of forcing it. Do not continue the
rebase, commit or run builds; the workflow does that and CI checks the result.

## Operating it

`node ~/.t3/fork/cli.ts <command>` (prints JSON):

| Command                              | Does                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| `status`                             | Base nightly, newest upstream nightly, fork stack, release, app build |
| `config [key value]`                 | Show or set a setting (value is JSON)                                 |
| `plan` / `rebase <tag>` / `continue` | The sync steps the workflow runs                                      |
| `publish`                            | Push `fork` and tag it, which starts the release build                |
| `ship [ref] [--now\|--no-restart]`   | Fast path: build on the Mac and all hosts, patch, restart             |
| `install-desktop <version> [--now]`  | Install a fork release's macOS app and restart T3 Code                |
| `rollback`                           | Put back the app the last install replaced                            |
| `rollout <version>`                  | Update and report the fleet                                           |
| `setup` / `setup-host <ssh host>`    | Set the fork up on this machine / another one (safe to re-run)        |

Settings live in **Settings → Fork** in T3 Code (a fork-only page), which also has **Check now** and
answers a pending install. They are a JSON block in `~/.t3/workflows/fork-sync.ts` on every machine
with the fork; the page writes the same values to each through the workflow definition API, and
`cli.ts config` edits this machine's copy: `cadenceHours` (default 24), `minNightlyAgeHours` (6),
`pinTag`, `skipTags`, `autoInstall` (false), `mergeEnvironmentId` (null: the desktop machine),
`models.resolve` / `models.escalate` / `models.review` (model selections, effort included),
`reviewMerges` (false), `fleet`, `requestedAt` (set by Check now). `node` and `app` are per machine.

The macOS app is not notarized, so it cannot update itself: its update feed is removed on install and
the workflow installs new builds instead. Installs are signed with your own Developer ID or Apple
Development certificate when the Mac has one (`signingIdentity` overrides), which keeps the app's
identity the same across builds so Keychain "Always Allow" answers stick; without one they are signed
ad-hoc and macOS asks for Keychain access again after each install. Upstream's own GitHub workflows are disabled in this repository;
only `fork-release.yml` runs.
