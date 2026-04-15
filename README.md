# Exponent

Sample React web app for testing Vercel deployments, plus a Supabase-backed shared counter.

## Local dev

```bash
cd web
npm install
npm run dev
```

Open the dev server URL and confirm the page renders.

## Supabase setup (shared counter)

This demo stores a single shared counter in Supabase and increments it atomically on each click.

### 1) Create a Supabase project

- Go to the Supabase dashboard, create a new project, and wait for it to finish provisioning.

### 2) Create DB table + seed row

In Supabase Dashboard → SQL Editor, run:

```sql
create table if not exists global_counter (
  id text primary key,
  value integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into global_counter (id, value)
values ('main', 0)
on conflict (id) do nothing;
```

### 3) Create atomic increment function (RPC)

In SQL Editor, run:

```sql
create or replace function increment_global_counter()
returns integer
language plpgsql
as $$
declare new_value integer;
begin
  update global_counter
  set value = value + 1,
      updated_at = now()
  where id = 'main'
  returning value into new_value;

  return new_value;
end;
$$;
```

### 4) Set env vars (local)

Create `web/.env.local` with:

```bash
SUPABASE_URL="YOUR_SUPABASE_PROJECT_URL"
SUPABASE_SERVICE_ROLE_KEY="YOUR_SUPABASE_SERVICE_ROLE_KEY"
VITE_SUPABASE_URL="YOUR_SUPABASE_PROJECT_URL"
VITE_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"
```

You can find these in Supabase Dashboard → Project Settings → API.
**Do not expose the service role key in the browser.** This project uses it only in serverless API routes under `web/api/`.

### 5) Google sign-in (required to open the app)

The main UI is behind **Supabase Auth** with the **Google** provider. The browser client uses `persistSession` and `detectSessionInUrl` so the OAuth redirect back to your app restores the session.

#### Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized JavaScript origins**: add your app origins, e.g. `http://localhost:5173` and `https://your-deployment.vercel.app`.
4. **Authorized redirect URIs**: add Supabase’s callback (not your app URL):

   `https://<your-project-ref>.supabase.co/auth/v1/callback`

   Use your real project ref from Supabase **Project Settings → General → Project ID** (the URL is `https://<project-ref>.supabase.co`).

5. Copy the **Client ID** and **Client secret**.

#### Supabase Dashboard

1. **Authentication → Providers → Google**: enable, paste **Client ID** and **Client Secret** from Google.
2. **Authentication → URL configuration**:
   - **Site URL**: your production app URL, e.g. `https://your-deployment.vercel.app`
   - **Redirect URLs**: add `http://localhost:5173`, your production URL, and any Vercel preview URLs you use.

Redeploy after changing environment variables.

### 6) Enable Realtime + read access for clients (for live updates)

To update all devices instantly, the browser subscribes to changes on `global_counter` using the **anon** key.

1) In Supabase Dashboard → **Realtime**, enable realtime for the `global_counter` table (and ensure the table is included in replication/publication).

2) In Supabase Dashboard → **Table Editor** → `global_counter`, enable **RLS** (Row Level Security), then add this policy so clients can read the one row:

```sql
alter table public.global_counter enable row level security;

create policy "public read global counter"
on public.global_counter
for select
to anon
using (id = 'main');
```

The serverless API still performs the increment using the service role key.

## Vercel deploy (recommended)

In the Vercel “New Project” flow:

- **Root Directory**: `web`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

### Vercel environment variables

In Vercel Project → Settings → Environment Variables, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Then redeploy.

After deploy, visit your site and confirm:

- You are prompted to **Sign in with Google**, then you reach the main page
- The page successfully fetches `GET /api/health` and prints JSON
- The page shows a “Shared count” that increments and persists across refreshes/devices
