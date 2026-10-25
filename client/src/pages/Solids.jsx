import { useEffect, useMemo, useState } from 'react'
import { API } from '../App'
import RecordList from '../components/RecordList'
import SolidMealFields, { buildSolidMealPayload, createSolidMealForm } from '../components/SolidMealFields'
import MealPlanEditor from '../components/MealPlanEditor'
import { getBeijingDate, parseDateTime } from '../utils/date'

const STATUS_FILTERS = [
  ['all', '全部'],
  ['unknown', '未尝试 / 待判断'],
  ['no_reaction', '暂无异常'],
  ['suspected', '疑似异常'],
  ['confirmed', '人工标记'],
]

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function formatMonth(month) {
  const [year, monthNumber] = month.split('-')
  return `${year}年${Number(monthNumber)}月`
}

function buildCalendarDays(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthNumber - 1, 1))
  const offset = (first.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const total = Math.ceil((offset + daysInMonth) / 7) * 7
  return Array.from({ length: total }, (_, index) => {
    const dayNumber = index - offset + 1
    if (dayNumber < 1 || dayNumber > daysInMonth) return null
    return `${month}-${String(dayNumber).padStart(2, '0')}`
  })
}

function formatDateTime(value) {
  if (!value) return '--'
  const date = parseDateTime(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function mealStats(meals) {
  const items = meals.flatMap(meal => Array.isArray(meal.solid_items) ? meal.solid_items : [])
  return {
    meals: meals.length,
    foods: items.length,
    grams: Math.round(items.reduce((sum, item) => sum + Number(item.grams || 0), 0) * 10) / 10,
    abnormal: meals.filter(meal => (meal.reaction_types || []).length > 0).length,
  }
}

export default function Solids({ babyId }) {
  const today = getBeijingDate()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [selectedDate, setSelectedDate] = useState(today)
  const [days, setDays] = useState([])
  const [foods, setFoods] = useState([])
  const [meals, setMeals] = useState([])
  const [statusFilter, setStatusFilter] = useState('all')
  const [showAdd, setShowAdd] = useState(false)
  const [mealForm, setMealForm] = useState(createSolidMealForm())
  const [loading, setLoading] = useState(false)

  const loadFoodsAndSummary = () => {
    if (!babyId) return Promise.resolve()
    return Promise.all([
      fetch(`${API}/solid-foods?baby_id=${babyId}`).then(r => r.json()),
      fetch(`${API}/solid-summary?baby_id=${babyId}&month=${month}`).then(r => r.json()),
    ]).then(([foodData, summaryData]) => {
      setFoods(Array.isArray(foodData) ? foodData : [])
      setDays(Array.isArray(summaryData?.days) ? summaryData.days : [])
    })
  }

  const loadMeals = () => {
    if (!babyId || !selectedDate) return Promise.resolve()
    return fetch(`${API}/solid-meals?baby_id=${babyId}&date_from=${selectedDate}&date_to=${selectedDate}`)
      .then(r => r.json())
      .then(data => setMeals(Array.isArray(data) ? data : []))
  }

  const reload = () => {
    setLoading(true)
    return Promise.all([loadFoodsAndSummary(), loadMeals()]).finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!babyId) return
    if (!selectedDate.startsWith(month)) setSelectedDate(`${month}-01`)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [babyId, month, selectedDate])

  const calendarDays = buildCalendarDays(month)
  const summaryByDate = Object.fromEntries(days.map(day => [day.date, day]))
  const stats = mealStats(meals)
  const filteredFoods = foods.filter(food => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'confirmed') return food.status_source === 'manual'
    return food.status === statusFilter
  })

  const saveMeal = () => {
    const payload = buildSolidMealPayload(mealForm)
    fetch(API + '/solid-meals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baby_id: babyId, ...payload }),
    })
      .then(r => r.json())
      .then(data => {
        if (data?.error) throw new Error(data.error)
        setShowAdd(false)
        setMealForm(createSolidMealForm())
        reload()
      })
      .catch(error => window.alert(error.message || '保存失败'))
  }

  const updateFoodStatus = (food, status) => {
    fetch(`${API}/solid-foods/${food.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manual_status: status }),
    }).then(() => loadFoodsAndSummary())
  }

  const selectedDayLabel = selectedDate === today ? '今天' : selectedDate

  return (
    <div style={styles.wrap}>
      <div style={styles.pageHeader}>
        <div>
          <h2 style={styles.title}>辅食记录</h2>
          <p style={styles.subtitle}>记录每一口，也把反应留在时间线上。</p>
        </div>
        <button type="button" style={styles.primaryBtn} onClick={() => { setMealForm(createSolidMealForm()); setShowAdd(true) }}>＋ 记录辅食</button>
      </div>

      <section style={styles.calendarSection}>
        <div style={styles.calendarHeader}>
          <button type="button" style={styles.iconBtn} onClick={() => setMonth(value => shiftMonth(value, -1))}>‹</button>
          <strong>{formatMonth(month)}</strong>
          <button type="button" style={styles.iconBtn} onClick={() => setMonth(value => shiftMonth(value, 1))}>›</button>
        </div>
        <div style={styles.weekHeader}>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
        <div style={styles.calendarGrid}>
          {calendarDays.map((date, index) => {
            const summary = date ? summaryByDate[date] : null
            const selected = date === selectedDate
            return (
              <button
                type="button"
                key={date || `empty-${index}`}
                disabled={!date}
                onClick={() => date && setSelectedDate(date)}
                style={{ ...styles.day, ...(selected ? styles.daySelected : {}), ...(summary ? styles.dayWithRecord : {}) }}
              >
                {date && <><span>{Number(date.slice(-2))}</span>{summary && <i style={styles.dayDot} />}</>}
              </button>
            )
          })}
        </div>
      </section>

      <section style={styles.daySection}>
        <div style={styles.sectionHeader}>
          <div>
            <h3 style={styles.sectionTitle}>{selectedDayLabel} · 当天明细</h3>
            <span style={styles.muted}>{selectedDate}</span>
          </div>
          {loading && <span style={styles.muted}>加载中…</span>}
        </div>
        <MealPlanEditor babyId={babyId} date={selectedDate} />
        <div style={styles.statStrip}>
          <div><strong>{stats.meals}</strong><span>餐次</span></div>
          <div><strong>{stats.foods}</strong><span>食物种类</span></div>
          <div><strong>{stats.grams}</strong><span>总克数</span></div>
          <div><strong>{stats.abnormal}</strong><span>异常餐次</span></div>
        </div>
        <RecordList records={meals} onRefresh={loadMeals} showSleepTimeRange />
      </section>

      <section style={styles.foodSection}>
        <div style={styles.sectionHeader}>
          <div>
            <h3 style={styles.sectionTitle}>食物状态总览</h3>
            <span style={styles.muted}>状态用于观察记录，不替代医学诊断。</span>
          </div>
        </div>
        <div style={styles.filterRow}>
          {STATUS_FILTERS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setStatusFilter(key)} style={{ ...styles.filterBtn, ...(statusFilter === key ? styles.filterActive : {}) }}>{label}</button>
          ))}
        </div>
        <div style={styles.foodGrid}>
          {filteredFoods.map(food => (
            <div key={food.id} style={styles.foodItem}>
              <div style={styles.foodTopline}>
                <div>
                  <strong>{food.name}</strong>
                  <span style={styles.category}>{food.category}{food.allergen_group ? ` · ${food.allergen_group}` : ''}</span>
                </div>
                <span style={{ ...styles.statusTag, ...(food.status === 'suspected' || food.status === 'confirmed_allergy' ? styles.statusWarn : {}) }}>{food.status_label}</span>
              </div>
              <div style={styles.foodMeta}>{food.attempts ? `尝试 ${food.attempts} 次 · 最近 ${formatDateTime(food.last_tried_at)} · ${food.total_grams}g` : '还没有记录尝试'}</div>
              {food.latest_reactions?.length > 0 && <div style={styles.reactionText}>最近反应：{food.latest_reactions.join('、')}</div>}
              {food.status_source === 'manual' && <div style={styles.sourceText}>人工标记 · 仍保留记录中的反应证据</div>}
              <div style={styles.foodActions}>
                <button type="button" onClick={() => updateFoodStatus(food, 'confirmed_safe')}>标为无异常</button>
                <button type="button" onClick={() => updateFoodStatus(food, 'confirmed_allergy')}>标为过敏</button>
                {food.status_source === 'manual' && <button type="button" onClick={() => updateFoodStatus(food, null)}>清除标记</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {showAdd && (
        <div style={styles.overlay} onClick={() => setShowAdd(false)}>
          <div style={styles.modal} onClick={event => event.stopPropagation()}>
            <div style={styles.modalHeader}><strong>记录辅食</strong><button type="button" style={styles.iconBtn} onClick={() => setShowAdd(false)}>×</button></div>
            <SolidMealFields babyId={babyId} form={mealForm} setForm={setMealForm} />
            <div style={styles.modalActions}><button type="button" style={styles.secondaryBtn} onClick={() => setShowAdd(false)}>取消</button><button type="button" style={styles.primaryBtn} onClick={saveMeal}>保存辅食</button></div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16 },
  pageHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: '1.2rem', fontWeight: 700 },
  subtitle: { marginTop: 4, color: 'var(--text-muted)', fontSize: '0.82rem' },
  primaryBtn: { padding: '10px 14px', borderRadius: 10, background: 'var(--primary)', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' },
  secondaryBtn: { padding: '10px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)' },
  calendarSection: { background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', padding: '4px 2px 12px' },
  calendarHeader: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '4px 0 12px' },
  iconBtn: { width: 36, minWidth: 36, minHeight: 36, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '1.2rem' },
  weekHeader: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.72rem', paddingBottom: 5 },
  calendarGrid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 },
  day: { minHeight: 42, borderRadius: 10, background: 'transparent', color: 'var(--text)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: '0.86rem' },
  daySelected: { background: 'var(--primary)', color: '#fff', fontWeight: 700 },
  dayWithRecord: { border: '1px solid var(--primary)' },
  dayDot: { width: 5, height: 5, borderRadius: 99, background: 'var(--accent)' },
  daySection: { display: 'flex', flexDirection: 'column', gap: 12 },
  foodSection: { display: 'flex', flexDirection: 'column', gap: 12 },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { fontSize: '1rem', fontWeight: 700 },
  muted: { color: 'var(--text-muted)', fontSize: '0.78rem' },
  statStrip: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '12px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' },
  filterRow: { display: 'flex', gap: 7, flexWrap: 'wrap' },
  filterBtn: { padding: '7px 10px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: '0.77rem' },
  filterActive: { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' },
  foodGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 },
  foodItem: { padding: 13, borderBottom: '1px solid var(--border)', background: 'var(--bg-card)' },
  foodTopline: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  category: { display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: 2 },
  statusTag: { borderRadius: 999, padding: '3px 7px', background: 'rgba(133,205,202,0.18)', color: 'var(--primary-dark)', fontSize: '0.68rem', whiteSpace: 'nowrap' },
  statusWarn: { background: 'rgba(224,122,95,0.15)', color: 'var(--danger)' },
  foodMeta: { marginTop: 8, color: 'var(--text-muted)', fontSize: '0.78rem' },
  reactionText: { marginTop: 5, color: 'var(--danger)', fontSize: '0.78rem' },
  sourceText: { marginTop: 5, color: 'var(--text-muted)', fontSize: '0.72rem' },
  foodActions: { display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(45,42,38,0.42)', zIndex: 2000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'auto', background: 'var(--bg-card)', borderRadius: '22px 22px 0 0', border: '1px solid var(--border)' },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid var(--border)' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '0 24px 24px' },
}
