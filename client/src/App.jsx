import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import BabyManage from './pages/BabyManage'
import Stats from './pages/Stats'
import History from './pages/History'
import Settings from './pages/Settings'
import Guide from './pages/Guide'

const API = '/api'

export { API }

function isNightDarkTime() {
  const h = new Date().getHours()
  return h >= 23 || h < 8
}

function getTimePeriod() {
  return isNightDarkTime() ? 'night' : 'day'
}

function getThemeCurrentMode() {
  try {
    const mode = localStorage.getItem('theme_current_mode')
    if (mode === 'light' || mode === 'dark') return mode
    const dayMode = localStorage.getItem('theme_day_mode')
    if (dayMode === 'light' || dayMode === 'dark') return dayMode
    if (localStorage.getItem('theme_mode') === 'dark') return 'dark'
    if (localStorage.getItem('theme') === 'dark') return 'dark'
  } catch {}
  return 'light'
}

function applyThemeMode() {
  const period = getTimePeriod()
  const defaultMode = period === 'night' ? 'dark' : 'light'
  let mode = getThemeCurrentMode()

  try {
    const lastPeriod = localStorage.getItem('theme_last_period')
    if (lastPeriod !== period) {
      mode = defaultMode
      localStorage.setItem('theme_current_mode', mode)
      localStorage.setItem('theme_last_period', period)
    } else if (!lastPeriod) {
      localStorage.setItem('theme_last_period', period)
    }
  } catch {}

  const dark = mode === 'dark'
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

export default function App() {
  const [babies, setBabies] = useState([])
  const [currentBaby, setCurrentBaby] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(API + '/babies')
      .then(r => r.json())
      .then(data => {
        setBabies(Array.isArray(data) ? data : [])
        if (data?.length && !currentBaby) setCurrentBaby(data[0].id)
        setLoading(false)
      })
      .catch(() => {
        setBabies([])
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    applyThemeMode()
    const timer = setInterval(applyThemeMode, 60 * 1000)
    const onStorage = () => applyThemeMode()
    window.addEventListener('storage', onStorage)
    return () => {
      clearInterval(timer)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const refreshBabies = () => {
    return fetch(API + '/babies').then(r => r.json()).then(setBabies)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <span style={{ color: 'var(--text-muted)' }}>加载中...</span>
      </div>
    )
  }

  return (
    <BrowserRouter>
      {!babies.length ? (
        <BabyManage onDone={refreshBabies} />
      ) : (
        <Layout currentBaby={currentBaby} setCurrentBaby={setCurrentBaby} babies={babies}>
          <Routes>
            <Route path="/" element={<Home babyId={currentBaby} />} />
            <Route path="/stats" element={<Stats babyId={currentBaby} />} />
            <Route path="/history" element={<History babyId={currentBaby} />} />
            <Route path="/guide" element={<Guide babyId={currentBaby} />} />
            <Route path="/settings" element={<Settings babyId={currentBaby} />} />
            <Route path="/babies" element={<BabyManage onDone={refreshBabies} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      )}
    </BrowserRouter>
  )
}

