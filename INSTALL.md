# Installing the Tijarah Books WhatsApp bot

For whoever runs the server. Two routes: **Docker** (recommended — one container, nothing
else on the machine touched) or **direct Node** (if Docker is not an option).

Once it is running, **`USER_GUIDE.md`** takes over: logging in, connecting WhatsApp, adding
clients and day-to-day use.

---

## What it needs

> A tickable list of every dependency — host, OS packages, Node packages, external services —
> is in **`DEPENDENCIES.md`**.

|             |                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **OS**      | Any Linux with Docker. Ubuntu 22.04/24.04 and Debian 12 are what it was built against.                                            |
| **RAM**     | 2 GB minimum, 4 GB comfortable — WhatsApp Web runs a real Chromium per session.                                                   |
| **Disk**    | 3 GB for the image, plus room for PDFs and the session store.                                                                     |
| **Network** | Outbound HTTPS to `api.tijarabooks.com`, `web.whatsapp.com` and `generativelanguage.googleapis.com`. **No inbound ports needed.** |
| **Docker**  | 24 or newer, with the `compose` plugin.                                                                                           |

Nothing else. No database server, no Redis, no web server — it runs on SQLite and serves its
own dashboard.

---

## Route 1: Docker (recommended)

### Why this route

The bot drives WhatsApp through a real browser, so it needs Chromium and about twenty X11 and
GTK shared libraries, plus `ffmpeg` and `sqlite3`. Installing those directly on a server is
how you end up with a Chromium or `libnss3` version that some other application on the same
machine did not expect. **In Docker none of it is installed on the host** — it all lives
inside the image.

### Install Docker, if it is not there

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # then log out and back in
```

### Run it

```bash
git clone https://github.com/omarrangila-prog/tijarah-whatsapp-bot.git
cd tijarah-whatsapp-bot/deploy
./deploy.sh          # copies .env.production.example → .env, then stops
nano .env            # fill in the ⚠ lines — see deploy/README.md
./deploy.sh          # preflight → build → start → waits for health
```

The first build takes 5–15 minutes (it compiles native modules and builds the dashboard).
Later runs reuse Docker's cache.

Then open `http://127.0.0.1:2785`, or tunnel to it over SSH:

```bash
ssh -L 2785:127.0.0.1:2785 user@server
```

The API key is written inside the container:

```bash
docker compose exec openwa-api cat /app/data/.api-key
```

### What it does and does not touch

| Touches                                                     | Does not touch                                        |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| One container, `openwa-api`                                 | Any system package, library or Chromium on the host   |
| One Docker volume, `openwa_openwa-data`                     | Any other container or volume                         |
| `127.0.0.1:2785` only — **not** reachable from the internet | Any port other services use; nothing listens publicly |
| The `.env` file you filled in                               | Any file outside the clone directory                  |

The compose file also defines Postgres, Redis, MinIO and a browser service. **None of them
start** — they sit behind compose profiles and the API declares them `required: false`.
`deploy.sh` names only `openwa-api`.

### Day to day

```bash
./deploy.sh --logs     # follow the log
./deploy.sh --stop     # stop it
./deploy.sh            # upgrade in place after a git pull
```

### Removing it completely

```bash
cd tijarah-whatsapp-bot/deploy && ./deploy.sh --stop
docker compose --project-directory .. down --rmi local
docker volume rm openwa_openwa-data    # deletes the WhatsApp session and job history
cd ../.. && rm -rf tijarah-whatsapp-bot
```

Nothing is left on the host.

---

## Route 2: Direct Node, no Docker

Only if Docker cannot be used. You are installing Chromium's dependencies on the host, which
is the thing Route 1 avoids — on a server that runs anything else, read that warning twice.

### 1. Node 22.13 or newer

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # must be >= 22.13
```

### 2. Build tools and Chromium's runtime

```bash
sudo apt-get install -y python3 make g++ \
  chromium fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils \
  sqlite3 ffmpeg curl
```

`python3`, `make` and `g++` are for the native modules (`better-sqlite3`). They can be removed
after the install if you want them gone.

### 3. Install and build

```bash
git clone https://github.com/omarrangila-prog/tijarah-whatsapp-bot.git
cd tijarah-whatsapp-bot
npm ci                                      # 42 runtime + 27 build dependencies
npm run build                               # the API
npm run dashboard:ci -- --include=dev && npm run dashboard:build   # the dashboard
```

### 4. Configure and run

```bash
cp deploy/.env.production.example .env
nano .env                                   # fill in the ⚠ lines
chmod 600 .env
npm run start:prod
```

### 5. Keep it running

```ini
# /etc/systemd/system/tijarah-bot.service
[Unit]
Description=Tijarah Books WhatsApp bot
After=network-online.target

[Service]
Type=simple
User=tijarah
WorkingDirectory=/opt/tijarah-whatsapp-bot
EnvironmentFile=/opt/tijarah-whatsapp-bot/.env
ExecStart=/usr/bin/node dist/main
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tijarah-bot
sudo journalctl -u tijarah-bot -f
```

Run it as its own unprivileged user, with its own directory. Do not run it as root.

---

## If "Invalid API key" appears and the key looks correct

The key in `data/.api-key` is only a **copy**; authentication checks a peppered hash in the
database. If `API_KEY_PEPPER` was never pinned, the app generates one into
`data/.env.generated` — and anything that recreates that file (a wiped volume, or `deploy.sh`
run from a second clone of the repo) leaves the stored hash unmatchable. The log says so
exactly:

```
Bootstrap API key file does not match any stored key hash — API_KEY_PEPPER changed
since the key was seeded?
```

**Deleting the key file does not repair it.** The app seeds a key only when the database holds
_zero_ of them (`count === 0` in `auth.service.ts`), so an orphaned hash means it skips seeding
and writes no file — leaving no way in, because the dashboard needs a key you no longer have.
The stale row has to go.

Pin the pepper first, or the repair can undo itself:

```bash
cd deploy
echo "API_KEY_PEPPER=$(openssl rand -hex 32)" >> .env   # once, forever
```

Then either drop the orphaned key row:

```bash
docker run --rm -v openwa_openwa-data:/d alpine \
  sh -c 'apk add -q sqlite && sqlite3 /d/main.sqlite "DELETE FROM api_keys;"'
./deploy.sh --no-check
docker run --rm -v openwa_openwa-data:/d alpine cat /d/.api-key
```

or, before there is any real data, wipe the volume — simpler, and it also clears the
auto-generated pepper:

```bash
./deploy.sh --stop
docker volume rm openwa_openwa-data
./deploy.sh --no-check
docker run --rm -v openwa_openwa-data:/d alpine cat /d/.api-key
```

A wipe also discards the WhatsApp pairing, so do it **before** scanning the QR, not after.

Keep **one** clone of the repository on the server. Two copies are two compose projects
competing over one volume, which is what causes this.

## Before the client uses it

`deploy/preflight.sh` runs automatically under Route 1 and can be run by hand under Route 2.
It checks the real endpoints and refuses a deployment that would fail silently — the document
host returning a PDF rather than HTML, the job queue answering, the approval table existing,
the Gemini key having credit. Every check is there because that exact thing went wrong once.

Then read `deploy/README.md` for the settings that decide blast radius, and `HANDOFF.md`
for how the system is put together and what is still waiting on Tijarah.
