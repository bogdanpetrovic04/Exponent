export default function handler(req: any, res: any) {
  res.status(200).json({
    ok: true,
    service: 'web',
    now: new Date().toISOString(),
    method: req?.method ?? null,
    url: req?.url ?? null,
  })
}

