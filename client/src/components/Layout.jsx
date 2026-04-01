import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

const navItems = [
  { path: '/', icon: '🧭', label: '总览' },
  { path: '/schedule', icon: '📋', label: '日程' },
  { path: '/stats', icon: '📈', label: '分析' },
  { path: '/history', icon: '🗂️', label: '时间线' },
  { path: '/settings', icon: '🛠️', label: '管理' },
]

export default function Layout({ children, currentBaby, setCurrentBaby, babies }) {
  const loc = useLocation()
  const isGuidePage = loc.pathname === '/guide'
  const [guideInputFocused, setGuideInputFocused] = useState(false)

  useEffect(() => {
    if (!isGuidePage) {
      setGuideInputFocused(false)
      return
    }

    const isChatInput = (el) => {
      if (!el || typeof el.closest !== 'function') return false
      if (el.closest('textarea')) return true
      if (el.closest('input[type="text"]')) return true
      if (el.getAttribute?.('contenteditable') === 'true') return true
      return false
    }

    const onFocusIn = (e) => {
      setGuideInputFocused(isChatInput(e.target))
    }

    const onFocusOut = () => {
      setTimeout(() => {
        setGuideInputFocused(isChatInput(document.activeElement))
      }, 0)
    }

    window.addEventListener('focusin', onFocusIn)
    window.addEventListener('focusout', onFocusOut)
    return () => {
      window.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('focusout', onFocusOut)
    }
  }, [isGuidePage])

  const hideNav = isGuidePage && guideInputFocused
  const isSchedulePage = loc.pathname === '/schedule'

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={styles.header}>
        <div style={styles.headerTop}>
          <span style={styles.title}>育儿导航</span>
          {babies.length > 1 && (
            <select
              value={currentBaby || ''}
              onChange={e => setCurrentBaby(Number(e.target.value))}
              style={styles.select}
            >
              {babies.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          {babies.length === 1 && <span style={styles.babyName}>{babies[0]?.name}</span>}
        </div>
      </header>

      <main
        style={{
          ...styles.main,
          ...(isGuidePage ? (hideNav ? styles.mainGuideInput : styles.mainGuide) : null),
          ...(isSchedulePage ? styles.mainSchedule : null),
        }}
      >
        {children}
      </main>

      {!hideNav && (
        <nav style={styles.nav}>
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              style={{
                ...styles.navItem,
                ...(loc.pathname === item.path ? styles.navItemActive : {}),
              }}
            >
              <span style={{ fontSize: '1.25rem' }}>{item.icon}</span>
              <span style={{ fontSize: '0.73rem' }}>{item.label}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  )
}

const styles = {
  header: {
    background: 'var(--bg-card)',
    padding: '12px 16px',
    paddingTop: 'max(12px, env(safe-area-inset-top))',
    borderBottom: '1px solid var(--border)',
  },
  headerTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: '1.25rem',
    fontWeight: 600,
  },
  babyName: {
    color: 'var(--text-muted)',
    fontSize: '0.9rem',
  },
  select: {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  main: {
    flex: 1,
    padding: '16px',
    paddingBottom: 104,
  },
  mainGuide: {
    paddingBottom: 104,
  },
  mainSchedule: {
    paddingBottom: 104,
  },
  mainGuideInput: {
    paddingBottom: 16,
  },
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    background: 'var(--bg-card)',
    borderTop: '1px solid var(--border)',
    boxShadow: '0 -6px 20px rgba(45, 42, 38, 0.08)',
    paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
    paddingTop: 8,
    zIndex: 1200,
  },
  navItem: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    color: 'var(--text-muted)',
    padding: '8px 2px',
  },
  navItemActive: {
    color: 'var(--primary)',
    fontWeight: 600,
  },
}
