import { useEffect, useState } from 'react'
import { API } from '../App'
import QuickAdd from '../components/QuickAdd'
import RecordList from '../components/RecordList'
import OverviewCard from '../components/OverviewCard'

export default function Home({ babyId }) {
  const [overview, setOverview] = useState(null)
  const [records, setRecords] = useState([])
  const [recordPage, setRecordPage] = useState(1)
  const [recordHasMore, setRecordHasMore] = useState(false)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const pageSize = 20

  const loadOverview = () => {
    if (!babyId) return
    fetch(API + `/overview?baby_id=${babyId}`)
      .then(r => r.json())
      .then(setOverview)
  }

  const loadRecords = (reset = false) => {
    if (!babyId || recordsLoading) return
    const nextPage = reset ? 1 : recordPage
    setRecordsLoading(true)
    fetch(API + `/records?baby_id=${babyId}&paged=1&page=${nextPage}&page_size=${pageSize}`)
      .then(r => r.json())
      .then((data) => {
        const rows = Array.isArray(data?.records) ? data.records : []
        setRecords((prev) => (reset ? rows : [...prev, ...rows]))
        setRecordHasMore(Boolean(data?.has_more))
        setRecordPage(nextPage + 1)
      })
      .finally(() => setRecordsLoading(false))
  }

  const refreshAll = () => {
    loadOverview()
    loadRecords(true)
  }

  useEffect(() => {
    if (!babyId) return
    setRecords([])
    setRecordPage(1)
    setRecordHasMore(false)
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [babyId])

  if (!babyId) return null

  const openSleep = records.find(r => r.type === 'sleep' && !r.sleep_end) || null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={styles.pageTitle}>总览中心</h1>
      <OverviewCard overview={overview} babyId={babyId} onRefresh={refreshAll} />

      <section>
        <h2 style={styles.sectionTitle}>快捷入口</h2>
        <QuickAdd babyId={babyId} onAdd={refreshAll} openSleep={openSleep} />
      </section>

      <section>
        <h2 style={styles.sectionTitle}>最新动态</h2>
        <RecordList
          babyId={babyId}
          records={records}
          onRefresh={refreshAll}
          hasMore={recordHasMore}
          loadingMore={recordsLoading}
          onLoadMore={() => loadRecords(false)}
        />
      </section>
    </div>
  )
}

const styles = {
  pageTitle: {
    fontSize: '1.15rem',
    fontWeight: 700,
    color: 'var(--text)',
    marginBottom: -4,
  },
  sectionTitle: {
    fontSize: '1rem',
    fontWeight: 600,
    marginBottom: 12,
    color: 'var(--text)',
  },
}
