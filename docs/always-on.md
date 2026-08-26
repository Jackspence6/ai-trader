# Running unattended, and updating itself

For a machine that nobody sits in front of. Once this is set up, pushing to
`main` from anywhere is enough: the box notices within fifteen minutes, rebuilds,
proves the new version passes its tests, and restarts itself.

If that machine is old or you are not sure what is on it, do
[deploying on an old machine](./deploy-old-machine.md) first. This assumes the
console already runs there.

---

## What the updater does, in order

```
fetch main ─── nothing new? ──────────────────────────────► stop, 2 seconds
     │
     └─ new commit
          ├─ pull (fast-forward only)
          ├─ install dependencies          ┐
          ├─ build                         │ the old version is still
          └─ run the TypeScript test suite ┘ running and serving all of this
               │
               ├─ anything failed ──► put the checkout back, keep serving
               │
               └─ all passed ──► restart  ◄── the only downtime
                                    │
                                    └─ probe it ─┬─ answering ──► done
                                                 │
                                                 └─ silent ──► roll back,
                                                               restart the old
                                                               version, probe
                                                               again
```

**A failed update never takes the box down.** That is the rule the whole design
follows from. A machine running yesterday's working code is fine; a machine that
stopped at 3am because a build broke is not, and nobody would find out until
they looked.

Nothing is stopped until the new version has proved it builds and its tests
pass. If any step fails, the checkout is returned to the commit that is actually
running — leaving the tree ahead of the processes is the worst state available,
because everything keeps working until the next unrelated restart, which then
starts code that never built.

### Three things it will not do

* **It never touches the kill switch.** If someone halted the desks, they stay
  halted through an update. An updater that resumed trading on its own would
  defeat the one control that exists to stop it.
* **It never forces anything.** A dirty working tree means somebody edited the
  box by hand. That is reported, not overwritten.
* **It never touches `.env.local`**, execution mode, or anything gitignored. It
  only fast-forwards tracked files.

---

## Setting it up on Linux

```sh
sudo mkdir -p /var/log/meridian && sudo chown meridian /var/log/meridian
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meridian-update.timer
```

Edit `WorkingDirectory` and `User` in the units first — they assume
`/opt/meridian` and a `meridian` user.

The updater restarts the other services, which an unprivileged user cannot do.
One scoped grant covers it:

```sh
sudo cp deploy/systemd/meridian-update.sudoers /etc/sudoers.d/meridian-update
sudo chmod 0440 /etc/sudoers.d/meridian-update
sudo visudo -c            # must say "parsed OK" before you walk away
```

Read that file before installing it. It is one user, one binary, three named
units — it cannot restart anything else, cannot stop or disable them, and cannot
run any other command as root. **Skipping it is a valid choice**: the updater
still pulls, builds and tests, and tells you the new version is waiting for a
restart.

### Checking it is actually running

```sh
systemctl list-timers meridian-update    # next and last run
tail -f /var/log/meridian/update.log     # what it did
```

A timer that has never fired is the failure that hides best. Look at
`list-timers` once, on the day you set it up.

---

## Setting it up on Windows

There is no systemd. Task Scheduler does the same job:

```powershell
# Adjust the path. Runs every 15 minutes, whether or not anyone is logged in.
$action  = New-ScheduledTaskAction -Execute "node" -Argument "scripts\update.mjs" -WorkingDirectory "C:\meridian"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName "Meridian update" -Action $action -Trigger $trigger `
             -RunLevel Highest -Description "Pull main, rebuild, restart"
```

Set `MERIDIAN_UPDATE_RESTART` to whatever restarts your console — for example
`schtasks /end /tn "Meridian console" & schtasks /run /tn "Meridian console"` —
or leave it unset, and the updater will build the new version and tell you it is
waiting for a restart.

---

## Running it by hand

```sh
pnpm self-update:dry     # say what it would do, change nothing
pnpm self-update         # do it
```

`--force` rebuilds even when the commit has not changed, which is occasionally
useful after editing something outside git.

**The name is `self-update`, not `update`, and that is not a style choice.**
`pnpm update` is pnpm's own built-in dependency bumper, and a built-in beats a
`package.json` script of the same name on every platform. This document used to
say `pnpm update`; following it upgraded seven packages, rewrote 849 lines of
`pnpm-lock.yaml`, and deployed nothing — while looking like it had worked. It is
easy to miss because `pnpm update:dry` has no built-in equivalent, so the dry
run really does run the script and reads correctly.

If you ever find yourself renaming this back to something shorter, `pnpm run
update` would work, but relying on a person typing `run` is not a safety
property. Leave it as `self-update`.

## Configuration

| | |
|---|---|
| `MERIDIAN_UPDATE_BRANCH` | Branch to track. Default `main` |
| `MERIDIAN_UPDATE_RESTART` | Command to restart the services. Defaults to the systemd units when present. Set it to a single space to disable restarting |
| `MERIDIAN_UPDATE_SKIP_TESTS=1` | Skip the test gate. Not recommended — the gate is what makes an unattended restart safe |
| `MERIDIAN_UPDATE_HEALTH_URL` | What to probe after the restart. Default `http://localhost:3000/login`. Any HTTP response counts, including 401 and 302 — a locked console answering 401 is a working console. Only silence is a failure. Set it to a single space to skip the probe |

The test gate is vitest only, deliberately. It needs no network and no database,
so it is a real gate rather than a coin flip on whether a venue answered. A box
that cannot reach the internet must still be able to update itself.

---

## When it stops updating

The log says which of these it is. In rough order of likelihood:

| Log line | Meaning |
|---|---|
| `SKIP: the working tree has local changes` | Somebody edited the box directly, or a build wrote to a tracked file. Commit, stash or discard, and it resumes on its own |
| `SKIP: could not reach the remote` | Network. It retries next tick; no action needed unless it persists |
| `WARN: the build modified tracked files` | The build itself is dirtying the tree, which will block the *next* update. The line names the file — gitignore and untrack it |
| `ROLLBACK: tests failed on the new version` | `main` is broken. The box is fine and still on the last good commit. Fix `main` and it catches up on its own |
| `another update is running` | Two ticks overlapped. Harmless — the lock is doing its job |
| `no restart command is configured` | It updated and built, but nothing restarted. Install the sudoers file or set `MERIDIAN_UPDATE_RESTART` |
| `restarted but never came up` | The new version built and passed its tests, then failed to serve — usually a missing setting or a taken port, neither of which a test suite can see. It has already rolled back and restarted the old version |
| `FAIL: neither version is answering` | The rollback did not bring it back either. This one needs a person |

---

## What this does not solve

**The database and the events engine are not restarted.** They run in Docker and
Compose handles their own lifecycle; a schema migration still needs
`pnpm db:migrate` run deliberately.

**A version that fails on a machine-specific condition still costs one
restart.** The probe catches it and rolls back, but the box is down for the
minute or two that takes. The test gate is what keeps that rare.
