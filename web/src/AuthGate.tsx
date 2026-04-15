import type { Session } from '@supabase/supabase-js'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

type Props = {
  children: ReactNode
}

export default function AuthGate({ children }: Props) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [authError, setAuthError] = useState<string | null>(null)
  const [signInBusy, setSignInBusy] = useState(false)

  useEffect(() => {
    if (!supabase) {
      setSession(null)
      return
    }

    let cancelled = false

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!cancelled) setSession(s ?? null)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  async function signInWithGoogle() {
    if (!supabase) return
    setAuthError(null)
    setSignInBusy(true)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/`,
        },
      })
      if (error) setAuthError(error.message)
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : 'Sign-in failed')
    } finally {
      setSignInBusy(false)
    }
  }

  if (session === undefined) {
    return (
      <section id="center" style={{ minHeight: '60svh' }}>
        <p style={{ color: 'var(--text)' }}>Checking session…</p>
      </section>
    )
  }

  if (!supabase) {
    return (
      <section id="center" style={{ minHeight: '60svh' }}>
        <p style={{ color: '#ff6b6b' }}>
          Missing <code>VITE_SUPABASE_URL</code> or <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
      </section>
    )
  }

  if (!session) {
    return (
      <section id="center" style={{ minHeight: '60svh', gap: 20 }}>
        <div>
          <h1>Exponent</h1>
          <p style={{ marginTop: 12, color: 'var(--text)' }}>
            Sign in with Google to continue.
          </p>
        </div>
        {authError ? (
          <p style={{ color: '#ff6b6b' }}>
            <code>{authError}</code>
          </p>
        ) : null}
        <button
          type="button"
          className="counter"
          onClick={signInWithGoogle}
          disabled={signInBusy}
          aria-label="Sign in with Google"
        >
          {signInBusy ? 'Redirecting…' : 'Sign in with Google'}
        </button>
      </section>
    )
  }

  return <>{children}</>
}
