# Dependency checklist

Everything the Tijarah Books WhatsApp bot needs, and who installs it.

**With Docker you install one thing: Docker.** Columns 2 and 3 below are inside the image —
listed so you know what is there, not so you install it. Only tick the "host" column.

---

## 1. On the host — the whole list

- [ ] **Linux** — Ubuntu 22.04 / 24.04 or Debian 12 (what it was built against)
- [ ] **Docker 24+** with the `compose` plugin — `curl -fsSL https://get.docker.com | sh`
- [ ] **2 GB RAM** minimum, 4 GB comfortable (a Chromium per WhatsApp session)
- [ ] **3 GB free disk** for the image, plus room for PDFs and the session store
- [ ] **Outbound HTTPS** to `api.tijarabooks.com`, `web.whatsapp.com`, `generativelanguage.googleapis.com`
- [ ] **No inbound ports** — nothing to open on the firewall

That is the end of the host list. Not needed: database server, Redis, nginx/Apache, Node,
Chromium, PM2.

---

## 2. Operating-system packages (inside the image)

### Build stage — compiling native modules

- [ ] `python3`, `make`, `g++` — `better-sqlite3` compiles from source

### Runtime stage — Chromium's shared libraries

WhatsApp Web runs in a real browser, which is why this list is long.

- [ ] `chromium`, `chromium-sandbox` _(arm64 only; amd64 uses Puppeteer's own download)_
- [ ] `fonts-liberation` — without it WhatsApp renders as empty boxes
- [ ] `libappindicator3-1` `libasound2` `libatk-bridge2.0-0` `libatk1.0-0` `libcups2`
- [ ] `libdbus-1-3` `libdrm2` `libgbm1` `libgtk-3-0` `libnspr4` `libnss3`
- [ ] `libx11-xcb1` `libxcomposite1` `libxdamage1` `libxrandr2` `xdg-utils`

### Runtime stage — tooling

- [ ] `ffmpeg` — audio/video conversion for media messages
- [ ] `sqlite3` — the backup and restore scripts
- [ ] `postgresql-client-17` — only for `DATABASE_TYPE=postgres`; client 15 refuses a 16+ server
- [ ] `dumb-init` (signal handling) · `gosu` (drop root) · `patch` · `curl` · `procps`

---

## 3. Node packages

**Node >= 22.13** (`engines` in `package.json`). 662 packages install in total; ~910 MB
across both `node_modules` trees.

### API runtime — 42 packages

| Group         | Packages                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | `@nestjs/common` `core` `platform-express` `config` `swagger` `throttler` `typeorm` `websockets` `platform-socket.io` `serve-static` `bullmq` |
| WhatsApp      | `whatsapp-web.js` (1.34.7, pinned) · `@whiskeysockets/baileys` (7.0.0-rc14, pinned)                                                           |
| Database      | `typeorm` · `better-sqlite3` _(compiles)_ · `pg`                                                                                              |
| HTTP          | `undici` · `https-proxy-agent` · `socks-proxy-agent`                                                                                          |
| Queue / cache | `bullmq` · `ioredis` · `@bull-board/{api,express,nestjs}` — **optional**, off by default                                                      |
| Media         | `sharp` _(prebuilt binary)_ · `audio-decode` · `qrcode`                                                                                       |
| Archives      | `archiver` · `adm-zip` · `tar-stream`                                                                                                         |
| Validation    | `zod` · `class-validator` · `class-transformer`                                                                                               |
| Realtime      | `socket.io` · `@socket.io/redis-adapter`                                                                                                      |
| AI            | `@anthropic-ai/sdk` — optional; **Gemini is called over plain HTTP via `undici`, no SDK**                                                     |
| Other         | `helmet` · `rxjs` · `reflect-metadata` · `dockerode` · `@aws-sdk/client-s3` · `@modelcontextprotocol/sdk`                                     |

Two packages are **pinned without `^`** on purpose — `whatsapp-web.js` and `baileys` break on
patch releases because they track WhatsApp's own internals. Do not loosen them.

### API build-only — 27 packages

`typescript` `@nestjs/cli` `@nestjs/schematics` `jest` `ts-jest` `@nestjs/testing` `supertest`
`eslint` `prettier` `typescript-eslint` `ts-node` `tsconfig-paths` `concurrently` `globals`
`@eslint/js` `eslint-config-prettier` `eslint-plugin-prettier` + 10 `@types/*`

> `npm ci` **must** run with `--include=dev` on the server: the build needs `nest` and
> `typescript`. With `NODE_ENV=production` set, npm skips them and the build dies with
> `sh: 1: nest: not found`.

### Dashboard runtime — 15 packages

`react` `react-dom` `react-is` `react-router-dom` `@tanstack/react-query`
`@tanstack/react-table` `recharts` `lucide-react` `socket.io-client` `i18next`
`react-i18next` `i18next-browser-languagedetector` `linkifyjs` `linkify-react`
`yet-another-react-lightbox`

### Dashboard build-only — 16 packages

`vite` `@vitejs/plugin-react` `typescript` `eslint` `prettier` `jsdom`
`@testing-library/{react,dom}` `eslint-plugin-react-{hooks,refresh}` `typescript-eslint`
`globals` `@eslint/js` + 3 `@types/*`

---

## 4. External services

- [ ] **Tijarah Books API** — `api.tijarabooks.com`; no credentials today, the PDF endpoints are open
- [ ] **WhatsApp account** — a _separate_ number, not the main business line
- [ ] **Gemini API key** — free tier runs out after a few dozen turns; without one the bot
      falls back to rule-based replies and keeps working
- [ ] **Anthropic API key** — optional, only if you prefer Claude over Gemini

Not required: Postgres, Redis, S3/MinIO. They are wired in and switched off.

---

## 5. Install verification

- [ ] `node -v` → 22.13 or higher
- [ ] `npm ci` finishes with no `gyp ERR!`
- [ ] `npm run build` produces `dist/main.js`
- [ ] `npm run dashboard:build` produces `dashboard/dist/`
- [ ] `deploy/preflight.sh` passes — it checks the real Tijarah endpoints, not just the install
- [ ] `curl -sf http://127.0.0.1:2785/api/health` returns 200

Full instructions: **`INSTALL.md`**. Settings that decide blast radius: **`deploy/README.md`**.
