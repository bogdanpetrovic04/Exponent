# Exponent

Sample React web app for testing Vercel deployments.

## Local dev

```bash
cd web
npm install
npm run dev
```

Open the dev server URL and confirm the page renders.

## Vercel deploy (recommended)

In the Vercel “New Project” flow:

- **Root Directory**: `web`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

After deploy, visit your site and confirm:

- The page shows “Vercel Deployment Test”
- The page successfully fetches `GET /api/health` and prints JSON
