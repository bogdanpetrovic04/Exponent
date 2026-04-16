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

function clampQuery(s: string): string {
  return s.trim().slice(0, 180)
}

type ImgCand = { url: string; width: number; height: number; sourceUrl: string; provider: 'wikimedia' | 'openverse' }

function pickBest(
  candidates: ImgCand[],
  minWidth: number,
  minRatio: number,
  maxRatio: number,
): ImgCand | null {
  const ok = candidates.filter((c) => {
    if (!c.url || !c.sourceUrl) return false
    if (!Number.isFinite(c.width) || !Number.isFinite(c.height)) return false
    if (c.width < minWidth) return false
    const ratio = c.width / Math.max(1, c.height)
    if (ratio < minRatio || ratio > maxRatio) return false
    return true
  })
  ok.sort((a, b) => b.width * b.height - a.width * a.height)
  return ok[0] ?? null
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

async function wikipediaSummaryImage(title: string): Promise<ImgCand | null> {
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

async function openverseCollect(query: string): Promise<ImgCand[]> {
  const u = new URL('https://api.openverse.engineering/v1/images')
  u.searchParams.set('q', query)
  u.searchParams.set('page_size', '20')
  u.searchParams.set('mature', 'false')

  const r = await fetch(u.toString(), { headers: { accept: 'application/json' } })
  if (!r.ok) return []
  const raw: unknown = await r.json().catch(() => null)
  const root = asRecord(raw)
  const results = root?.results
  if (!Array.isArray(results)) return []

  const out: ImgCand[] = []
  for (const item of results) {
    const it = asRecord(item)
    const imgUrl = typeof it?.url === 'string' ? it.url : null
    const landing = typeof it?.foreign_landing_url === 'string' ? it.foreign_landing_url : null
    if (!imgUrl || !landing) continue
    let w = typeof it?.width === 'number' ? it.width : 0
    let h = typeof it?.height === 'number' ? it.height : 0
    if (!w || !h) {
      w = 1200
      h = 900
    }
    out.push({ url: imgUrl, width: w, height: h, sourceUrl: landing, provider: 'openverse' })
  }
  return out
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

  let imageQueryFromDb: string | null = null
  let imageQueryStockFromDb: string | null = null

  const { data: cached, error: cErr } = await sb.rpc('get_question_image', { p_question_id: questionId })
  if (!cErr && Array.isArray(cached) && cached[0] && typeof cached[0] === 'object') {
    const row = cached[0] as Record<string, unknown>
    const imageUrl = typeof row.image_url === 'string' ? row.image_url : null
    const sourceUrl = typeof row.image_source_url === 'string' ? row.image_source_url : null
    const provider = typeof row.image_provider === 'string' ? row.image_provider : null
    imageQueryFromDb = typeof row.image_query === 'string' ? row.image_query : null
    imageQueryStockFromDb = typeof row.image_query_stock === 'string' ? row.image_query_stock : null
    if (imageUrl && sourceUrl && provider) {
      return json(res, 200, { ok: true, imageUrl, sourceUrl, provider, cached: true })
    }
  }

  const factualQ = clampQuery(imageQueryFromDb ?? prompt)
  const stockQ = clampQuery(imageQueryStockFromDb ?? imageQueryFromDb ?? prompt)
  if (!factualQ && !stockQ) return json(res, 200, { ok: true, imageUrl: null })

  // Tier 1: Wikipedia / Wikimedia (factual query)
  const wiki: ImgCand[] = []
  if (factualQ) {
    try {
      const title = await wikipediaSearchTitle(factualQ)
      if (title) {
        const img = await wikipediaSummaryImage(title)
        if (img) wiki.push(img)
      }
    } catch {
      // ignore
    }
  }
  const wikiBest = pickBest(wiki, 900, 0.7, 2.2)
  if (wikiBest) {
    await sb.rpc('set_question_image', {
      p_question_id: questionId,
      p_image_url: wikiBest.url,
      p_image_source_url: wikiBest.sourceUrl,
      p_image_provider: wikiBest.provider,
    })
    return json(res, 200, {
      ok: true,
      imageUrl: wikiBest.url,
      sourceUrl: wikiBest.sourceUrl,
      provider: wikiBest.provider,
      cached: false,
    })
  }

  // Tier 2: Openverse (simple / stock query; relaxed size gates)
  let stock: ImgCand[] = []
  if (stockQ) {
    try {
      stock = await openverseCollect(stockQ)
    } catch {
      stock = []
    }
  }
  const stockBest = pickBest(stock, 640, 0.55, 2.45)
  if (stockBest) {
    await sb.rpc('set_question_image', {
      p_question_id: questionId,
      p_image_url: stockBest.url,
      p_image_source_url: stockBest.sourceUrl,
      p_image_provider: stockBest.provider,
    })
    return json(res, 200, {
      ok: true,
      imageUrl: stockBest.url,
      sourceUrl: stockBest.sourceUrl,
      provider: stockBest.provider,
      cached: false,
    })
  }

  return json(res, 200, { ok: true, imageUrl: null })
}
