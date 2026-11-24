# t3code (fork)

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## Additions over upstream

- **Antigravity Pool provider**: pools registered Antigravity accounts into one provider, picks the account with the most remaining headroom per model family, automatically continues in a new thread when an account hits its limit while another is available, and uses standard usage-limit recovery targeting the quickest-renewing account when all are depleted.
- **Combined usage bars & composer icon**: combined total + pace bars on the Usage page, compact 5-hour and weekly combined bars with pace under the chat input, and an opaque active-member badge on the composer Pool icon.
- **Settings → Fork**: in-app page to configure sync cadence, nightly age, pin/skip tags, auto-install, merge host, conflict/review models, and manual update checks.
- **Automated nightly sync & releases**: rebases the fork stack onto upstream nightlies, publishes releases from this repository, and builds/patches desktop and SSH hosts in place (see [FORK.md](./FORK.md)).
