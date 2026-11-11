# EC2 bridge capacity: staying on t3.medium (monitor)

**Decision (2026-11-11):** keep the PhoneClaw bridge (`phoneclaw-bridge`, `i-09ee74d7aff8b154d`, us-east-1) on
**t3.medium** for now, and monitor memory. Upgrade only if the numbers below say so.

## Why this came up

On 2026-11-11 a fourth always-on Chrome was added to the bridge's noVNC desktop: `pc-chrome-google`, a
signed-in Google session that the family newspaper's Google Photos keepalive refreshes its cookies from
(DevTools on `127.0.0.1:9233`, profile `/home/phoneclaw/.chrome-google`; see the family-newspaper repo,
`newspaper scripts/automation/gphotos_keepalive.py`). With the Google Photos web app open, available memory
fell to **about 280 MB with no swap**, one spike away from the OOM killer.

## What was done

| Change | Effect |
| --- | --- |
| `pc-chrome-google` opens `https://www.google.com/` instead of Google Photos | It still stays signed in: Google's `RotateCookiesPage` renews the cookies |
| Added a 2 GB `/swapfile` (in `/etc/fstab`), `vm.swappiness=10` | A safety net for spikes; idle pages move out |
| journald capped at 300 MB (`/etc/systemd/journald.conf.d/size.conf`), vacuumed from 1.4 GB | Disk |
| `apt-get clean`, npm caches, disabled snap revisions (`refresh.retain=2`) | Disk |
| Removed `~phoneclaw/.cargo/registry` and the Rust `stable` toolchain (`rustup toolchain uninstall stable`) | Disk; the `otter` and `himalaya` binaries in `~phoneclaw/.cargo/bin` still run |

To update `otter` or `himalaya` later, reinstall the toolchain first (`rustup toolchain install stable`, about 1
minute), or build the binary elsewhere and copy it over. A Rust build on this box also strains memory.
Never run `rustup self uninstall`: it deletes `~/.cargo`, including both binaries.

## Baseline after cleanup (2026-11-11)

| | |
| --- | --- |
| RAM | 3.7 GiB total, **~1.1 GiB available** |
| Swap | 2 GiB, ~480 MiB used (idle pages) |
| Memory pressure (`/proc/pressure/memory`) | avg60 ≈ 0.04, no OOM kills in the past 2 days |
| Disk | 19 GB, **74% used, 4.9 GB free** |

Chrome memory, measured as PSS so shared pages aren't counted twice:

| Chrome | PSS |
| --- | --- |
| Google (`pc-chrome-google`) | ~750 MB |
| Slack | ~475 MB |
| Outlook | ~400 MB |
| ADGA Outlook | ~400 MB |

Everything else (bridge server, cloudflared, wacli, Xvfb/x11vnc/noVNC, Docker rss-bridge, Postgres) totals
under ~150 MB.

## How to check

```bash
# via SSM (profile personal-economist); ship as base64 and run with bash, as in CLI_BRIDGE_SECURITY.md
free -h
cat /proc/pressure/memory
journalctl -k --since "-7 days" | grep -ci "out of memory\|oom-kill"
df -h /
for d in outlook adga slack google; do t=0; for p in $(pgrep -f "user-data-dir=/home/phoneclaw/.chrome-$d"); do
  r=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null); t=$((t+${r:-0})); done; echo "chrome-$d $((t/1024))M"; done
```

Use PSS, not the sum of RSS: summing RSS across Chrome's processes overstated the Google Chrome at 2.3 GB.

## When to upgrade

Move to a bigger instance if any of these hold:

- available RAM stays under ~300 MB, or swap use climbs past ~1.5 GB;
- memory pressure `some avg60` stays above ~5, or any OOM kill shows up;
- calls, the CLI bridge or the desktop Chromes feel slow;
- another always-on Chrome or a heavy service is added.

Cost (us-east-1 Linux on-demand, AWS Price List API, 2026-11-11). Disk is billed separately and doesn't change.

| Instance | RAM | vCPU | $/hour | ≈ $/month |
| --- | --- | --- | --- | --- |
| **t3.medium** (current) | 4 GiB | 2 | 0.0416 | 30.37 |
| t3.large | 8 GiB | 2 | 0.0832 | 60.74 |
| t3a.large (AMD) | 8 GiB | 2 | 0.0752 | 54.90 |

The instance uses **unlimited** CPU credits, so sustained CPU above baseline (20% per vCPU on medium, 30% on
large) adds a surcharge on either size. A 1-year Savings Plan cuts roughly 30 to 40%. Resizing needs a
stop/start: the public IP changes unless it is an Elastic IP, so check the security-group and tunnel setup first.

## Still open

- The old kernel `linux-image-6.17.0-1017-aws` is still installed (the box runs 7.0), a few hundred MB. It
  isn't marked for autoremove, so removing it needs an explicit purge.
- The Slack Chrome profile is 1.6 GB, mostly cache. Trimming it may sign Slack out.
