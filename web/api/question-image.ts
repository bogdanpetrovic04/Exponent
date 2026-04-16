import { createClient } from '@supabase/supabase-js'

type Req = { method?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown }
type Res = { status: (code: number) => { json: (body: Record<string, unknown>) => void } }

declare const process: {
  env: Record<string, string | undefined>
}

function json(res: Res, code: number, body: Record<string, unknown>) {
  res.status(code).json(body)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function getHeader(req: Req, name: string): string | null {
  const h = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (!h) return null
  return Array.isArray(h) ? h[0] ?? null : h
}

function parseBearer(req: Req): string | null {
  const auth = getHeader(req, 'authorization')
  if (!auth) return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || null
}

function clampQuery(prompt: string): string {
  return prompt.trim().slice(0, 180)
}

function pickBestImage(
  candidates: { url: string; width: number; height: number; sourceUrl: string; provider: 'wikimedia' | 'openverse' }[],
): { url: string; sourceUrl: string; provider: 'wikimedia' | 'openverse' } | null {
  const ok = candidates.filter((c) => {
    if (!c.url || !c.sourceUrl) return false
    if (!Number.isFinite(c.width) || !Number.isFinite(c.height)) return false
    if (c.width < 900) return false
    const ratio = c.width / Math.max(1, c.height)
    if (ratio < 0.7 || ratio > 2.2) return false
    return true
  })
  ok.sort((a, b) => b.width * b.height - a.width * a.height)
  const best = ok[0]
  return best ? { url: best.url, sourceUrl: best.sourceUrl, provider: best.provider } : null
}

async function wikipediaSearchTitle(query: string): Promise<string | null> {
  const u = new URL('https://en.wikipedia.org/w/api.php')
  u.searchParams.set('action', 'query')
  u.searchParams.set('list', 'search')
  u.searchParams.set('srsearch', query)
  u.searchParams.set('srlimit', '1')
  u.searchParams.set('format', 'json')
  u.searchParams.set('origin', '*')

  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } })
  if (!r.ok) return null
  const raw: unknown = await r.json().catch(() => null)
  const root = asRecord(raw)
  const q = asRecord(root?.query)
  const s = q?.search
  if (!Array.isArray(s) || s.length < 1) return null
  const first = asRecord(s[0])
  const title = typeof first?.title === 'string' ? first.title : null
  return title?.trim() || null
}

async function wikipediaSummaryImage(title: string): Promise<
  { url: string; width: number; height: number; sourceUrl: string; provider: 'wikimedia' } | null
> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) return null
  const raw: unknown = await r.json().catch(() => null)
  const root = asRecord(raw)
  const contentUrls = asRecord(root?.content_urls)
  const desktop = asRecord(contentUrls?.desktop)
  const pageUrl = typeof desktop?.page === 'string' ? desktop.page : null

  const original = asRecord(root?.originalimage)
  const thumb = asRecord(root?.thumbnail)
  const img = original && typeof original.source === 'string' ? original : thumb
  if (!img) return null
  const imgUrl = typeof img.source === 'string' ? img.source : null
  const w = typeof img.width === 'number' ? img.width : 0
  const h = typeof img.height === 'number' ? img.height : 0
  if (!imgUrl || !pageUrl) return null
  return { url: imgUrl, width: w, height: h, sourceUrl: pageUrl, provider: 'wikimedia' }
}

async function openverseImage(query: string): Promise<
  { url: string; width: number; height: number; sourceUrl: string; provider: 'openverse' } | null
> {
  const u = new URL('https://api.openverse.engineering/v1/images')
  u.searchParams.set('q', query)
  u.searchParams.set('page_size', '10')
  u.searchParams.set('mature', 'false')

  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } })
  if (!r.ok) return null
  const raw: unknown = await r.json().catch(() => null)
  const root = asRecord(raw)
  const results = root?.results
  if (!Array.isArray(results) || results.length < 1) return null

  for (const item of results) {
    const it = asRecord(item)
    const imgUrl = typeof it?.url === 'string' ? it.url : null
    const landing = typeof it?.foreign_landing_url === 'string' ? it.foreign_landing_url : null
    const w = typeof it?.width === 'number' ? it.width : 0
    const h = typeof it?.height === 'number' ? it.height : 0
    if (imgUrl && landing) return { url: imgUrl, width: w, height: h, sourceUrl: landing, provider: 'openverse' }
  }
  return null
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' })

  const token = parseBearer(req)
  if (!token) return json(res, 401, { ok: false, error: 'missing_bearer_token' })

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const supabaseAnon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnon) return json(res, 500, { ok: false, error: 'missing_supabase_env' })

  const sb = createClient(supabaseUrl, supabaseAnon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: u, error: uErr } = await sb.auth.getUser()
  if (uErr || !u?.user) return json(res, 401, { ok: false, error: 'invalid_token' })

  const body = (req.body ?? {}) as Record<string, unknown>
  const questionId = typeof body.questionId === 'string' ? body.questionId : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (!questionId) return json(res, 400, { ok: false, error: 'missing_question_id' })

  // Cache check (SECURITY DEFINER RPC bypasses questions RLS)
  const { data: cached, error: cErr } = await sb.rpc('get_question_image', { p_question_id: questionId })
  let imageQueryFromDb: string | null = null
  if (!cErr && Array.isArray(cached) && cached[0] && typeof cached[0] === 'object') {
    const row = cached[0] as Record<string, unknown>
    const imageUrl = typeof row.image_url === 'string' ? row.image_url : null
    const sourceUrl = typeof row.image_source_url === 'string' ? row.image_source_url : null
    const provider = typeof row.image_provider === 'string' ? row.image_provider : null
    imageQueryFromDb = typeof row.image_query === 'string' ? row.image_query : null
    if (imageUrl && sourceUrl && provider) {
      return json(res, 200, { ok: true, imageUrl, sourceUrl, provider, cached: true })
    }
  }

  const q = clampQuery(imageQueryFromDb ?? prompt)
  if (!q) return json(res, 200, { ok: true, imageUrl: null })

  const candidates: { url: string; width: number; height: number; sourceUrl: string; provider: 'wikimedia' | 'openverse' }[] =
    []

  // Provider 1: Wikipedia/Wikimedia
  try {
    const title = await wikipediaSearchTitle(q)
    if (title) {
      const img = await wikipediaSummaryImage(title)
      if (img) candidates.push(img)
    }
  } catch {
    // ignore
  }

  // Provider 2: Openverse (free stock-like fallback)
  try {
    const ov = await openverseImage(q)
    if (ov) candidates.push(ov)
  } catch {
    // ignore
  }

  const best = pickBestImage(candidates)
  if (!best) return json(res, 200, { ok: true, imageUrl: null })

  await sb.rpc('set_question_image', {
    p_question_id: questionId,
    p_image_url: best.url,
    p_image_source_url: best.sourceUrl,
    p_image_provider: best.provider,
  })

  return json(res, 200, { ok: true, imageUrl: best.url, sourceUrl: best.sourceUrl, provider: best.provider, cached: false })
}

