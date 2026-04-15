type Req = { method?: string; url?: string }
type Res = { status: (code: number) => { json: (body: Record<string, unknown>) => void } }

export default function handler(req: Req, res: Res) {
  res.status(200).json({
    ok: true,
    service: 'web',
    now: new Date().toISOString(),
    method: req?.method ?? null,
    url: req?.url ?? null,
  })
}

