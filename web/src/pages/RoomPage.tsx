import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useRoomState } from '../hooks/useRoomState'
import type { GameTimeMode, RoomPlayerRow, RoomRow, RoundGuessRow, RoundScoreRow } from '../types/game'
import './game.css'

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const { room, players, scores, guesses, loading, error } = useRoomState(roomId)
  const [userId, setUserId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [guessInput, setGuessInput] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!supabase || !room || room.phase !== 'question') {
      setPrompt(null)
      return
    }
    void supabase.rpc('get_question_prompt', { p_room_id: room.id }).then(({ data, error: err }) => {
      if (!err && typeof data === 'string') setPrompt(data)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refetch prompt when question identity changes
  }, [room?.id, room?.phase, room?.current_question_id])

  const isHost = userId && room && userId === room.host_id
  const me = players.find((p) => p.user_id === userId && !p.kicked_at)

  const questionSecondsLeft = useMemo(() => {
    if (!room?.question_deadline_at) return null
    return Math.max(
      0,
      Math.ceil((new Date(room.question_deadline_at).getTime() - now) / 1000),
    )
  }, [room?.question_deadline_at, now])

  const revealSecondsLeft = useMemo(() => {
    if (!room?.reveal_deadline_at) return null
    return Math.max(
      0,
      Math.ceil((new Date(room.reveal_deadline_at).getTime() - now) / 1000),
    )
  }, [room?.reveal_deadline_at, now])

  async function callRpc(name: string, args: Record<string, unknown>): Promise<boolean> {
    if (!supabase) return false
    setBusy(true)
    setActionError(null)
    try {
      const { error: err } = await supabase.rpc(name, args)
      if (err) throw err
      return true
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Request failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!roomId) {
    return (
      <section className="game-layout">
        <p>Invalid room.</p>
        <Link to="/">Home</Link>
      </section>
    )
  }

  if (loading) {
    return (
      <section className="game-layout" style={{ textAlign: 'center' }}>
        <p>Loading room…</p>
      </section>
    )
  }

  if (error || !room) {
    return (
      <section className="game-layout">
        <p style={{ color: '#f87171' }}>
          {error || 'Room not found, expired, or you no longer have access.'}
        </p>
        <Link to="/">Back to lobby</Link>
      </section>
    )
  }

  if (!me) {
    return (
      <section className="game-layout">
        <p>You are not in this room (you may have been removed).</p>
        <Link to="/">Back to lobby</Link>
      </section>
    )
  }

  return (
    <section className="game-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Link to="/" style={{ color: 'var(--text-h)' }}>
          ← Lobby
        </Link>
        {room.code ? (
          <span className="game-code" title="Room code">
            {room.code}
          </span>
        ) : (
          <span />
        )}
      </div>

      {actionError ? (
        <p style={{ color: '#f87171', marginBottom: 12 }} role="alert">
          {actionError}
        </p>
      ) : null}

      {room.phase === 'lobby' && (
        <LobbyPhase
          key={`${room.time_mode}-${room.rounds_total}-${room.updated_at}`}
          room={room}
          players={players}
          isHost={!!isHost}
          userId={userId!}
          busy={busy}
          onUpdateSettings={(tm, r) =>
            void callRpc('update_room_settings', {
              p_room_id: room.id,
              p_time_mode: tm,
              p_rounds: r,
            })
          }
          onKick={(uid) => void callRpc('kick_player', { p_room_id: room.id, p_target: uid })}
          onDelete={async () => {
            if (!window.confirm('Delete this room for everyone?')) return
            const ok = await callRpc('delete_room', { p_room_id: room.id })
            if (ok) navigate('/')
          }}
          onStart={() => void callRpc('start_game', { p_room_id: room.id })}
        />
      )}

      {room.phase === 'question' && (
        <div className="game-card">
          <p style={{ color: 'var(--text)', marginBottom: 8 }}>
            Round {room.current_round} / {room.rounds_total}
          </p>
          <h2 style={{ margin: '0 0 12px', fontSize: '22px' }}>{prompt ?? '…'}</h2>
          <p className="game-timer">
            {questionSecondsLeft !== null ? `${questionSecondsLeft}s` : 'Timer starts after first guess'}
          </p>
          <input
            className="game-input"
            type="number"
            step="any"
            value={guessInput}
            onChange={(e) => setGuessInput(e.target.value)}
            placeholder="Your guess"
            style={{ marginTop: 16 }}
          />
          <button
            type="button"
            className="counter"
            style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
            disabled={busy || guessInput === ''}
            onClick={() => {
              const v = Number(guessInput)
              if (Number.isNaN(v)) return
              void (async () => {
                const ok = await callRpc('submit_guess', { p_room_id: room.id, p_guess: v })
                if (ok) setGuessInput('')
              })()
            }}
          >
            Submit guess
          </button>
        </div>
      )}

      {room.phase === 'reveal' && (
        <RevealPhase
          room={room}
          players={players}
          scores={scores}
          guesses={guesses}
          revealSecondsLeft={revealSecondsLeft}
          userId={userId!}
          busy={busy}
          onReady={() => void callRpc('set_ready', { p_room_id: room.id })}
        />
      )}

      {room.phase === 'final' && (
        <FinalPhase
          players={players}
          scores={scores}
          isHost={!!isHost}
          busy={busy}
          onBack={() => void callRpc('host_back_to_lobby', { p_room_id: room.id })}
        />
      )}
    </section>
  )
}

function LobbyPhase({
  room,
  players,
  isHost,
  userId,
  busy,
  onUpdateSettings,
  onKick,
  onDelete,
  onStart,
}: {
  room: RoomRow
  players: RoomPlayerRow[]
  isHost: boolean
  userId: string
  busy: boolean
  onUpdateSettings: (tm: GameTimeMode, rounds: number) => void
  onKick: (uid: string) => void
  onDelete: () => void
  onStart: () => void
}) {
  const [tm, setTm] = useState<GameTimeMode>(room.time_mode)
  const [rounds, setRounds] = useState(room.rounds_total)

  const active = players.filter((p) => !p.kicked_at)

  return (
    <>
      <div className="game-card">
        <h2 style={{ marginTop: 0 }}>Room</h2>
        <p style={{ color: 'var(--text)' }}>
          Share the code so others can join. Rounds: {room.rounds_total}. Mode:{' '}
          {room.time_mode === 'total_30' ? '30s total' : '30s after first guess'}.
        </p>
        {isHost ? (
          <>
            <div style={{ marginTop: 16 }}>
              <label style={{ marginRight: 12 }}>
                <input
                  type="radio"
                  checked={tm === 'total_30'}
                  onChange={() => setTm('total_30')}
                />{' '}
                30s total
              </label>
              <label>
                <input
                  type="radio"
                  checked={tm === 'after_first_30'}
                  onChange={() => setTm('after_first_30')}
                />{' '}
                30s after first guess
              </label>
            </div>
            <label style={{ display: 'block', marginTop: 12 }}>Rounds ({rounds})</label>
            <input
              type="range"
              min={3}
              max={15}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <button
              type="button"
              className="btn-ghost"
              style={{ marginTop: 12 }}
              disabled={busy}
              onClick={() => onUpdateSettings(tm, rounds)}
            >
              Save settings
            </button>
          </>
        ) : null}
      </div>

      <div className="game-card">
        <h3 style={{ marginTop: 0 }}>Players</h3>
        {active.map((p) => (
          <div key={p.user_id} className="game-row">
            <span>
              {p.nickname}
              {p.user_id === room.host_id ? ' (host)' : ''}
            </span>
            {isHost && p.user_id !== userId ? (
              <button
                type="button"
                className="btn-ghost btn-danger"
                disabled={busy}
                onClick={() => onKick(p.user_id)}
                aria-label={`Remove ${p.nickname}`}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {isHost ? (
        <div className="game-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            className="counter"
            style={{ width: '100%', justifyContent: 'center' }}
            disabled={busy}
            onClick={onStart}
          >
            Start game
          </button>
          <button type="button" className="btn-ghost btn-danger" disabled={busy} onClick={onDelete}>
            Delete room
          </button>
        </div>
      ) : (
        <p style={{ color: 'var(--text)', textAlign: 'center' }}>Waiting for the host to start…</p>
      )}
    </>
  )
}

function RevealPhase({
  room,
  players,
  scores,
  guesses,
  revealSecondsLeft,
  userId,
  busy,
  onReady,
}: {
  room: RoomRow
  players: RoomPlayerRow[]
  scores: RoundScoreRow[]
  guesses: RoundGuessRow[]
  revealSecondsLeft: number | null
  userId: string
  busy: boolean
  onReady: () => void
}) {
  const nick = (uid: string) => players.find((p) => p.user_id === uid)?.nickname ?? uid
  const guessOf = (uid: string) =>
    guesses.find((g) => g.round_index === room.current_round && g.user_id === uid)?.guess
  const roundScores = scores
    .filter((s) => s.round_index === room.current_round)
    .sort((a, b) => b.points - a.points)

  return (
    <div className="game-card">
      <h2 style={{ marginTop: 0 }}>Results</h2>
      <p style={{ color: 'var(--text)' }}>
        Answer: <strong>{room.reveal_answer ?? '—'}</strong>
      </p>
      <p className="game-timer" style={{ marginBottom: 12 }}>
        Next in {revealSecondsLeft ?? 0}s (or when everyone is ready)
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '15px' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '6px 0' }}>#</th>
            <th style={{ textAlign: 'left' }}>Player</th>
            <th style={{ textAlign: 'right' }}>Guess</th>
            <th style={{ textAlign: 'right' }}>Points</th>
          </tr>
        </thead>
        <tbody>
          {roundScores.map((s, i) => (
            <tr key={s.user_id}>
              <td style={{ padding: '6px 0' }}>{i + 1}</td>
              <td>{nick(s.user_id)}</td>
              <td style={{ textAlign: 'right' }}>{guessOf(s.user_id) ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{s.points.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="counter"
        style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
        disabled={busy || players.find((p) => p.user_id === userId)?.is_ready}
        onClick={onReady}
      >
        {players.find((p) => p.user_id === userId)?.is_ready ? 'Ready ✓' : "I'm ready"}
      </button>
    </div>
  )
}

function FinalPhase({
  players,
  scores,
  isHost,
  busy,
  onBack,
}: {
  players: RoomPlayerRow[]
  scores: RoundScoreRow[]
  isHost: boolean
  busy: boolean
  onBack: () => void
}) {
  const nick = (uid: string) => players.find((p) => p.user_id === uid)?.nickname ?? uid
  const totals = new Map<string, number>()
  for (const s of scores) {
    totals.set(s.user_id, (totals.get(s.user_id) ?? 0) + s.points)
  }
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1])

  return (
    <div className="game-card">
      <h2 style={{ marginTop: 0 }}>Final scores</h2>
      <ol style={{ paddingLeft: 20, margin: 0 }}>
        {rows.map(([uid, pt]) => (
          <li key={uid} style={{ marginBottom: 8 }}>
            <strong>{nick(uid)}</strong> — {pt.toFixed(4)} pts
          </li>
        ))}
      </ol>
      {isHost ? (
        <button
          type="button"
          className="counter"
          style={{ marginTop: 20, width: '100%', justifyContent: 'center' }}
          disabled={busy}
          onClick={onBack}
        >
          Back to lobby
        </button>
      ) : (
        <p style={{ color: 'var(--text)', marginTop: 16 }}>Waiting for the host…</p>
      )}
    </div>
  )
}
