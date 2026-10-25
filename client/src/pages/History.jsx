import { useState, useEffect } from 'react'
import { API } from '../App'
import { getBeijingDate, getBeijingDateDaysAgo } from '../utils/date'
import RecordList from '../components/RecordList'

const TYPE_LABELS = {
  feeding: '喂奶',
  diaper: '换尿布',
  bath: '洗澡',
  sleep: '睡眠',
  weight: '体重',
  height: '身高',
  medication: '用药',
  milestone: '里程碑',
}

export default function History({ babyId }) {
  const [records, setRecords] = useState([])
  const [filter, setFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(() => getBeijingDateDaysAgo(7))
  const [dateTo, setDateTo] = useState(() => getBeijingDate())
  const [showSleepTimeRange, setShowSleepTimeRange] = useState(true)

  const load = () => {
    if (!babyId) return
    let url = `${API}/records?baby_id=${babyId}&date_from=${dateFrom}&date_to=${dateTo}`
    if (filter) url += `&type=${filter}`
    fetch(url).then(r => r.json()).then(setRecords)
  }

  useEffect(load, [babyId, filter, dateFrom, dateTo])

  useEffect(() => {
    fetch(API + '/reminder-rules')
      .then(r => r.json())
      .then(data => {
        const currentRule = Array.isArray(data) ? data[0] : null
        setShowSleepTimeRange(Number(currentRule?.show_sleep_time_range ?? 1) === 1)
      })
      .catch(() => setShowSleepTimeRange(true))
  }, [])

  if (!babyId) return null

  const types = Object.entries(TYPE_LABELS)

  return (
    <div style={styles.wrap}>
      <h2 style={styles.pageTitle}>时间线中心</h2>

      <div style={styles.filters}>
        <div style={styles.dateRow}>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            style={styles.input}
          />
          <span>至</span>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            style={styles.input}
          />
        </div>

        <div style={styles.typeRow}>
          <button
            onClick={() => setFilter('')}
            style={{ ...styles.filterBtn, ...(!filter ? styles.filterActive : {}) }}
          >
            全部
          </button>
          {types.map(([k, v]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              style={{ ...styles.filterBtn, ...(filter === k ? styles.filterActive : {}) }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <RecordList
        records={records}
        onRefresh={load}
        showSleepTimeRange={showSleepTimeRange}
      />
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  pageTitle: { fontSize: '1.15rem', fontWeight: 700, marginBottom: -4 },
  filters: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 16,
    border: '1px solid var(--border)',
  },
  dateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  input: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  typeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterBtn: {
    padding: '6px 12px',
    borderRadius: 8,
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    color: 'var(--text-muted)',
    fontSize: '0.9rem',
  },
  filterActive: {
    background: 'var(--primary)',
    color: '#fff',
    borderColor: 'var(--primary)',
  },
}
