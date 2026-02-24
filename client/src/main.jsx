import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

function applyInitialTheme() {
  try {
    let mode = localStorage.getItem('theme_current_mode')
    if (mode !== 'light' && mode !== 'dark') {
      const legacyDayMode = localStorage.getItem('theme_day_mode')
      if (legacyDayMode === 'light' || legacyDayMode === 'dark') {
        mode = legacyDayMode
      } else if (localStorage.getItem('theme_mode') === 'dark' || localStorage.getItem('theme') === 'dark') {
        mode = 'dark'
      } else {
        mode = 'light'
      }
    }

    const h = new Date().getHours()
    const period = h >= 23 || h < 8 ? 'night' : 'day'
    const defaultMode = period === 'night' ? 'dark' : 'light'
    const lastPeriod = localStorage.getItem('theme_last_period')
    if (lastPeriod !== period) {
      mode = defaultMode
      localStorage.setItem('theme_current_mode', mode)
      localStorage.setItem('theme_last_period', period)
    }

    const shouldDark = mode === 'dark'
    if (shouldDark) {
      document.documentElement.setAttribute('data-theme', 'dark')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  } catch {}
}

applyInitialTheme()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
