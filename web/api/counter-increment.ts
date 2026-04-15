import { getSupabaseServerClient } from './_supabase'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase.rpc('increment_global_counter')

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ value: data })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return res.status(500).json({ error: message })
  }
}

