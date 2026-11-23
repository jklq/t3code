# This fork

`jklq/t3code` is upstream T3 Code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) nightly
plus a short stack of fork commits on the **`fork`** branch (the default branch). `main` is an untouched
mirror of upstream and is not used.

```
upstream nightly tag ── fork commit 1 ── fork commit 2 ── … = fork branch = what ships
```

## How it stays current

A T3 Code workflow (`fork/t3-workflow.ts`, installed as `~/.t3/workflows/fork-sync.ts`) runs every hour
on the Mac and acts when `cadenceHours` has passed or `fork` has commits that are not released yet
(a landed feature starts it at once, see below). Then `fork/cli.ts`:

1. picks the newest upstream nightly at least `minNightlyAgeHours` old (or `pinTag`); for new fork
   commits, the newest nightly of any age, or else it rebuilds the current base's release,
2. rebases the fork stack onto it, with `git rerere` replaying earlier conflict resolutions,
3. pushes `fork` and tags it with **the upstream nightly's exact version**, which triggers
   `.github/workflows/fork-release.yml` (compatibility gate, typecheck, fork tests, CLI archives for
   macOS arm64 and Linux x64/arm64, the macOS app),
4. asks before installing (unless `autoInstall`), swaps the app in `/Applications`, restarts it, and
   reports the fleet.

An agent runs only when a step fails: a conflict rerere cannot resolve (a cheap model first, a stronger
one second, then you), or a red build. A clean update costs no tokens.

### Fleet

`packages/shared/src/cliRelease.ts` points release downloads at this repository, so every T3 server a
fork build installs comes from here:

- **SSH hosts** the desktop launches (like the home machine) install the desktop's exact version on
  their next connect. Nothing to do; adding a host in T3 adds it to the fleet.
- **Background services** (`t3 service`) and anything else go in `fleet` in `~/.t3/fork/config.json`:

```json
"fleet": [
  { "name": "home-machine", "kind": "ssh-launched", "ssh": "home-machine" },
  { "name": "vps", "kind": "ssh-service", "ssh": "vps", "t3": "~/.t3/bin/t3" },
  { "name": "other", "kind": "command", "run": "ssh other 'T3CODE_RELEASE_BASE_URL={releaseBase} t3 update {version} --yes'" }
]
```

`ssh-launched` entries are only checked and reported. A host that already had upstream's build of the
same version keeps it until the next version.

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

6. **Ship it:**

   ```sh
   git fetch origin && git rebase origin/fork && git push origin HEAD:fork
   ~/.t3/bin/t3 workflow start fork-update --input '{"scheduledAt":"manual"}' --key "ship-$(git rev-parse --short HEAD)"
   ```

   The push must fast-forward; if it is rejected, fetch, rebase and push again. Then tell the user it is
   building (about 10 minutes, https://github.com/jklq/t3code/actions) and that T3 Code will ask them to
   install it, which restarts the app. Do not wait for the build.

Server-side changes reach SSH hosts that already run the same version only with the next upstream
nightly; the desktop app and everything it renders update at once.

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
| `install-desktop <version> [--now]`  | Install a fork release's macOS app and restart T3 Code                |
| `rollback`                           | Put back the app the last install replaced                            |
| `rollout <version>`                  | Update and report the fleet                                           |
| `setup`                              | Install the workflow and engine on this Mac (safe to re-run)          |

Settings in `~/.t3/fork/config.json`: `cadenceHours` (default 24), `minNightlyAgeHours` (6),
`pinTag` (hold at one nightly), `skipTags` (nightlies to never use), `autoInstall` (false),
`models.resolve` / `models.escalate` (agent models), `fleet`.

The macOS app is unsigned, so it cannot update itself: its update feed is removed on install and the
workflow installs new builds instead. Upstream's own GitHub workflows are disabled in this repository;
only `fork-release.yml` runs.
