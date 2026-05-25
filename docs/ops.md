# Operating Conan always-on (PM2 supervision)

Conan's gateway is a single always-on process on `:3747`. In production (the
Mac Mini) it runs under [PM2](https://pm2.io) so it **restarts on crash** and
**comes back on boot**. The process definition lives in
[`ecosystem.config.cjs`](../ecosystem.config.cjs).

## Install PM2 (once)

```bash
npm install -g pm2
```

PM2 is installed globally — not as a project dependency — so the boot-time
resurrection daemon has a stable path independent of the repo's `node_modules`.

## Start / stop / status

All commands run from the repo root (they read `ecosystem.config.cjs`):

```bash
npm run ops:start      # start (or reload) the gateway under PM2
npm run ops:stop       # stop the gateway
npm run ops:restart    # restart it
npm run ops:status     # show process state, uptime, restart count, CPU/mem
npm run ops:logs       # tail the gateway logs
```

These wrap the underlying PM2 calls:

```bash
pm2 start ecosystem.config.cjs     # start with autorestart
pm2 stop conan-gateway             # stop
pm2 restart conan-gateway          # restart
pm2 status                         # or: pm2 list
pm2 logs conan-gateway             # stream stdout+stderr
pm2 delete conan-gateway           # remove from PM2 entirely
```

Logs are written to `.data/pm2-gateway.{out,err}.log` (gitignored).

## Restart on crash

`autorestart: true` in the ecosystem file makes PM2 relaunch the gateway if it
exits unexpectedly. Guards:

- `restart_delay: 2000` — wait 2s between restarts.
- `max_restarts: 10` + `min_uptime: "10s"` — a process that keeps dying within
  10s of start (e.g. port already bound) is marked `errored` after 10 tries
  instead of spinning forever.

Verify locally:

```bash
pm2 start ecosystem.config.cjs
kill "$(pm2 pid conan-gateway)"   # simulate a crash
pm2 status                        # restart count increments; status returns to 'online'
```

## Start on boot

Register PM2's resurrection daemon with the OS, then snapshot the current
process list so it's restored on reboot:

```bash
pm2 startup            # prints a sudo command — run it to install the launchd/systemd hook
pm2 save               # snapshot the running processes (incl. conan-gateway)
```

- macOS (the Mac Mini) → PM2 installs a **launchd** agent.
- Linux → PM2 installs a **systemd** unit.

After `pm2 save`, the gateway is restored automatically on the next boot. Re-run
`pm2 save` whenever you change which processes should be persisted.

To undo boot persistence: `pm2 unstartup`.

## Notes

- The gateway is **single-instance on :3747** (`instances: 1`, `exec_mode:
  "fork"`). Don't run `npm run dev`/`npm start` by hand while the PM2 copy is up
  — the second bind will fail.
- Network exposure stays opt-in: set `CONAN_HOST`/`CONAN_PORT` in the
  ecosystem file's `env` block (default bind is loopback `127.0.0.1`).
