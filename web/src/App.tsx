import AuthGate from './AuthGate'
import MainPage from './MainPage'

export default function App() {
  return (
    <AuthGate>
      <MainPage />
    </AuthGate>
  )
}
