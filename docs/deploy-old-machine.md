# Deploying on an old machine

Written for a box you do not use every day: unknown operating system, unknown
specification, possibly nothing installed on it. Follow it literally. Every step
says what it does and what to do when it does not work.

If you already know the machine is a healthy Linux box with Docker,
[quickstart](./quickstart.md) is shorter and does the same thing.

---

## 0. Two things before you touch it

**The connection matters more than the machine.** Polymarket is geoblocked from
US IP addresses and both bookmakers expect a South African one. Whatever box you
use has to sit on the connection you intend to trade from. A fast machine on the
wrong connection is worse than a slow one on the right connection, because it
will look like it is working.

**Nothing here places a real order.** The console starts in paper mode and that
is enforced in code, not by configuration. You cannot switch it to live by
accident, and you will be able to see which mode it is in from the header at all
times.

---

## 1. What am I on?

Open a terminal and run one line.

**If you have a Start menu** you are on Windows. Press `Win`, type `powershell`,
open **Windows PowerShell**, and run:

```powershell
[System.Environment]::OSVersion.Version; (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
```

**Otherwise** open a terminal and run:

```sh
uname -a; free -h | head -2
```

Write down the RAM figure. It decides one thing later and nothing else.

---

## 2. Node

Everything needs Node 22 or newer, and an older Node fails in confusing ways
rather than obvious ones — so check even if you think it is installed.

```sh
node --version
```

If that prints nothing, or prints anything below `v22`, install it from
<https://nodejs.org> — take the **LTS** download and accept the defaults. Then
**close the terminal and open a new one** before checking again. A terminal
opened before the install does not know Node exists.

---

## 3. Getting the code onto it

Either way works. Pick the one that needs less from you.

**With git** — better, because updates are then one command:

```sh
git clone https://github.com/Jackspence6/ai-trader.git meridian
cd meridian
```

**Without git** — open <https://github.com/Jackspence6/ai-trader> in a browser,
click the green **Code** button, choose **Download ZIP**, and extract it. Then
open a terminal in the extracted folder.

---

## 4. Build it

**Linux or macOS:**

```sh
./scripts/bootstrap.sh
```

**Windows:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```

Both are safe to re-run and neither overwrites a password you have already set.

This installs the packages and compiles the console. On this machine expect it to
take **a few minutes rather than a few seconds** — the build peaks at about
1.5GB of memory and both scripts cap Node below that so it pages rather than
dies. It is not stuck; leave it.

### If the build will not finish

On a machine with less than about 3GB free, the build can run out of memory or
take long enough that you would rather not wait. There is a prebuilt bundle for
exactly this: the console, already compiled, with only the packages it actually
runs. **No build, no package install, no Docker — Node and nothing else.**

```
1. Put meridian-console-bundle.zip on the machine and extract it
2. Open the extracted dist-bundle folder
3. Copy .env.example to .env.local
4. Open .env.local and set SITE_PASSWORD to something only you know
5. Windows:      double-click start.cmd
   Linux/macOS:  ./start.sh
6. Open http://localhost:3000
```

The bundle contains no native code, so the same folder runs on Windows, macOS
and Linux. What it cannot do is run the two engines — those need the full
install from step 4. It is the console, which is the part you want up first.

To regenerate it on any machine that *can* build: `pnpm bundle`.

---

## 5. Set the password

Open `.env.local` in the repository folder — bootstrap created it from
`.env.example` — and set:

```
SITE_PASSWORD=something-only-you-know
```

The console refuses to serve any page until this is set. That is deliberate: a
missing setting is the likeliest misconfiguration, and failing open would
publish the dashboard to anyone who found the machine.

Every other value in that file is optional and documented in place with what
happens when it is missing **and** when it is wrong.

---

## 6. Check before you start

```sh
pnpm preflight
```

It tries every venue, feed and dependency for real rather than reading
configuration. Read every line.

* **FAIL** — something you need is not reachable. Do not start; fix it first.
* **WARN** — a capability you are choosing to go without. Decide deliberately
  rather than scrolling past.

On this machine you should expect the database to FAIL until step 8, and that is
fine. Venue failures are not fine — they mean the box cannot see the markets.

---

## 7. Start the console

```sh
pnpm start
```

Open <http://localhost:3000> and unlock with the password you set.

**The header must read PAPER.** If it reads anything else, stop and find out
why before doing anything else.

What you should see, and why it is correct:

| | |
|---|---|
| Panels saying **NOTHING IS SCANNING** | No engine is running yet. Step 9. |
| NAV, ladder and history blank | No database yet. Step 8. |
| **NO CAPITAL** in the banner | True. Nothing is funded. |

Empty is four different states in this interface and they are drawn
differently on purpose — an idle market and a dead instrument demand opposite
responses. `/system` is the screen that tells you which is which.

---

## 8. The database — optional, and skip it on a small machine

The database gives you NAV history, the capital ladder and the event board. The
console runs without it and says so rather than showing zeroes as though they
were measured.

It runs in Docker. **On Windows with less than 8GB, do not do this yet** —
Docker Desktop needs WSL2 and about 2GB of its own, and you will spend that
memory before the console gets any. On Linux, Docker is native and much lighter.

```sh
docker compose up -d timescale
pnpm db:migrate
```

---

## 9. The engines

The console shows you what the engines find. Without them, nothing scans.

```sh
pnpm trade -- --interval 300   # the Asset Markets loop
pnpm record                    # the market-data recorder
pnpm halt:server               # the kill switch, as its own process
```

Each wants its own terminal window. Two things matter:

**Exactly one trade loop, ever.** Two instances will both act on the same
signal. Verify:

```sh
pgrep -f "scripts/trade.ts" | wc -l     # must print 1
```

**The kill switch runs as its own process** so that it outlives the console. A
stop control that dies with the thing it is meant to stop is not a stop control.

The Event Markets engine is Python and runs in Docker
(`docker compose --profile events up -d`). Same advice as step 8 — leave it
until the rest is up.

---

## 10. Prove the stop works, before you need it

Do not skip this. It is two minutes and it is the only part of the system whose
failure you cannot recover from later.

1. Press **HALT** in the header. The header goes red.
2. **Read the response.** It names both desks. A desk reporting "could not be
   reached" is still running — that is the whole point of reporting per desk
   rather than saying "halted".
3. `pnpm halt:status` should agree.
4. Resume with a written reason. It will refuse without one.

---

## 11. Keeping it up

Once it is running and you have watched it for a while,
[`DEPLOY.md`](../DEPLOY.md) has the systemd units for a Linux box that should
come back on its own after a power cut.

On Windows, the simplest equivalent is a scheduled task set to "run whether the
user is logged on or not", one per process.

---

## When something is wrong

| Symptom | What it means |
|---|---|
| `node` not found after installing it | The terminal was open before the install. Close it, open a new one. |
| Build killed with no error | Out of memory. Use the prebuilt bundle — step 4. |
| Every page redirects to the login screen | `SITE_PASSWORD` is not set, or the terminal was started before you set it. |
| Header reads anything but PAPER | Stop. `MERIDIAN_EXECUTION` has been set. Unset it. |
| Board says NOTHING IS SCANNING | No engine and no database. Correct, until steps 8 and 9. |
| Board says NO ARBITRAGE OPEN | The engine is running and the market is efficient. This is a result. |
| Venue checks fail in preflight | The box cannot reach the markets — usually the connection, not the machine. |

[Operations](./operations.md) covers running it day to day;
[configuration](./configuration.md) documents every variable.
