import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { API } from '../App'
import AgentSettingsPanel from '../components/AgentSettingsPanel'

export default function Settings({ babyId }) {
  const [themeMode, setThemeMode] = useState(() => {
    try {
      const mode = localStorage.getItem('theme_current_mode')
      if (mode === 'light' || mode === 'dark') return mode
      const dayMode = localStorage.getItem('theme_day_mode')
      if (dayMode === 'light' || dayMode === 'dark') return dayMode
      if (localStorage.getItem('theme_mode') === 'dark' || localStorage.getItem('theme') === 'dark') return 'dark'
      return 'light'
    } catch {
      return 'light'
    }
  })
  const [rule, setRule] = useState(null)
  const [saving, setSaving] = useState(false)

  const applyThemeToDom = (mode) => {
    if (mode === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }

  const syncThemeByPeriod = () => {
    const hour = new Date().getHours()
    const period = hour >= 23 || hour < 8 ? 'night' : 'day'
    const defaultMode = period === 'night' ? 'dark' : 'light'
    let nextMode = themeMode

    try {
      const lastPeriod = localStorage.getItem('theme_last_period')
      const storedMode = localStorage.getItem('theme_current_mode')
      if (storedMode === 'light' || storedMode === 'dark') nextMode = storedMode
      if (lastPeriod !== period) {
        nextMode = defaultMode
        localStorage.setItem('theme_current_mode', nextMode)
        localStorage.setItem('theme_last_period', period)
      } else if (!lastPeriod) {
        localStorage.setItem('theme_last_period', period)
      }
    } catch {}

    setThemeMode(nextMode)
    applyThemeToDom(nextMode)
  }

  useEffect(() => {
    syncThemeByPeriod()
    const timer = setInterval(syncThemeByPeriod, 60 * 1000)
    const onStorage = () => syncThemeByPeriod()
    window.addEventListener('storage', onStorage)
    return () => {
      clearInterval(timer)
      window.removeEventListener('storage', onStorage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('theme_current_mode', themeMode)
      const hour = new Date().getHours()
      const period = hour >= 23 || hour < 8 ? 'night' : 'day'
      localStorage.setItem('theme_last_period', period)
    } catch {}
    applyThemeToDom(themeMode)
  }, [themeMode])

  const loadRules = () => {
    fetch(API + '/reminder-rules')
      .then(r => r.json())
      .then(data => {
        const first = Array.isArray(data) ? data[0] : null
        setRule(first || null)
      })
      .catch(() => setRule(null))
  }

  useEffect(() => {
    loadRules()
  }, [])

  const updateLocalRule = (field, value) => {
    setRule(prev => {
      if (!prev) return prev
      return { ...prev, [field]: value }
    })
  }

  const saveRule = () => {
    if (!rule?.id) return
    setSaving(true)
    fetch(API + `/reminder-rules/${rule.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feeding_interval_hours: Number(rule.feeding_interval_hours || 0),
        feeding_interval_minutes: Number(rule.feeding_interval_minutes || 0),
        awake_interval_hours: Number(rule.awake_interval_hours || 0),
        awake_interval_minutes: Number(rule.awake_interval_minutes || 0),
        show_sleep_time_range: Number(rule.show_sleep_time_range ?? 1) === 1,
      }),
    })
      .then(r => r.json())
      .then(() => loadRules())
      .finally(() => setSaving(false))
  }

  const handleExport = () => {
    const id = babyId || ''
    fetch(API + `/export?baby_id=${id}`)
      .then(r => r.json())
      .then(data => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `babynote-export-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
      })
  }

  return (
    <div style={styles.wrap}>
      <h2 style={styles.pageTitle}>管理中心</h2>
      <section style={styles.section}>
        <h2 style={styles.title}>界面偏好</h2>
        <p style={styles.hint}>每天 23:00 - 次日 08:00 自动启用深色模式。</p>
        <div style={styles.row}>
          <span>深浅模式</span>
          <button
            onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
            style={{
              ...styles.toggle,
              background: themeMode === 'dark' ? 'var(--primary)' : 'var(--border)',
            }}
          >
            <span style={styles.toggleSun}>☀</span>
            <span style={styles.toggleMoon}>🌙</span>
            <span
              style={{
                ...styles.knob,
                transform: themeMode === 'dark' ? 'translateX(22px)' : 'translateX(2px)',
              }}
            >
              {themeMode === 'dark' ? '🌙' : '☀'}
            </span>
          </button>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.title}>喂奶提醒规则</h2>
        <p style={styles.hint}>使用统一喂奶间隔进行提醒，不再按月龄区分。</p>
        <div style={styles.ruleCard}>
          <div style={styles.ruleHeader}>
            <span style={styles.ruleLabel}>当前全局喂奶间隔</span>
            <button
              onClick={saveRule}
              style={styles.saveBtn}
              disabled={saving || !rule?.id}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
          <div style={styles.ruleRow}>
            <label>喂奶间隔（小时）</label>
            <input
              type="number"
              min="0"
              max="24"
              step="1"
              value={rule?.feeding_interval_hours ?? 0}
              onChange={e => updateLocalRule('feeding_interval_hours', e.target.value)}
              style={styles.numInput}
            />
          </div>
          <div style={styles.ruleRow}>
            <label>喂奶间隔（分钟）</label>
            <input
              type="number"
              min="0"
              max="59"
              step="1"
              value={rule?.feeding_interval_minutes ?? 0}
              onChange={e => updateLocalRule('feeding_interval_minutes', e.target.value)}
              style={styles.numInput}
            />
          </div>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.title}>睡眠设置</h2>
        <p style={styles.hint}>清醒间隔用于计算总览中的下次入睡时间。</p>
        <div style={styles.ruleCard}>
          <div style={styles.ruleHeader}>
            <span style={styles.ruleLabel}>睡眠展示与提醒</span>
            <button
              onClick={saveRule}
              style={styles.saveBtn}
              disabled={saving || !rule?.id}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
          <div style={styles.ruleRow}>
            <label>清醒间隔（小时）</label>
            <input
              type="number"
              min="0"
              max="24"
              step="1"
              value={rule?.awake_interval_hours ?? 2}
              onChange={e => updateLocalRule('awake_interval_hours', e.target.value)}
              style={styles.numInput}
            />
          </div>
          <div style={styles.ruleRow}>
            <label>清醒间隔（分钟）</label>
            <input
              type="number"
              min="0"
              max="59"
              step="1"
              value={rule?.awake_interval_minutes ?? 15}
              onChange={e => updateLocalRule('awake_interval_minutes', e.target.value)}
              style={styles.numInput}
            />
          </div>
          <div style={{ ...styles.ruleRow, ...styles.toggleSettingRow }}>
            <div style={styles.settingCopy}>
              <span>显示睡眠时间区间</span>
              <span style={styles.settingHint}>在最新动态和时间线中显示入睡、醒来时间</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={Number(rule?.show_sleep_time_range ?? 1) === 1}
              aria-label="显示睡眠时间区间"
              onClick={() => updateLocalRule(
                'show_sleep_time_range',
                Number(rule?.show_sleep_time_range ?? 1) === 1 ? 0 : 1,
              )}
              style={{
                ...styles.switchToggle,
                background: Number(rule?.show_sleep_time_range ?? 1) === 1
                  ? 'var(--primary)'
                  : 'var(--border)',
              }}
            >
              <span
                style={{
                  ...styles.switchKnob,
                  transform: Number(rule?.show_sleep_time_range ?? 1) === 1
                    ? 'translateX(24px)'
                    : 'translateX(2px)',
                }}
              />
            </button>
          </div>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.title}>个人 Agent</h2>
        <AgentSettingsPanel babyId={babyId} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.title}>数据与备份</h2>
        <button onClick={handleExport} style={styles.btn}>
          导出备份 (JSON)
        </button>
      </section>

      <section style={styles.section}>
        <Link to="/babies" style={styles.link}>档案管理</Link>
      </section>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 24 },
  pageTitle: { fontSize: '1.15rem', fontWeight: 700, marginBottom: -8 },
  section: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 20,
    border: '1px solid var(--border)',
  },
  title: { fontSize: '1rem', marginBottom: 12 },
  hint: { fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 8 },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggle: {
    width: 48,
    height: 26,
    borderRadius: 13,
    position: 'relative',
    transition: 'background 0.25s ease, box-shadow 0.25s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 6px',
    overflow: 'hidden',
    minWidth: 0,
    minHeight: 0,
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)',
  },
  toggleSun: {
    fontSize: '0.62rem',
    lineHeight: 1.1,
    opacity: 0.75,
    pointerEvents: 'none',
  },
  toggleMoon: {
    fontSize: '0.62rem',
    lineHeight: 1.1,
    opacity: 0.75,
    pointerEvents: 'none',
  },
  knob: {
    position: 'absolute',
    top: 2,
    left: 0,
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform 0.25s cubic-bezier(.2,.8,.2,1)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.62rem',
    lineHeight: 1,
    pointerEvents: 'none',
  },
  ruleCard: {
    background: 'var(--bg)',
    borderRadius: 10,
    padding: 14,
    border: '1px solid var(--border)',
  },
  ruleHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  ruleLabel: { fontWeight: 600 },
  ruleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  toggleSettingRow: {
    marginTop: 12,
    marginBottom: 0,
    paddingTop: 12,
    borderTop: '1px solid var(--border)',
  },
  settingCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  },
  settingHint: {
    color: 'var(--text-muted)',
    fontSize: '0.76rem',
    lineHeight: 1.35,
  },
  switchToggle: {
    width: 48,
    height: 26,
    flex: '0 0 48px',
    padding: 0,
    borderRadius: 999,
    position: 'relative',
    minWidth: 0,
    minHeight: 0,
    transition: 'background 0.2s ease',
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
  },
  switchKnob: {
    position: 'absolute',
    top: 2,
    left: 0,
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 5px rgba(0,0,0,0.22)',
    transition: 'transform 0.2s cubic-bezier(.2,.8,.2,1)',
  },
  numInput: {
    width: 80,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text)',
  },
  saveBtn: {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text)',
    fontSize: '0.85rem',
  },
  btn: {
    padding: '12px 20px',
    borderRadius: 10,
    background: 'var(--primary)',
    color: '#fff',
    width: '100%',
  },
  link: {
    display: 'block',
    padding: 12,
    color: 'var(--primary)',
  },
}
