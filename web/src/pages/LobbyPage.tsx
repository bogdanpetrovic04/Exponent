import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import './game.css'

function mapJoinError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('room_not_found') || m.includes('invalid_code')) {
    return 'No room matches that code, or it is no longer available.'
  }
  if (m.includes('you_were_removed')) {
    return 'You were removed from this room.'
  }
  if (m.includes('expired')) {
    return 'This room has expired.'
  }
  return message
}

export default function LobbyPage() {
  const navigate = useNavigate()
  const [nickname, setNickname] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      const n =
        (user.user_metadata?.full_name as string | undefined) ||
        user.email?.split('@')[0] ||
        'Player'
      setNickname(n)
    })
  }, [])

  async function handleHost() {
    if (!supabase) return
    setBusy(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.rpc('create_room', {
        p_nickname: nickname.trim() || 'Player',
        p_time_mode: 'total_30',
        p_rounds: 5,
      })
      if (err) {
        const msg = [err.message, 'details' in err ? String((err as { details?: string }).details) : '']
          .filter(Boolean)
          .join(' — ')
        throw new Error(msg || err.message)
      }
      const raw = data as unknown
      const row = Array.isArray(raw) ? raw[0] : raw
      const rid =
        row && typeof row === 'object' && 'res_room_id' in row
          ? String((row as { res_room_id: string }).res_room_id)
          : undefined
      if (!rid) throw new Error('No room id returned from create_room')
      navigate(`/room/${rid}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create room')
    } finally {
      setBusy(false)
    }
  }

  async function handleJoin() {
    if (!supabase) return
    setBusy(true)
    setError(null)
    const code = joinCode.trim().toUpperCase()
    if (code.length !== 6) {
      setError('Enter a 6-letter room code.')
      setBusy(false)
      return
    }
    try {
      const { data, error: err } = await supabase.rpc('join_room', {
        p_code: code,
        p_nickname: nickname.trim() || 'Player',
      })
      if (err) throw err
      const rid =
        typeof data === 'string'
          ? data
          : data && typeof data === 'object' && 'res_room_id' in (data as object)
            ? String((data as { res_room_id: string }).res_room_id)
            : Array.isArray(data) && data[0] && typeof data[0] === 'object' && 'res_room_id' in (data[0] as object)
              ? String((data[0] as { res_room_id: string }).res_room_id)
              : undefined
      if (!rid) throw new Error('No room id returned from join_room')
      navigate(`/room/${rid}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not join'
      setError(mapJoinError(msg))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="game-layout" id="center">
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <h1>Exponent</h1>
        <p style={{ color: 'var(--text)', marginTop: 8 }}>
          Guess the number closest to the answer. Play together in real time.
        </p>
      </div>

      <div className="game-card">
        <label style={{ display: 'block', marginBottom: 8, color: 'var(--text-h)' }}>
          Nickname
        </label>
        <input
          className="game-input"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="Your name"
          maxLength={32}
        />
      </div>

      <div className="game-card">
        <h2 style={{ margin: '0 0 16px', fontSize: '20px' }}>Host a room</h2>
        <button
          type="button"
          className="counter"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}
          onClick={handleHost}
        >
          {busy ? '…' : 'Host room'}
        </button>
      </div>

      <div className="game-card">
        <h2 style={{ margin: '0 0 12px', fontSize: '20px' }}>Join a room</h2>
        <input
          className="game-input"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6))}
          placeholder="ABCDEF"
          maxLength={6}
          style={{ marginBottom: 12, letterSpacing: '0.15em', textTransform: 'uppercase' }}
        />
        <button
          type="button"
          className="counter"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={busy}
          onClick={handleJoin}
        >
          {busy ? '…' : 'Play'}
        </button>
      </div>

      {error ? (
        <p style={{ color: '#f87171', textAlign: 'center' }} role="alert">
          {error}
        </p>
      ) : null}

      <p style={{ textAlign: 'center', marginTop: 24 }}>
        <a href="/" style={{ color: 'var(--text)' }}>
          Refresh
        </a>
      </p>
    </section>
  )
}
