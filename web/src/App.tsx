import { useEffect, useMemo, useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState<number | null>(null)
  const [counterError, setCounterError] = useState<string | null>(null)
  const [counterBusy, setCounterBusy] = useState(false)
  const [health, setHealth] = useState<unknown>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const buildTime = useMemo(() => new Date().toISOString(), [])

  useEffect(() => {
    let cancelled = false

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
    return () => {
      cancelled = true
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

  return (
    <>
      <section id="center">
        <div>
          <h1>Exponent</h1>
          <p>
            Guess the closest number to the target.
          </p>
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

export default App
