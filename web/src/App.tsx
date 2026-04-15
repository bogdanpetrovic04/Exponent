import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './AuthGate'
import LobbyPage from './pages/LobbyPage'
import RoomPage from './pages/RoomPage'

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthGate>
  )
}
