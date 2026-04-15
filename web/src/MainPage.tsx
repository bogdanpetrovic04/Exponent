import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

export default function MainPage() {
  const [count, setCount] = useState<number | null>(null)
  const [counterError, setCounterError] = useState<string | null>(null)
  const [counterBusy, setCounterBusy] = useState(false)
  const [realtimeStatus, setRealtimeStatus] = useState<
    'disabled' | 'connecting' | 'connected' | 'error'
  >('disabled')
  const [health, setHealth] = useState<unknown>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const buildTime = useMemo(() => new Date().toISOString(), [])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    async function loadCounter() {
      try {
        const res = await fetch('/api/counter', {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { value: number }
        if (cancelled) return
        setCount(json.value)
      } catch (err) {
        if (cancelled) return
        setCounterError(err instanceof Error ? err.message : 'Unknown error')
      }
    }

    async function run() {
      try {
        const res = await fetch('/api/health', {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as unknown
        if (cancelled) return
        setHealth(json)
      } catch (err) {
        if (cancelled) return
        setHealthError(err instanceof Error ? err.message : 'Unknown error')
      }
    }

    loadCounter()
    run()

    if (!supabase) {
      setRealtimeStatus('disabled')
    } else {
      const sb = supabase
      setRealtimeStatus('connecting')
      const channel = sb
        .channel('global-counter')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'global_counter',
            filter: 'id=eq.main',
          },
          (payload) => {
            const next =
              (payload as { new?: { value?: number }; record?: { value?: number } })
                ?.new?.value ??
              (payload as { record?: { value?: number } })?.record?.value ??
              null
            if (typeof next === 'number') setCount(next)
          },
        )
        .subscribe((status) => {
          if (cancelled) return
          if (status === 'SUBSCRIBED') setRealtimeStatus('connected')
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
            setRealtimeStatus('error')
        })

      unsubscribe = () => {
        sb.removeChannel(channel)
      }
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  async function incrementSharedCounter() {
    setCounterError(null)
    setCounterBusy(true)
    try {
      const res = await fetch('/api/counter-increment', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { value: number }
      setCount(json.value)
    } catch (err) {
      setCounterError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setCounterBusy(false)
    }
  }

  async function signOut() {
    if (!supabase) return
    await supabase.auth.signOut()
  }

  return (
    <>
      <section id="center">
        <div style={{ width: '100%', maxWidth: 720, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="counter" onClick={signOut}>
            Sign out
          </button>
        </div>

        <div>
          <h1>Exponent</h1>
          <p>Guess the closest number to the target.</p>
          <ul style={{ textAlign: 'left', margin: '16px auto', maxWidth: 720 }}>
            <li>
              <strong>Build time</strong>: <code>{buildTime}</code>
            </li>
            <li>
              <strong>Mode</strong>: <code>{import.meta.env.MODE}</code>
            </li>
          </ul>
        </div>

        <button
          className="counter"
          onClick={incrementSharedCounter}
          aria-label="Increment shared counter"
          disabled={counterBusy}
        >
          {counterBusy ? 'Updating…' : `Shared count is ${count ?? '…'}`}
        </button>

        <div style={{ width: '100%', maxWidth: 720, textAlign: 'left' }}>
          <h2 style={{ marginTop: 28, marginBottom: 12 }}>Supabase counter</h2>
          {counterError ? (
            <p style={{ color: '#ff6b6b' }}>
              Failed to use Supabase counter: <code>{counterError}</code>
            </p>
          ) : (
            <p style={{ color: 'var(--text)' }}>
              This value is stored in Supabase and shared across all users.
            </p>
          )}
          <p style={{ color: 'var(--text)', marginTop: 8 }}>
            Realtime:{' '}
            <code>
              {realtimeStatus === 'disabled'
                ? 'disabled (set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)'
                : realtimeStatus}
            </code>
          </p>
        </div>

        <div style={{ width: '100%', maxWidth: 720, textAlign: 'left' }}>
          <h2 style={{ marginTop: 28, marginBottom: 12 }}>
            Serverless function check
          </h2>
          {healthError ? (
            <p style={{ color: '#ff6b6b' }}>
              Failed to fetch <code>/api/health</code>: <code>{healthError}</code>
            </p>
          ) : (
            <pre
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 12,
                padding: 16,
                overflowX: 'auto',
              }}
            >
              {health ? JSON.stringify(health, null, 2) : 'Loading...'}
            </pre>
          )}
        </div>
      </section>
    </>
  )
}
