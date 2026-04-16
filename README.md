# Exponent

Multiplayer number-guessing game: **Google sign-in**, **host or join** rooms with a **6-letter code**, configurable **rounds** (3–15) and **timer modes**, **real-time** sync via **Supabase Realtime**, and a **question bank** in Postgres.

## Local dev

```bash
cd web
npm install
npm run dev
```

## Database (required)

1. Create a Supabase project.

2. In **SQL Editor**, run these migrations in order:

   - [`supabase/migrations/20260416120000_game.sql`](supabase/migrations/20260416120000_game.sql)
   - [`supabase/migrations/20260416180000_room_tick_phase_and_helpers.sql`](supabase/migrations/20260416180000_room_tick_phase_and_helpers.sql)
   - [`supabase/migrations/20260416200000_early_reveal_scoring.sql`](supabase/migrations/20260416200000_early_reveal_scoring.sql)
   - [`supabase/migrations/20260416210000_topics.sql`](supabase/migrations/20260416210000_topics.sql)
   - [`supabase/migrations/20260416211000_topics_rpcs.sql`](supabase/migrations/20260416211000_topics_rpcs.sql)
   - [`supabase/migrations/20260416220000_round_length_and_reveal_15s.sql`](supabase/migrations/20260416220000_round_length_and_reveal_15s.sql)
   - [`supabase/migrations/20260416224000_sample_topic_and_reveal_30s.sql`](supabase/migrations/20260416224000_sample_topic_and_reveal_30s.sql)

   If you deployed an **older** version of this file before those fixes, re-run **only** the block at the bottom of the current file from `-- RLS: RPCs run as invoker` through the last `alter function ... set row_security to off;`, or run the whole file again (use `create or replace` / `drop policy if exists` where applicable).

   It creates tables (`questions`, `rooms`, `room_players`, `round_guesses`, `round_scores`, …), **RLS**, **RPCs** (`create_room`, `join_room`, `start_game`, `room_tick`, …), seeds sample **questions**, and attaches tables to the **`supabase_realtime`** publication.

   If `ALTER PUBLICATION` errors because a table is already in the publication, remove those lines or ignore the error for that table.

3. **Auth**: Enable the **Google** provider and configure **Site URL** + **Redirect URLs** (see below).

## Environment variables

Create `web/.env.local`:

```bash
VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
VITE_SUPABASE_ANON_KEY="<anon key>"
```

For production (e.g. Vercel), set the same `VITE_*` variables and redeploy.

If you want **Custom AI topics**, also set:

```bash
GEMINI_API_KEY="<your gemini api key>"
```

See [`web/.env.example`](web/.env.example).

The app talks to Supabase **directly** from the browser (authenticated user JWT). You do **not** need a service role key in the frontend.

## Google sign-in

1. **Google Cloud**: OAuth **Web client**; **Authorized redirect URI** must include  
   `https://<project-ref>.supabase.co/auth/v1/callback`  
   **JavaScript origins**: your app URLs (`http://localhost:5173`, production URL).

2. **Supabase → Authentication → Providers → Google**: paste client ID and secret.

3. **Supabase → Authentication → URL configuration**: **Site URL** = production app URL; **Redirect URLs** include localhost and production (and previews if needed).

## Vercel

- **Root Directory**: `web`
- **Build**: `npm run build`
- **Output**: `dist`
- **Node**: Use **20.x** or newer (see `web/.nvmrc` and `engines` in `web/package.json`). `react-router-dom` v7 requires Node ≥ 20.
- Commit **`web/package.json`** and **`web/package-lock.json`** together after `npm install` so Vercel installs `react-router-dom`. If the build says it cannot find `react-router-dom`, your deployed branch is missing those files or an outdated lockfile.

Optional: [`web/api/health.ts`](web/api/health.ts) remains as a simple Vercel health check (no Supabase).

## How to play

1. Sign in with Google.
2. Set a **nickname**, then **Host room** or **Join** with a 6-letter code.
3. Host configures **topic** (preset/random/custom AI), **timer mode** and **rounds**, then **Start game**.
4. Each round: read the **question**, enter a **numeric guess** before time runs out.
5. **Results** show the correct answer, guesses, and **score** (lower is better: exact answer = 0; no guess = 1). Everyone taps **I'm ready** (or wait **10s**) to continue.
6. After the last round, see **Final standings** (lowest total score wins). Host taps **Back to lobby** to reset the room for another game.

## AI topic generation format

The serverless endpoint [`web/api/generate-topic.ts`](web/api/generate-topic.ts) asks Gemini to return JSON shaped like:

```json
{
  "topicName": "Astronomy",
  "shortDescription": "Distances and magnitudes",
  "questions": [
    { "prompt": "How many kilometers are in 1 AU (approx)?", "answer": 149600000 }
  ]
}
```

## Adding questions

Insert rows into `public.questions` (SQL Editor or dashboard) with `prompt` and `answer`. Answers are not exposed to clients during the guessing phase (RLS + `get_question_prompt` RPC).
