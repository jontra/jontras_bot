# Wordle Feature Parity Plan

## Wordle Bot Feature Inventory
- **WhatsApp session & runtime timers** – Boots a `whatsapp-web.js` client with QR login, persists session tokens (LocalAuth), and schedules two long‑running timers: daily stat drops at `early_podium_time` and a weekly cleanup/reset at Saturday midnight. (`scripts/main.ts` lines ~1‑120)
- **Wordle submission parsing & validation** – `handleWordle` uses `WordleResult.getResult` to parse the standard “Wordle <day> X/6*” share text, rejects duplicates, invalid grids, and stale days (±1 day tolerance). (`scripts/main.ts` 150+ and `WordleResult.ts`)
- **Persistent per‑chat data store** – `Database` + `ChatData` wrap a `ResultCollection`, keep per-chat caches (scores, averages, weekly scores) and serialize to `data.json`. (`scripts/Database.ts`, `ChatData.ts`)
- **Scoreboards and leaderboards** – `statistics.ts` exports helpers for cumulative scores, averages, weekly tallies, per-day podiums, average solve time (mean/std), and “players passed” comparisons. Results feed both auto notifications and commands.
- **Configuration management** – `config.json` stores per-chat flags (`early_podium`, `early_podium_threshold`, `notify_leaderboard`, `notify_timing`); `!set` updates the file at runtime.
- **Early podium tracker** – In-memory `tracker` counts daily solvers per chat, auto-sends podium image once a configurable threshold is met to celebrate early finishes.
- **Personal notifications** – After each submission the bot:
  - compares submission time against the player’s average/std dev and sends “you’re early/late” nudges when `notify_timing` is true,
  - identifies leaderboard overtakes (overall, averages, weekly) and DMs celebratory messages when `notify_leaderboard` is true.
- **Podium image generation** – `getPodiumImage` fetches top 3 profile photos, pipes them through `generatePodiumFromUrl` (Sharp) to create an image attachment for daily summaries or `!podium`.
- **Command surface** – Text commands (`!scores|s`, `!averages|a`, `!weekly|w`, `!podium|p`, `!set`, `!ping`, `!id`, `!today`, `!help`) let users query leaderboards, tune settings, and rebuild chat history.


## Implementation Strategy for Jontras (Towns) Bot

### Platform constraints & goals
- Towns bots are **stateless per webhook** (see `AGENTS.md`), so every feature that relied on in-memory maps (`tracker`, caches, timers) must use an external store (SQLite/Postgres/Redis) or a process that holds state and persists it frequently.
- Target parity: replicate Wordle parsing, leaderboards, configurable notifications, podium art, and scheduled digests within the Towns bot (`src/index.ts`) while respecting slash-command + event-handler patterns.

### Data layer & storage
1. **Choose persistence** – Render does not guarantee durable local disks for web services, so SQLite will not survive restarts. Use Render’s managed PostgreSQL (the free “Starter” tier is enough) and expose its `DATABASE_URL` via environment variables. Drizzle ORM can target PostgreSQL via `pg` or `postgres-js`, keeping the schema portable for future migrations.
2. **Schema sketch (minimal)**
   - `submissions`: `{ id UUID PK, channel_id TEXT, player_id TEXT, wordle_day INT NOT NULL, guesses INT, hard_mode BOOLEAN, grid TEXT, solved_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(channel_id, player_id, wordle_day) }`  
     `wordle_day` equals the exact puzzle number parsed from the Wordle share text (e.g., 1599). We still store timestamps for latency analytics, but all grouping/leaderboard logic keys off this canonical puzzle index.
   - `chat_settings`: `{ channel_id TEXT PK, early_podium BOOLEAN DEFAULT true, early_podium_threshold INT DEFAULT 5, notify_leaderboard BOOLEAN DEFAULT true, notify_timing BOOLEAN DEFAULT true, digest_time TEXT DEFAULT '19:00', timezone TEXT DEFAULT 'UTC' }`
   - `daily_digest_log` (optional but tiny): `{ channel_id TEXT, wordle_day INT, sent_at TIMESTAMPTZ, PRIMARY KEY(channel_id, wordle_day) }` to ensure we don’t send duplicate podiums/digests.
   - Optional future tables (e.g., ingestion audits) if needed.
3. **Data access helpers** – Port `ResultCollection`, `Leaderboard`, and stats math into reusable services that operate on DB queries rather than in-memory arrays. Use Drizzle schema definitions to generate type-safe queries and migrations (`drizzle-kit push` during deployment). For Render, run migrations via `render-build.sh` or a one-off job invoking `drizzle-kit migrate`.

### Wordle parsing & submission handling
1. **Parser module** – Copy/adapt `WordleResult.ts` into `src/features/wordle/parser.ts`, keeping the regex, duplicate protection, and hard-mode detection.
2. **onMessage handler** – In `bot.onMessage`:
   - Ignore slash commands (Towns already separates) and non-Wordle messages quickly.
   - When a result is parsed, normalize player metadata (display name, avatar) from the event/snapshot and store it alongside the submission record or in memory for the response.
   - Validate duplicate submissions by `chat_id + player_id + wordle_day`.
   - Persist the submission and trigger any downstream notifications (leaderboard, timing, early podium). Leaderboards are computed on demand from `submissions`, so no cache writes are needed.
3. **Validation** – Accept submissions whose `wordle_day` is within ±1 of the current puzzle number (computed via `utils.getWordleDay` so we can warn about obviously stale data), but treat the parsed `wordle_day` as authoritative for storage.

### Leaderboards, stats & notifications
1. **Stats service** – Translate `statistics.ts` into pure functions that accept arrays fetched from DB. Consider precomputing:
   - Overall podium winners per day
   - Rolling weekly window (use `wordle_day` instead of timestamps)
   - Average solve time per player (`AVG(submissions.solved_at)`, `STDDEV`)
2. **Notifications**
   - **Timing nudges** – After save, compare `solved_at` vs stored `avg_time`/`std_dev` for the player; send `handler.sendMessage` DM or channel reply when outside thresholds and `notify_timing` is true.
   - **Leaderboard overtakes** – Compare rankings produced from fresh queries before/after the submission; if the sender moved ahead of someone, send targeted replies mentioning affected players.

### Early podium & daily digests
1. **Threshold check via queries** – For each submission, count distinct players for `(channel_id, wordle_day)` directly from `submissions`. If the count meets `early_podium_threshold`, attempt to insert into `daily_digest_log`. If the insert succeeds (i.e., we haven’t sent yet), generate and send the podium immediately.
2. **Scheduled digest** – Use `setInterval`/`cron` within the bot process to:
   - Run `publishDailyStats` at each chat’s configured local time (default 19:00). Query `submissions` for that `wordle_day`, send podium + textual recap (scores + weekly snapshot).
   - On Saturdays, send weekly recaps. No tracker reset needed—weekly numbers come from the rolling query over `submissions`.
   - Ensure timers survive restarts by storing next-run timestamps per channel or recomputing them on boot from settings.

### Podium image generation
1. **Asset pipeline** – Reuse `sharp` or adopt `@napi-rs/canvas` to build podium art inside `src/features/wordle/podium.ts`.
2. **Avatar sources** – Towns exposes member avatars via snapshot or mention data; fetch URLs with `handler.getProfile` equivalent (or fall back to default silhouettes).
3. **Sending media** – Use `handler.sendMessage(channelId, text, { attachments: [{ type: 'chunked', data: buffer, filename: 'wordle-podium.png', mimetype: 'image/png' }] })`.

### Slash commands & configuration UX
Map WhatsApp commands to Towns slash commands (update `src/commands.ts` accordingly):
1. `/scores` – Reply with overall leaderboard (award emojis, mentions).
2. `/averages`
3. `/weekly`
4. `/podium [day?]`
5. `/config set <option> <value>` – Validate and persist chat settings.
6. `/config show` – Dump current settings.
7. `/today` `/ping` `/help` for parity.
Use ephemeral responses for admin/config commands where appropriate.

### Observability & safeguards
- Log every handler outcome with chat/user IDs and wordle_day; store metrics for duplicates, invalid grids, and scheduler issues.
- Gracefully handle missing configs by falling back to defaults stored in code or `config.default`.
- Because Towns bots may be restarted often, ensure timers bootstrap from DB state each time (`last_digest_at`, `digest_sent` flags, etc.).

### Implementation phases
1. **Foundation (in progress)**
   - ✅ Drizzle + PostgreSQL scaffolding committed (config, schema, helper). Migrations will run after provisioning Render Postgres.
   - ☐ Port Wordle parser + stats math into `src/features`.
2. **Core flows**
   - Implement `onMessage` Wordle ingestion plus `/scores|averages|weekly|podium` commands.
   - Add `/help`, `/ping`, `/today` parity.
3. **Config & notifications**
   - Build `/config` commands, store per-chat preferences, wire timing + leaderboard-notification logic.
4. **Podium media & scheduled digests**
   - Implement image generation + attachments; add daily/weekly scheduler that reads chat settings and posts recaps.
5. **Advanced features**
   - TBD (future growth ideas once core experience is stable).
6. **QA & deployment**
   - Add unit tests for parsing/stat math, integration tests for DB queries, dry-run scheduler locally, document deployment + monitoring steps in README.

This plan captures the Wordle bot’s existing behavior set and outlines how to reproduce it within the Jontras Towns bot while honoring the stateless webhook model and Towns-specific APIs.
