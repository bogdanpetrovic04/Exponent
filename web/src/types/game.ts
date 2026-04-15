export type GamePhase = 'lobby' | 'question' | 'reveal' | 'final'
export type GameTimeMode = 'total_30' | 'after_first_30'

export type RoomRow = {
  id: string
  code: string | null
  host_id: string
  phase: GamePhase
  time_mode: GameTimeMode
  rounds_total: number
  current_round: number
  current_question_id: string | null
  question_deadline_at: string | null
  question_started_at: string | null
  reveal_started_at: string | null
  reveal_deadline_at: string | null
  reveal_answer: number | null
  expires_at: string
  deleted_at: string | null
  updated_at: string
}

export type RoomPlayerRow = {
  room_id: string
  user_id: string
  nickname: string
  is_ready: boolean
  kicked_at: string | null
  joined_at: string
}

export type RoundScoreRow = {
  room_id: string
  round_index: number
  user_id: string
  relative_error: number
  points: number
}

export type RoundGuessRow = {
  id: string
  room_id: string
  round_index: number
  user_id: string
  guess: number
  created_at: string
}
