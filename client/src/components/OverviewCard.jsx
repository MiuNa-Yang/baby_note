import { useEffect, useState } from 'react'
import { formatTime } from '../utils/date'

function formatAge(ageDays) {
  if (ageDays < 30) return `${ageDays}天`
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}个月${ageDays % 30}天`
  return `${Math.floor(ageDays / 365)}岁`
}

function formatInterval(hours, minutes) {
  const h = Number(hours || 0)
  const m = Number(minutes || 0)
  const parts = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0 || parts.length === 0) parts.push(`${m}分钟`)
  return parts.join('')
}

function getRemainingMinutes(nextFeedingAt, nowMs) {
  if (!nextFeedingAt) return null
  const next = new Date(nextFeedingAt).getTime()
  if (Number.isNaN(next)) return null
  const diffMs = next - nowMs
  return diffMs >= 0 ? Math.ceil(diffMs / 60000) : Math.floor(diffMs / 60000)
}

export default function OverviewCard({ overview }) {
  const [tick, setTick] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  if (!overview) return <div style={styles.card}>加载中...</div>

  const { ageDays, reminder } = overview
  const ageText = formatAge(ageDays)
  const remainingMinutes = getRemainingMinutes(reminder?.nextFeedingAt, tick)
  const overdue = remainingMinutes !== null && remainingMinutes < 0
  const dueNow = remainingMinutes !== null && remainingMinutes <= 0

  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <span style={styles.label}>宝宝月龄</span>
        <span style={styles.value}>{ageText}</span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>下次喂奶</span>
        <span style={styles.value}>
          {reminder?.nextFeedingAt ? formatTime(reminder.nextFeedingAt) : '暂无'}
        </span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>喂奶间隔</span>
        <span style={styles.value}>
          {reminder?.rule
            ? formatInterval(reminder.rule.feeding_interval_hours, reminder.rule.feeding_interval_minutes)
            : '未配置'}
        </span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>剩余时间</span>
        <span style={{ ...styles.value, ...(overdue ? styles.valueWarn : {}) }}>
          {remainingMinutes === null
            ? '请先记录喂奶'
            : overdue
              ? `已超时 ${Math.abs(remainingMinutes)} 分钟`
              : `还有 ${remainingMinutes} 分钟`}
        </span>
      </div>

      {dueNow && (
        <div style={styles.alert}>应该喂奶了，请尽快喂奶</div>
      )}
    </div>
  )
}

const styles = {
  card: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 20,
    boxShadow: '0 2px 12px var(--shadow)',
    border: '1px solid var(--border)',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: '1px solid var(--border)',
  },
  label: { color: 'var(--text-muted)', fontSize: '0.95rem' },
  value: { fontWeight: 600, fontSize: '1rem' },
  valueWarn: { color: '#d64545' },
  alert: {
    marginTop: 14,
    background: '#fff2f0',
    border: '1px solid #ffd0cc',
    color: '#b42318',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: '0.92rem',
    fontWeight: 600,
  },
}
