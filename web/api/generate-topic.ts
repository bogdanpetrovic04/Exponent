import { createClient } from '@supabase/supabase-js'

type Req = { method?: string; headers?: Record<string, string | string[] | undefined>; body?: unknown }
type Res = {
  status: (code: number) => { json: (body: Record<string, unknown>) => void }
}
type JsonRecord = Record<string, unknown>

function json(res: Res, code: number, body: Record<string, unknown>) {
  res.status(code).json(body)
}

function asRecord(v: unknown): JsonRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as JsonRecord
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

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('No JSON object found in model output')
  return JSON.parse(text.slice(start, end + 1))
}

function extractGeminiText(raw: unknown): string {
  const root = asRecord(raw)
  const candidates = root?.candidates
  if (!Array.isArray(candidates) || candidates.length < 1) return ''
  const c0 = asRecord(candidates[0])
  const content = asRecord(c0?.content)
  const parts = content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p) => {
      const pr = asRecord(p)
      return typeof pr?.text === 'string' ? pr.text : ''
    })
    .filter(Boolean)
    .join('')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' })

  const token = parseBearer(req)
  if (!token) return json(res, 401, { ok: false, error: 'missing_bearer_token' })

  const supabaseUrl =
    (process.env.SUPABASE_URL as string | undefined) ??
    (process.env.VITE_SUPABASE_URL as string | undefined)
  const supabaseAnon =
    (process.env.SUPABASE_ANON_KEY as string | undefined) ??
    (process.env.VITE_SUPABASE_ANON_KEY as string | undefined)
  if (!supabaseUrl || !supabaseAnon) {
    return json(res, 500, { ok: false, error: 'missing_supabase_env' })
  }

  const geminiKey = process.env.GEMINI_API_KEY as string | undefined
  if (!geminiKey) return json(res, 500, { ok: false, error: 'missing_gemini_api_key' })

  const sb = createClient(supabaseUrl, supabaseAnon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data: u, error: uErr } = await sb.auth.getUser()
  if (uErr || !u?.user) return json(res, 401, { ok: false, error: 'invalid_token' })

  const body = (req.body ?? {}) as Record<string, unknown>
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description || description.length > 500) {
    return json(res, 400, { ok: false, error: 'invalid_description' })
  }

  // Gemini: strict JSON output
  const prompt = [
    'Generate a brand new topic and 20 numeric Q/A trivia questions.',
    'Return ONLY valid JSON matching this exact schema (no markdown, no extra keys):',
    '{ "topicName": string, "shortDescription": string, "questions": [ { "prompt": string, "answer": number } ] }',
    'Constraints:',
    '- topicName: 1-64 chars, shortDescription: 1-96 chars.',
    '- questions length: exactly 20.',
    '- prompt: 1-240 chars, answer must be a number (no units).',
    '- Prompts should be diverse and unambiguous.',
    '',
    `User topic request: ${description}`,
  ].join('\n')

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=` +
    encodeURIComponent(geminiKey)

  let modelText = ''
  try {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6 },
    })

    const callGemini = async (): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string | null }> => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
      const raw: unknown = await r.json().catch(() => null)
      if (!r.ok) {
        const err = asRecord(raw)?.error
        const msg = typeof asRecord(err)?.message === 'string' ? asRecord(err)?.message : null
        return { ok: false, status: r.status, message: msg }
      }
      const text = extractGeminiText(raw)
      return { ok: true, text }
    }

    let out = await callGemini()
    if (!out.ok && out.status === 429) {
      // Best-effort backoff; Vercel functions can see occasional bursts / shared quota.
      await sleep(1500)
      out = await callGemini()
    }

    if (!out.ok) {
      return json(res, out.status === 429 ? 429 : 502, {
        ok: false,
        error: out.status === 429 ? 'gemini_rate_limited' : 'gemini_error',
        details: out.message,
      })
    }

    modelText = out.text
    if (!modelText) throw new Error('Empty model output')
  } catch (e) {
    return json(res, 502, { ok: false, error: 'gemini_request_failed', details: e instanceof Error ? e.message : null })
  }

  let parsed: unknown
  try {
    parsed = extractJsonObject(modelText)
  } catch (e) {
    return json(res, 422, { ok: false, error: 'invalid_model_json', details: e instanceof Error ? e.message : null })
  }

  const p = asRecord(parsed)
  const topicName = typeof p?.topicName === 'string' ? p.topicName.trim() : ''
  const shortDescription = typeof p?.shortDescription === 'string' ? p.shortDescription.trim() : ''
  const questions = Array.isArray(p?.questions) ? p.questions : null

  if (!topicName || topicName.length > 64) return json(res, 422, { ok: false, error: 'invalid_topic_name' })
  if (!shortDescription || shortDescription.length > 96) return json(res, 422, { ok: false, error: 'invalid_short_description' })
  if (!questions || questions.length !== 20) return json(res, 422, { ok: false, error: 'invalid_questions' })

  const cleaned: { prompt: string; answer: number }[] = []
  for (const q of questions) {
    const qr = asRecord(q)
    const pr = typeof qr?.prompt === 'string' ? qr.prompt.trim() : ''
    const ans = typeof qr?.answer === 'number' ? qr.answer : Number(qr?.answer)
    if (!pr || pr.length > 240) return json(res, 422, { ok: false, error: 'invalid_prompt' })
    if (!Number.isFinite(ans)) return json(res, 422, { ok: false, error: 'invalid_answer' })
    cleaned.push({ prompt: pr, answer: ans })
  }

  const { data: topicId, error: insErr } = await sb.rpc('create_topic_with_questions', {
    p_name: topicName,
    p_short_description: shortDescription,
    p_questions: cleaned,
  })
  if (insErr || typeof topicId !== 'string') {
    return json(res, 500, { ok: false, error: 'db_insert_failed', details: insErr?.message ?? null })
  }

  return json(res, 200, {
    ok: true,
    topicId,
    displayName: `${topicName} - ${shortDescription}`,
  })
}

