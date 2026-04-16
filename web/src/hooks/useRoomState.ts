import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import type { GamePhase, RoomPlayerRow, RoomRow, RoundGuessRow, RoundScoreRow, TopicRow } from '../types/game'

const PHASES: readonly GamePhase[] = ['lobby', 'question', 'reveal', 'final']

function isGamePhase(s: string): s is GamePhase {
  return (PHASES as readonly string[]).includes(s)
}

export function useRoomState(roomId: string | undefined) {
  const [room, setRoom] = useState<RoomRow | null>(null)
  const [players, setPlayers] = useState<RoomPlayerRow[]>([])
  const [scores, setScores] = useState<RoundScoreRow[]>([])
  const [guesses, setGuesses] = useState<RoundGuessRow[]>([])
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tickError, setTickError] = useState<string | null>(null)

  const applyTickPhase = useCallback((data: unknown) => {
    if (typeof data !== 'string' || !isGamePhase(data) || !roomId) return
    setRoom((prev) => (prev && prev.id === roomId ? { ...prev, phase: data } : prev))
  }, [roomId])

  const refresh = useCallback(async () => {
    if (!supabase || !roomId) return
    setError(null)
    const { data: r, error: er } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId)
      .maybeSingle()
    if (er) {
      setError(er.message)
      setRoom(null)
      setLoading(false)
      return
    }
    if (!r) {
      setRoom(null)
      setLoading(false)
      return
    }
    setRoom(r as RoomRow)

    const { data: pl } = await supabase
      .from('room_players')
      .select('*')
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true })
    setPlayers((pl ?? []) as RoomPlayerRow[])

    const { data: sc } = await supabase
      .from('round_scores')
      .select('*')
      .eq('room_id', roomId)
    setScores((sc ?? []) as RoundScoreRow[])

    const { data: g } = await supabase
      .from('round_guesses')
      .select('*')
      .eq('room_id', roomId)
    setGuesses((g ?? []) as RoundGuessRow[])

    setLoading(false)
  }, [roomId])

  const refreshTopics = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.from('topics').select('*').order('name', { ascending: true })
    setTopics((data ?? []) as TopicRow[])
  }, [])

  useEffect(() => {
    const sb = supabase
    if (!roomId || !sb) {
      queueMicrotask(() => setLoading(false))
      return
    }
    queueMicrotask(() => {
      void refresh()
      void refreshTopics()
    })

    const chRooms = sb
      .channel(`room-${roomId}-rooms`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        () => {
          void refresh()
        },
      )
      .subscribe()

    const chPlayers = sb
      .channel(`room-${roomId}-players`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'room_players',
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void refresh()
        },
      )
      .subscribe()

    const chScores = sb
      .channel(`room-${roomId}-scores`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'round_scores',
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void refresh()
        },
      )
      .subscribe()

    const chGuesses = sb
      .channel(`room-${roomId}-guesses`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'round_guesses',
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void refresh()
        },
      )
      .subscribe()

    const runTick = () =>
      void sb.rpc('room_tick', { p_room_id: roomId }).then(({ data, error: tickErr }) => {
        if (tickErr) {
          setTickError(tickErr.message)
          return
        }
        setTickError(null)
        applyTickPhase(data)
        void refresh()
      })

    void runTick()
    const tick = window.setInterval(runTick, 1500)

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      runTick()
      void refreshTopics()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void sb.removeChannel(chRooms)
      void sb.removeChannel(chPlayers)
      void sb.removeChannel(chScores)
      void sb.removeChannel(chGuesses)
      window.clearInterval(tick)
    }
  }, [roomId, refresh, refreshTopics, applyTickPhase])

  // If the client clock shows the question timer has expired but we still have question phase,
  // poll faster than the main interval (background tabs throttle setInterval heavily).
  useEffect(() => {
    const sb = supabase
    if (!roomId || !sb || !room) return
    if (room.phase !== 'question') return
    if (!room.question_deadline_at) return
    if (new Date(room.question_deadline_at).getTime() > Date.now()) return

    const runTick = () =>
      void sb.rpc('room_tick', { p_room_id: roomId }).then(({ data, error: tickErr }) => {
        if (tickErr) {
          setTickError(tickErr.message)
          return
        }
        setTickError(null)
        applyTickPhase(data)
        void refresh()
      })

    runTick()
    const urgent = window.setInterval(runTick, 500)
    return () => window.clearInterval(urgent)
  }, [roomId, refresh, room, applyTickPhase])

  // Fallback if Realtime misses updates: cheap poll while a round is active.
  useEffect(() => {
    if (!roomId || !supabase || !room) return
    if (room.phase !== 'question' && room.phase !== 'reveal') return
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
    // Intentionally omit `room` — only restart when leaving question/reveal, not on every row refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- room?.phase + guard above is enough
  }, [roomId, refresh, room?.phase])

  return { room, players, scores, guesses, topics, loading, error, tickError, refresh, refreshTopics }
}
