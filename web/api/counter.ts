import { getSupabaseServerClient } from './_supabase'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader?.('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const supabase = getSupabaseServerClient()
    const { data, error } = await supabase
      .from('global_counter')
      .select('value')
      .eq('id', 'main')
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ value: data.value })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return res.status(500).json({ error: message })
  }
}

