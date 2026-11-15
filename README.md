# Check-in

A live QR check-in board for classes and workshops, running at **[checkin.majlisofai.com](https://checkin.majlisofai.com)**.

1. The host opens the site, names the session and enters the number of participants.
2. The host board shows a QR code. Participants scan it, enter their email address and tap **I'm here**.
3. The headcount rises live on the board and changes colour as the room fills:
   - **Red** below the orange threshold (default 30%)
   - **Orange** from 30%
   - **Green** from 60%
   - At 100% the board reads *Everyone is here. The class can start.*

The host can add walk-ins for people who can't scan, and undo the last one. **End check-in** (tap twice to confirm) closes the session to new check-ins, updates every open screen, **downloads a CSV** of everyone who checked in (with email addresses), and returns the host to the home page to create the next one. The board also has a **Download CSV** button. An ended board stays viewable from **Past check-ins**.

**Past check-ins** (`/past`, linked from the home page) lists the check-ins created on that browser. Each can be deleted, or all at once (two taps to confirm). Deleting erases the session's arrivals and email addresses from the server and closes any screens still showing it.

## How it works

- **Cloudflare Worker** (`src/index.js`) serves the static page from `public/` and a small JSON API under `/api/`.
- **One Durable Object per session** stores the settings and arrivals and pushes every change to connected screens over WebSockets (hibernation API). Screens fall back to polling every 5 s if the socket drops.
- Sessions expire and are deleted **30 days** after creation.

### Links

| Link | Who | What |
| --- | --- | --- |
| `/` | Host | Create a check-in. |
| `/past` | Host | The check-ins you created on this browser, with delete. |
| `/h/<id>#<key>` | Host | The live board. Anyone with this link can run the board, so share it only with co-hosts. |
| `/c/<id>` | Participants | The page the QR code opens. |

### Rules

- **One check-in per device**: a random ID kept in the browser's local storage plus an HttpOnly cookie. A private window, another browser, or clearing site data gets around it; browsers don't expose a real hardware ID.
- **One check-in per email address** per session.
- **No identities on screen.** The board lists arrivals as "Participant 1", "Walk-in 1" and so on. Email addresses never leave the server except in the CSV export, which requires the host key. Participants' phones only receive the count.
- The CSV has the columns `session, number, email, type, checked_in_at_utc`, is UTF-8 with a BOM so Excel opens it cleanly, and escapes values that a spreadsheet would treat as formulas.

### API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/sessions` | `{title, total, amberAt, greenAt}` → `{sid, key}` |
| `GET` | `/api/sessions/:sid` | Public state. With `x-host-key`, includes anonymous arrivals. |
| `DELETE` | `/api/sessions/:sid` | Erase the check-in and its data. Requires `x-host-key`. |
| `GET` | `/api/sessions/:sid/export` | CSV of everyone checked in, with emails. Requires `x-host-key`. |
| `POST` | `/api/sessions/:sid/checkin` | `{device, email}` → `{already: false \| "device" \| "email", state}` |
| `POST` / `DELETE` | `/api/sessions/:sid/walkin` | Add / undo a walk-in. Requires `x-host-key`. |
| `POST` | `/api/sessions/:sid/end` | End the check-in. Requires `x-host-key`. Later check-ins and walk-ins get `410`. |
| `GET` | `/api/sessions/:sid/ws` | WebSocket. Add `?key=` for the host feed. |

## Develop

```sh
npm install
npm run dev        # http://localhost:8787
```

## Deploy

```sh
npx wrangler login
npm run deploy
```

`wrangler.jsonc` binds the Worker to the custom domain `checkin.majlisofai.com`; Cloudflare creates the DNS record and certificate on first deploy.

## License

MIT. The bundled QR encoder (`public/vendor/qrcode.min.js`) is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, also MIT.
