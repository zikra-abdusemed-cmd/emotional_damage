# Do the Damn Thing

A local-first focus app for people who struggle to stay on one task at a time.

Add your tasks and start a session. The app picks a random voice from the `audio/` folder at unpredictable intervals between 3 and 10 minutes. Halfway between those voices, and again with each clip, a desktop notification names your prioritized task.

Your Chrome, Edge, Safari, or other browser profile keeps its own cookie, so that profile’s open session, task list, and crossed-off tasks come back when you reopen the app.

## Run

```sh
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Features

- **Tasks:** add, edit, cross off, reorder priority. Crossed-off tasks stay in Done.
- **Session:** start, pause, resume, stop — restored when you reopen the same browser profile
- **Voices:** drop clips in `audio/`; each reminder picks one at random from the whole folder
- **Desktop nudges:** customized Mac/Windows notifications that name your prioritized task
- **Landing pulse:** visitor count, people active in the last 15 minutes, and crossed-off tasks

## Audio folder

Place voice files directly in the project `audio/` folder:

```text
audio/
  reminder-01.mp3
  get-back-to-work.wav
  focus-check.m4a
```

Supported formats: `.mp3`, `.wav`, `.m4a`, `.ogg`

The server scans this folder (including subfolders) at runtime. Each reminder picks a clip at random. There is no upload UI — you manage the files yourself.

## Stack

- Backend: Node.js built-in HTTP server
- Frontend: static HTML, CSS, and ES modules
- Database: JSON file at `data/db.json`

## Scripts

```sh
npm test
npm run lint
npm run typecheck
```

## Environment Variables

- `PORT`: server port, default `3000`. If unset and 3000 is busy, the server tries 3001–3099 automatically.
- `HOST`: bind address, default `0.0.0.0` (required for most deployments)
- `DB_FILE`: optional path for the JSON database
- `SECURE_COOKIES`: set to `1` to mark the profile cookie Secure (also auto-enabled on HTTPS)
- `TRUST_PROXY`: set to `1` behind HTTPS reverse proxies (cPanel, nginx) so Secure cookies and HSTS use `X-Forwarded-Proto`

## Deploy

Use `npm start` (not `npm run dev`) in production.

If port 3000 is already taken on your server, set `PORT` to whatever your host assigns:

```sh
PORT=8080 npm start
```

If the app fails with `EADDRINUSE` and you set `PORT` explicitly, another process is using that port — stop it or pick a different one. Without `PORT` set, the app auto-finds the next open port starting at 3000.

## Deploy on cPanel (Node.js Selector)

**Do not use "Run NPM Script" for `dev` or `start`.** Those are long-running servers. Starting them from "Run script" leaves a stuck background process, blocks port 3000, and causes:

```text
Can't acquire lock for app: em2
```

### Fix the lock error (one time)

1. In cPanel → **Setup Node.js App** → click **Stop** on app `em2` (if available).
2. Open **Terminal** or SSH and run:

```sh
# replace adhdfrve with your cPanel username
pkill -u adhdfrve -f "node src/server.mjs" || true
pkill -u adhdfrve -f "em2" || true
```

3. In **File Manager**, delete any stale `.lock` file, usually at:

```text
/home/adhdfrve/nodevenv/em2/.lock
```

(or under your domain folder inside `nodevenv/`)

### Start the app the right way

In cPanel → **Setup Node.js App** → app `em2`:

| Setting | Value |
|---|---|
| Application startup file | `app.js` |
| Application mode | Production |
| Application URL | a real domain/subdomain that already exists in cPanel |

If the site is served over HTTPS through cPanel or another reverse proxy, set `TRUST_PROXY=1` in the Node.js environment so the profile cookie stays Secure.

This app has **no npm packages**. Skip **Run NPM Install**. Click **Start App**.

If you see `Web application is inaccessible by its address "http://emotionaldamage.zi/"`:

1. Click **Stop App** first.
2. Fix **Application URL**. `emotionaldamage.zi` is not a working public domain. Use a domain you already added in cPanel, for example `emotionaldamage.yourdomain.com` or your real domain.
3. That domain must already point at this hosting account (DNS A record).
4. Then click **Start App** — still skip **Run NPM Install**.

cPanel sets `PORT` automatically when you use **Start**. Your site URL is configured in the same panel.

### Which buttons to use

| Button | Use it? | Why |
|---|---|---|
| **Run NPM Install** | Yes | installs dependencies |
| **Start / Restart** | Yes | runs the server via `app.js` |
| **Stop** | Yes | stops the server before redeploying |
| **Run script** → `dev` | **No** | hangs forever, breaks cPanel |
| **Run script** → `start` | **No** | same problem |
| **Run script** → `verify` | Optional | quick check only; prints `Setup OK` |

The `Cannot read properties of null (reading 'details')` error is a cPanel UI bug caused by running `dev` or `start` from **Run script**. Those scripts never finish, so cPanel gets a null response and crashes.

If **Start** still fails, the old process is probably still stuck. Do **Stop** → delete `.lock` → **Run NPM Install** → **Restart**.
