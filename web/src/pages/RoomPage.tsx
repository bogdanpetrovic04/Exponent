import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useRoomState } from '../hooks/useRoomState'
import type { GameTimeMode, RoomPlayerRow, RoomRow, RoundGuessRow, RoundScoreRow, TopicMode, TopicRow } from '../types/game'
import './game.css'

function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 10000 || (abs > 0 && abs < 0.001)) {
    return n.toExponential(2).replace('e+', 'e')
  }
  if (abs >= 1000) return n.toFixed(0)
  if (abs >= 10) return n.toFixed(2)
  return n.toPrecision(3)
}

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const { room, players, scores, guesses, topics, loading, error, tickError, refresh, refreshTopics } =
    useRoomState(roomId)
  const afterLobbySave = useCallback(() => {
    void refresh()
  }, [refresh])
  const [userId, setUserId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [questionImage, setQuestionImage] = useState<{ imageUrl: string; sourceUrl: string } | null>(null)
  const [questionImageLoading, setQuestionImageLoading] = useState(false)
  const [guessInput, setGuessInput] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    // Phase changes happen on the same route; reset scroll for "new screens".
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [room?.phase])

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!supabase || !room || room.phase !== 'question') {
      setPrompt(null)
      setQuestionImage(null)
      setQuestionImageLoading(false)
      return
    }
    void supabase.rpc('get_question_prompt', { p_room_id: room.id }).then(({ data, error: err }) => {
      if (!err && typeof data === 'string') setPrompt(data)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only refetch prompt when question identity changes
  }, [room?.id, room?.phase, room?.current_question_id])

  const questionId = room?.current_question_id ?? null
  const phase = room?.phase ?? null
  useEffect(() => {
    if (!supabase || phase !== 'question' || !questionId) return
    const p = (prompt ?? '').trim()
    if (!p) return

    setQuestionImageLoading(true)
    setQuestionImage(null)

    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession()
        const token = sess.session?.access_token
        if (!token) return

        const r = await fetch('/api/question-image', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ questionId, prompt: p }),
        })
        const raw: unknown = await r.json().catch(() => null)
        const j = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
        if (!r.ok || !j || j.ok !== true) return
        const imageUrl = typeof j.imageUrl === 'string' ? j.imageUrl : null
        const sourceUrl = typeof j.sourceUrl === 'string' ? j.sourceUrl : null
        if (imageUrl && sourceUrl) setQuestionImage({ imageUrl, sourceUrl })
      } finally {
        setQuestionImageLoading(false)
      }
    })()
  }, [prompt, phase, questionId])

  const isHost = userId && room && userId === room.host_id
  const me = players.find((p) => p.user_id === userId && !p.kicked_at)

  const questionSecondsLeft = useMemo(() => {
    if (!room?.question_deadline_at) return null
    return Math.max(
      0,
      Math.ceil((new Date(room.question_deadline_at).getTime() - now) / 1000),
    )
  }, [room?.question_deadline_at, now])

  const questionTimeFrac = useMemo(() => {
    if (!room?.question_deadline_at) return null
    const deadlineMs = new Date(room.question_deadline_at).getTime()
    const totalMs = Math.max(1, (room.question_seconds ?? 30) * 1000)
    const left = Math.max(0, Math.min(1, (deadlineMs - now) / totalMs))
    return left
  }, [room?.question_deadline_at, room?.question_seconds, now])

  const revealSecondsLeft = useMemo(() => {
    if (!room?.reveal_deadline_at) return null
    return Math.max(
      0,
      Math.ceil((new Date(room.reveal_deadline_at).getTime() - now) / 1000),
    )
  }, [room?.reveal_deadline_at, now])

  const guessScientific = useMemo(() => {
    const s = guessInput.trim()
    if (s === '' || s === '-' || s === '.' || s === '-.') return null
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    if (n === 0) return { mantissa: '0', exp: 0 }
    const abs = Math.abs(n)
    const exp = Math.floor(Math.log10(abs))
    const mantissaNum = n / 10 ** exp
    const mantissa = Number.isFinite(mantissaNum) ? mantissaNum.toPrecision(3) : String(mantissaNum)
    return { mantissa, exp }
  }, [guessInput])

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

  async function generateAiTopic(description: string): Promise<{ topicId: string; displayName: string } | null> {
    if (!supabase) return null
    setBusy(true)
    setActionError(null)
    try {
      const { data: sess } = await supabase.auth.getSession()
      const token = sess.session?.access_token
      if (!token) throw new Error('Not signed in')

      const r = await fetch('/api/generate-topic', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ description }),
      })
      const raw: unknown = await r.json()
      const j = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
      if (!r.ok || !j || j.ok !== true) {
        const err = typeof j?.error === 'string' ? j.error : 'AI generation failed'
        const details = typeof j?.details === 'string' ? j.details : null
        throw new Error(details ? `${err} — ${details}` : err)
      }
      if (typeof j.topicId !== 'string' || typeof j.displayName !== 'string') {
        throw new Error('Invalid AI response')
      }
      await refreshTopics()
      return { topicId: j.topicId, displayName: j.displayName }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'AI generation failed')
      return null
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
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
      {tickError ? (
        <p style={{ color: '#fbbf24', marginBottom: 12 }} role="status">
          Sync: {tickError}
        </p>
      ) : null}

      {room.phase === 'lobby' && (
        <LobbyPhase
          key={`${room.time_mode}-${room.rounds_total}-${room.topic_mode}-${room.topic_id}-${room.updated_at}`}
          room={room}
          players={players}
          topics={topics}
          isHost={!!isHost}
          userId={userId!}
          busy={busy}
          onAfterSave={afterLobbySave}
          onGenerateAiTopic={(desc) => generateAiTopic(desc)}
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
        <div className="game-card panel-enter">
          <p style={{ color: 'var(--text)', marginBottom: 8 }}>
            Round {room.current_round} / {room.rounds_total}
          </p>
          {prompt ? (
            <>
              <h2 style={{ margin: '0 0 12px', fontSize: '22px' }}>{prompt}</h2>
              {questionImageLoading ? <div className="question-media question-media-skeleton" /> : null}
              {questionImage ? (
                <div className="question-media" aria-label="Question image">
                  <img src={questionImage.imageUrl} alt="" loading="lazy" decoding="async" />
                  <a
                    className="question-media-info"
                    href={questionImage.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Image source"
                    title="Image source"
                  >
                    ⓘ
                  </a>
                </div>
              ) : null}
            </>
          ) : (
            <div className="shimmer" style={{ height: 54, marginBottom: 12 }} aria-label="Loading prompt" />
          )}
          <p className="game-timer">
            {questionSecondsLeft !== null ? `${questionSecondsLeft}s` : 'Timer starts after first guess'}
          </p>

          {questionTimeFrac !== null ? (
            <div style={{ marginTop: 10 }} className={questionSecondsLeft !== null && questionSecondsLeft <= 5 ? 'pulse-soft' : ''}>
              <div className="timebar" aria-label="Time remaining">
                <div style={{ width: `${Math.round(questionTimeFrac * 100)}%` }} />
              </div>
            </div>
          ) : null}
          <div
            style={{
              marginTop: 16,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <input
              className="game-input"
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={guessInput}
              onChange={(e) => setGuessInput(e.target.value)}
              placeholder="Your guess"
            />
            <div
              style={{
                minWidth: 110,
                textAlign: 'right',
                color: 'var(--text)',
                fontFamily: 'var(--mono)',
                fontSize: 14,
                lineHeight: '18px',
              }}
              aria-label="Scientific notation preview"
            >
              {guessScientific ? (
                guessScientific.exp === 0 ? (
                  <span>{guessScientific.mantissa}</span>
                ) : (
                  <span>
                    {guessScientific.mantissa} × 10<sup>{guessScientific.exp}</sup>
                  </span>
                )
              ) : (
                <span style={{ opacity: 0.6 }}> </span>
              )}
            </div>
          </div>
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
  topics,
  isHost,
  userId,
  busy,
  onAfterSave,
  onGenerateAiTopic,
  onKick,
  onDelete,
  onStart,
}: {
  room: RoomRow
  players: RoomPlayerRow[]
  topics: TopicRow[]
  isHost: boolean
  userId: string
  busy: boolean
  onAfterSave: () => void
  onGenerateAiTopic: (description: string) => Promise<{ topicId: string; displayName: string } | null>
  onKick: (uid: string) => void
  onDelete: () => void
  onStart: () => void
}) {
  const [tm, setTm] = useState<GameTimeMode>(room.time_mode)
  const [rounds, setRounds] = useState(room.rounds_total)
  const [questionSeconds, setQuestionSeconds] = useState(room.question_seconds)
  const [topicMode, setTopicMode] = useState<TopicMode>(room.topic_mode)
  const [topicId, setTopicId] = useState(room.topic_id)
  const [aiDescription, setAiDescription] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  const active = players.filter((p) => !p.kicked_at)
  const topicLabel = (t: TopicRow) => `${t.name} - ${t.short_description}`
  const selectedTopic = topics.find((t) => t.id === topicId) ?? null
  const roomTopic = topics.find((t) => t.id === room.topic_id) ?? null
  const [autoSaveReady, setAutoSaveReady] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    // Avoid firing autosave on first render; we only want user-driven changes.
    const id = window.setTimeout(() => setAutoSaveReady(true), 0)
    return () => window.clearTimeout(id)
  }, [])

  const saveSettings = useCallback(async () => {
    if (!supabase) return false
    const { error } = await supabase.rpc('update_room_settings', {
      p_room_id: room.id,
      p_time_mode: tm,
      p_rounds: rounds,
      p_topic_mode: topicMode,
      p_topic_id: topicId,
      p_question_seconds: questionSeconds,
    })
    if (error) {
      setSaveError(error.message)
      return false
    }
    setSaveError(null)
    return true
  }, [questionSeconds, room.id, rounds, tm, topicId, topicMode])

  useEffect(() => {
    if (!isHost || !autoSaveReady) return
    const dirty =
      tm !== room.time_mode ||
      rounds !== room.rounds_total ||
      questionSeconds !== room.question_seconds ||
      topicMode !== room.topic_mode ||
      topicId !== room.topic_id
    if (!dirty) {
      return
    }
    const id = window.setTimeout(() => {
      void (async () => {
        const ok = await saveSettings()
        if (ok) onAfterSave()
      })()
    }, 400)
    return () => window.clearTimeout(id)
  }, [
    isHost,
    autoSaveReady,
    tm,
    rounds,
    topicMode,
    topicId,
    questionSeconds,
    room.time_mode,
    room.rounds_total,
    room.question_seconds,
    room.topic_mode,
    room.topic_id,
    onAfterSave,
    room.id,
    saveSettings,
  ])

  return (
    <>
      <div className="game-card">
        <h2 style={{ marginTop: 0 }}>Room</h2>
        <p style={{ color: 'var(--text)' }}>
          Share the code so others can join. Rounds: {room.rounds_total}. Mode:{' '}
          {room.time_mode === 'total_30'
            ? `${room.question_seconds}s total`
            : `${room.question_seconds}s after first guess`}
          .
        </p>
        {roomTopic ? (
          <p style={{ color: 'var(--text)', marginTop: 8 }}>
            Topic: <strong>{topicLabel(roomTopic)}</strong>
          </p>
        ) : null}
        {isHost ? (
          <>
            <div className="toggle-group" role="group" aria-label="Timer mode">
              <button
                type="button"
                className="toggle-btn"
                aria-pressed={tm === 'total_30'}
                onClick={() => setTm('total_30')}
              >
                Total time
              </button>
              <button
                type="button"
                className="toggle-btn"
                aria-pressed={tm === 'after_first_30'}
                onClick={() => setTm('after_first_30')}
              >
                After first guess
              </button>
            </div>

            <label style={{ display: 'block', marginTop: 12 }}>
              {tm === 'total_30' ? 'Total time' : 'Time after first guess'} ({questionSeconds}s)
            </label>
            <input
              type="range"
              min={10}
              max={90}
              value={questionSeconds}
              onChange={(e) => setQuestionSeconds(Number(e.target.value))}
              style={{ width: '100%' }}
            />

            <label style={{ display: 'block', marginTop: 12 }}>Rounds ({rounds})</label>
            <input
              type="range"
              min={3}
              max={15}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              style={{ width: '100%' }}
            />

            <label style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>Topic</label>
            <div className="toggle-group" role="group" aria-label="Topic mode">
              <button
                type="button"
                className="toggle-btn"
                aria-pressed={topicMode === 'preset'}
                onClick={() => setTopicMode('preset')}
              >
                Preset
              </button>
              <button
                type="button"
                className="toggle-btn"
                aria-pressed={topicMode === 'random'}
                onClick={() => setTopicMode('random')}
              >
                Random
              </button>
              <button
                type="button"
                className="toggle-btn"
                aria-pressed={topicMode === 'ai_custom'}
                onClick={() => setTopicMode('ai_custom')}
              >
                Custom AI
              </button>
            </div>

            {topicMode === 'preset' ? (
              <select
                className="game-input"
                style={{ marginTop: 12 }}
                value={topicId}
                onChange={(e) => setTopicId(e.target.value)}
              >
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {topicLabel(t)}
                  </option>
                ))}
              </select>
            ) : null}

            {saveError ? (
              <p style={{ color: '#f87171', marginTop: 8, fontSize: '13px' }} role="alert">
                Could not save settings: {saveError}
              </p>
            ) : null}

            {selectedTopic ? (
              <p style={{ color: 'var(--text)', marginTop: 10, fontSize: '14px' }}>
                Selected: <strong>{topicLabel(selectedTopic)}</strong>
              </p>
            ) : null}

            {topicMode === 'ai_custom' ? (
              <div style={{ marginTop: 12 }}>
                <textarea
                  className="game-input"
                  value={aiDescription}
                  onChange={(e) => setAiDescription(e.target.value)}
                  placeholder="Describe the topic you want (e.g. “European football stats, 1990–2020”)."
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ marginTop: 12, width: '100%' }}
                  disabled={busy || aiBusy || aiDescription.trim() === ''}
                  onClick={() => {
                    void (async () => {
                      setAiBusy(true)
                      try {
                        const res = await onGenerateAiTopic(aiDescription.trim())
                        if (!res) return
                        setTopicMode('ai_custom')
                        setTopicId(res.topicId)
                        setAiDescription('')
                      } finally {
                        setAiBusy(false)
                      }
                    })()
                  }}
                >
                  {aiBusy ? 'Generating…' : 'Generate questions'}
                </button>
              </div>
            ) : null}
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
    .sort((a, b) => a.points - b.points)

  return (
    <div className="game-card panel-enter">
      <h2 style={{ marginTop: 0 }}>Results</h2>
      <p style={{ color: 'var(--text)' }}>
        Answer: <strong>{room.reveal_answer ?? '—'}</strong>
      </p>
      <p className="game-timer" style={{ marginBottom: 12 }}>
        Next in {revealSecondsLeft ?? 0}s (or when everyone is ready)
      </p>
      <p style={{ color: 'var(--text)', fontSize: '14px', marginBottom: 8 }}>
        Score: 0 = exact answer; no guess = 1; lower is better.
      </p>
      <table className="game-table">
        <colgroup>
          <col style={{ width: 34 }} />
          <col />
          <col style={{ width: 96 }} />
          <col style={{ width: 90 }} />
        </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Guess</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {roundScores.map((s, i) => (
              <tr key={s.user_id}>
                <td className="cell-num">{i + 1}</td>
                <td className="cell-player">{nick(s.user_id)}</td>
                <td className="cell-num">{guessOf(s.user_id) === null || guessOf(s.user_id) === undefined ? '—' : formatCompactNumber(guessOf(s.user_id)!)}</td>
                <td className="cell-num">{formatCompactNumber(s.points)}</td>
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
  const rows = [...totals.entries()].sort((a, b) => a[1] - b[1])

  return (
    <div className="game-card panel-enter">
      <h2 style={{ marginTop: 0 }}>Final standings</h2>
      <p style={{ color: 'var(--text)', fontSize: '14px', marginBottom: 12 }}>
        Total score (sum of per-round scores); lower is better. No guess in a round counts as 1.
      </p>
      <ol style={{ paddingLeft: 20, margin: 0 }}>
        {rows.map(([uid, pt]) => (
          <li key={uid} style={{ marginBottom: 8 }}>
            <strong>{nick(uid)}</strong> — {pt.toFixed(4)}
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
