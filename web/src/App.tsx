import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthGate from './AuthGate'
import ScrollToTop from './components/ScrollToTop'
import LobbyPage from './pages/LobbyPage'
import RoomPage from './pages/RoomPage'

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthGate>
  )
}
