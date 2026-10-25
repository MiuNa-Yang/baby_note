import { useEffect, useState } from 'react'
import { formatTime, parseDateTime } from '../utils/date'

function formatAge(ageDays) {
  if (ageDays < 30) return `${ageDays}天`
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}个月${ageDays % 30}天`
  return `${Math.floor(ageDays / 365)}岁`
}

function getRemainingMinutes(nextFeedingAt, nowMs) {
  if (!nextFeedingAt) return null
  const next = new Date(nextFeedingAt).getTime()
  if (Number.isNaN(next)) return null
  const diffMs = next - nowMs
  return diffMs >= 0 ? Math.ceil(diffMs / 60000) : Math.floor(diffMs / 60000)
}

function formatRemainingMinutesLabel(remainingMinutes, emptyText) {
  if (remainingMinutes === null || remainingMinutes === undefined) return emptyText
  if (remainingMinutes < 0) return `已超时 ${Math.abs(remainingMinutes)} 分钟`
  return `还有 ${remainingMinutes} 分钟`
}

function getLocalDateKey(value) {
  const d = value ? new Date(value) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  return dt.toISOString().slice(0, 10)
}

function formatSupplementReminder(supplements) {
  if (!supplements?.plan?.length) return '暂无计划'
  if (supplements.isComplete) return '今日已完成'
  const pending = supplements.pending?.map(item => item.label).join(' + ')
  return `待服：${pending || supplements.plan.map(item => item.label).join(' + ')}`
}

function formatElapsedMinutes(minutes) {
  const safe = Math.max(0, Math.floor(Number(minutes) || 0))
  if (safe < 60) return `已睡${safe}分钟`
  return `已睡${Math.floor(safe / 60)}小时${safe % 60}分钟`
}

function isNightSleepWindow(date) {
  const h = date.getHours()
  return h >= 18 || h < 5
}

function getLatestWakeAt(records) {
  return (records || [])
    .filter((r) => r.type === 'sleep' && r.sleep_end)
    .map((r) => parseDateTime(r.sleep_end))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0] || null
}

function getNextSleepFromWake(records, nowMs, awakeIntervalMinutes) {
  const now = new Date(nowMs)
  if (isNightSleepWindow(now)) return null
  const wakeAt = getLatestWakeAt(records)
  if (!wakeAt || isNightSleepWindow(wakeAt)) return null
  if (!Number.isFinite(awakeIntervalMinutes) || awakeIntervalMinutes <= 0) return null
  const nextSleepAt = new Date(wakeAt.getTime() + awakeIntervalMinutes * 60000)
  if (isNightSleepWindow(nextSleepAt)) return null
  return nextSleepAt.toISOString()
}

export default function OverviewCard({ overview, records = [], openSleep = null }) {
  const [tick, setTick] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  if (!overview) return <div style={styles.card}>加载中...</div>

  const { ageDays, reminder } = overview
  const ageText = formatAge(ageDays)
  const remainingMinutes = getRemainingMinutes(reminder?.nextFeedingAt, tick)
  const isSleeping = Boolean(openSleep?.sleep_start && !openSleep?.sleep_end)
  const sleepStartedAt = isSleeping ? parseDateTime(openSleep.sleep_start) : null
  const sleptMinutes = sleepStartedAt && !Number.isNaN(sleepStartedAt.getTime())
    ? Math.max(0, Math.floor((tick - sleepStartedAt.getTime()) / 60000))
    : null
  const awakeIntervalMinutes = reminder?.rule
    ? Number(reminder.rule.awake_interval_hours || 0) * 60 + Number(reminder.rule.awake_interval_minutes || 0)
    : 135
  const nextSleepAt = isSleeping ? null : getNextSleepFromWake(records, tick, awakeIntervalMinutes)
  const sleepRemainingMinutes = getRemainingMinutes(nextSleepAt, tick)
  const overdue = remainingMinutes !== null && remainingMinutes < 0
  const dueNow = remainingMinutes !== null && remainingMinutes <= 0
  const supplementsIncomplete = reminder?.supplements?.isComplete === false

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
        <span style={styles.label}>喂奶剩余</span>
        <span style={{ ...styles.value, ...(overdue ? styles.valueWarn : {}) }}>
          {formatRemainingMinutesLabel(remainingMinutes, '请先记录喂奶')}
        </span>
      </div>

      {!isSleeping && (
        <div style={styles.row}>
          <span style={styles.label}>下次入睡</span>
          <span style={styles.value}>
            {nextSleepAt ? formatTime(nextSleepAt) : '暂无'}
          </span>
        </div>
      )}

      <div style={styles.row}>
        <span style={styles.label}>入睡剩余</span>
        <span style={styles.value}>
          {isSleeping
            ? formatElapsedMinutes(sleptMinutes)
            : formatRemainingMinutesLabel(sleepRemainingMinutes, '暂无')}
        </span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>今日补剂</span>
        <span style={{ ...styles.value, ...(supplementsIncomplete ? styles.valueWarn : {}) }}>
          {formatSupplementReminder(reminder?.supplements)}
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
