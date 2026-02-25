import { useState } from 'react'
import { API } from '../App'
import { formatTime, getBeijingDate, getBeijingNowForInput, parseDateTime, toDateTimeLocal } from '../utils/date'

const TYPE_LABELS = {
  feeding: { label: '喂奶', icon: '🍼' },
  weight: { label: '体重', icon: '⚖️' },
  height: { label: '身高', icon: '📏' },
  diaper: { label: '换尿布', icon: '👶' },
  bath: { label: '洗澡', icon: '🛁' },
  cards: { label: '黑白卡', icon: '🃏' },
  sleep: { label: '睡眠', icon: '😴' },
  medication: { label: '用药', icon: '💊' },
  milestone: { label: '里程碑', icon: '📌' },
}

function formatDetail(r) {
  const parts = []
  if (r.type === 'feeding') {
    if (r.amount_ml) parts.push(`${r.amount_ml}ml`)
    if (r.left_minutes || r.right_minutes) {
      parts.push(`左${r.left_minutes || 0}分 右${r.right_minutes || 0}分`)
    }
  }
  if (r.type === 'diaper') {
    parts.push(Number(r.stool || 0) === 1 ? '有大便' : '无大便')
  }
  if (r.type === 'sleep') {
    if (r.sleep_start && r.sleep_end) {
      const s = new Date(r.sleep_start).getTime()
      const e = new Date(r.sleep_end).getTime()
      const min = Math.round((e - s) / 60000)
      parts.push(`${Math.floor(min / 60)}小时${min % 60}分`)
    } else if (r.sleep_start) {
      parts.push('睡眠中')
    }
  }
  if (r.type === 'medication') {
    if (r.medicine_name) parts.push(r.medicine_name)
    if (r.medicine_amount) parts.push(r.medicine_amount)
  }
  if (r.type === 'weight' && r.weight_kg != null) {
    parts.push(`${Number(r.weight_kg).toFixed(2)} kg`)
  }
  if (r.type === 'height' && r.height_cm != null) {
    parts.push(`${Number(r.height_cm).toFixed(1)} cm`)
  }
  return parts.join(' · ')
}

function parseRecordTimeMs(value) {
  const d = parseDateTime(value)
  if (!d || Number.isNaN(d.getTime())) return 0
  return d.getTime()
}

function formatDayLabel(dateStr, today) {
  if (!dateStr) return ''
  if (dateStr === today) return '今天'
  return dateStr.slice(5).replace('-', '/')
}

function toISOFromLocal(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function adjustMl(value, delta) {
  const current = Number(value || 0)
  const next = Math.max(0, current + delta)
  return next
}

function makeEditForm(record) {
  return {
    type: record.type,
    created_at: toDateTimeLocal(record.created_at) || getBeijingNowForInput(),
    feeding_type: record.feeding_type || 'formula',
    amount_ml: record.amount_ml ?? '',
    left_minutes: record.left_minutes ?? '',
    right_minutes: record.right_minutes ?? '',
    sleep_start: record.sleep_start ? toDateTimeLocal(record.sleep_start) : '',
    sleep_end: record.sleep_end ? toDateTimeLocal(record.sleep_end) : '',
    stool: record.stool ?? 0,
    medicine_name: record.medicine_name || '',
    medicine_amount: record.medicine_amount || '',
    weight_kg: record.weight_kg ?? '',
    height_cm: record.height_cm ?? '',
  }
}

function EditRecordModal({ record, form, setForm, onClose, onSubmit }) {
  if (!record) return null

  return (
    <Modal onClose={onClose} title={`编辑${TYPE_LABELS[record.type]?.label || '记录'}`}>
      <div style={formStyles.form}>
        <label style={formStyles.label}>记录时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.created_at || getBeijingNowForInput()}
          onChange={e => setForm({ ...form, created_at: e.target.value })}
        />

        {record.type === 'feeding' && (
          <>
            <label style={formStyles.label}>喂养方式</label>
            <select
              style={formStyles.select}
              value={form.feeding_type || 'formula'}
              onChange={e => setForm({ ...form, feeding_type: e.target.value })}
            >
              <option value="breast">母乳</option>
              <option value="formula">奶粉</option>
              <option value="mixed">混合</option>
            </select>

            {(form.feeding_type === 'formula' || form.feeding_type === 'mixed') && (
              <>
                <label style={formStyles.label}>奶粉量 (ml)</label>
                <div style={formStyles.stepperRow}>
                  <input
                    style={{ ...formStyles.input, margin: 0 }}
                    type="number"
                    step="30"
                    min="0"
                    placeholder="例: 90"
                    value={form.amount_ml}
                    onChange={e => setForm({ ...form, amount_ml: e.target.value })}
                  />
                  <div style={formStyles.stepperCol}>
                    <button
                      type="button"
                      style={formStyles.stepBtnArrowTop}
                      onClick={() => setForm({ ...form, amount_ml: adjustMl(form.amount_ml, 30) })}
                      title="+30ml"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      style={formStyles.stepBtnArrowBottom}
                      onClick={() => setForm({ ...form, amount_ml: adjustMl(form.amount_ml, -30) })}
                      title="-30ml"
                    >
                      ▼
                    </button>
                  </div>
                </div>
              </>
            )}

            {(form.feeding_type === 'breast' || form.feeding_type === 'mixed') && (
              <>
                <label style={formStyles.label}>左乳 (分钟)</label>
                <input
                  style={formStyles.input}
                  type="number"
                  value={form.left_minutes}
                  onChange={e => setForm({ ...form, left_minutes: e.target.value })}
                />

                <label style={formStyles.label}>右乳 (分钟)</label>
                <input
                  style={formStyles.input}
                  type="number"
                  value={form.right_minutes}
                  onChange={e => setForm({ ...form, right_minutes: e.target.value })}
                />
              </>
            )}
          </>
        )}

        {record.type === 'sleep' && (
          <>
            <label style={formStyles.label}>入睡时间</label>
            <input
              style={formStyles.input}
              type="datetime-local"
              value={form.sleep_start || ''}
              onChange={e => setForm({ ...form, sleep_start: e.target.value })}
            />
            <label style={formStyles.label}>醒来时间</label>
            <input
              style={formStyles.input}
              type="datetime-local"
              value={form.sleep_end || ''}
              onChange={e => setForm({ ...form, sleep_end: e.target.value })}
            />
          </>
        )}

        {record.type === 'medication' && (
          <>
            <label style={formStyles.label}>药物名称</label>
            <input
              style={formStyles.input}
              value={form.medicine_name || ''}
              onChange={e => setForm({ ...form, medicine_name: e.target.value })}
            />
            <label style={formStyles.label}>用量</label>
            <input
              style={formStyles.input}
              value={form.medicine_amount || ''}
              onChange={e => setForm({ ...form, medicine_amount: e.target.value })}
            />
          </>
        )}

        {record.type === 'diaper' && (
          <>
            <label style={formStyles.label}>是否有大便</label>
            <div style={formStyles.toggleRow}>
              <button
                type="button"
                style={{ ...formStyles.toggleBtn, ...(Number(form.stool || 0) === 1 ? formStyles.toggleActive : {}) }}
                onClick={() => setForm({ ...form, stool: 1 })}
              >
                有大便
              </button>
              <button
                type="button"
                style={{ ...formStyles.toggleBtn, ...(Number(form.stool || 0) !== 1 ? formStyles.toggleActive : {}) }}
                onClick={() => setForm({ ...form, stool: 0 })}
              >
                无大便
              </button>
            </div>
          </>
        )}

        {record.type === 'weight' && (
          <>
            <label style={formStyles.label}>体重 (kg)</label>
            <input
              style={formStyles.input}
              type="number"
              step="0.01"
              value={form.weight_kg ?? ''}
              onChange={e => setForm({ ...form, weight_kg: e.target.value })}
            />
          </>
        )}

        {record.type === 'height' && (
          <>
            <label style={formStyles.label}>身高 (cm)</label>
            <input
              style={formStyles.input}
              type="number"
              step="0.1"
              value={form.height_cm ?? ''}
              onChange={e => setForm({ ...form, height_cm: e.target.value })}
            />
          </>
        )}

        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>保存修改</button>
        </div>
      </div>
    </Modal>
  )
}

export default function RecordList({ records, onRefresh, hasMore = false, loadingMore = false, onLoadMore = null }) {
  const [editing, setEditing] = useState(null)
  const [editForm, setEditForm] = useState({})

  const handleDelete = (id) => {
    if (!confirm('确定删除这条记录？')) return
    fetch(API + `/records/${id}`, { method: 'DELETE' })
      .then(() => onRefresh?.())
  }

  const openEdit = (record) => {
    setEditing(record)
    setEditForm(makeEditForm(record))
  }

  const saveEdit = () => {
    if (!editing) return

    const payload = {
      created_at: toISOFromLocal(editForm.created_at),
    }

    if (editing.type === 'feeding') {
      payload.feeding_type = editForm.feeding_type || null
      payload.amount_ml = editForm.amount_ml === '' ? null : Number(editForm.amount_ml)
      payload.left_minutes = editForm.left_minutes === '' ? null : Number(editForm.left_minutes)
      payload.right_minutes = editForm.right_minutes === '' ? null : Number(editForm.right_minutes)
    }

    if (editing.type === 'sleep') {
      payload.sleep_start = editForm.sleep_start ? toISOFromLocal(editForm.sleep_start) : null
      payload.sleep_end = editForm.sleep_end ? toISOFromLocal(editForm.sleep_end) : null
    }

    if (editing.type === 'medication') {
      payload.medicine_name = editForm.medicine_name || null
      payload.medicine_amount = editForm.medicine_amount || null
    }
    if (editing.type === 'diaper') {
      payload.stool = Number(editForm.stool || 0) ? 1 : 0
    }

    if (editing.type === 'weight') {
      payload.weight_kg = editForm.weight_kg === '' || editForm.weight_kg == null
        ? null
        : Number(editForm.weight_kg)
    }
    if (editing.type === 'height') {
      payload.height_cm = editForm.height_cm === '' || editForm.height_cm == null
        ? null
        : Number(editForm.height_cm)
    }

    fetch(API + `/records/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.json())
      .then(() => {
        setEditing(null)
        setEditForm({})
        onRefresh?.()
      })
  }

  if (!records?.length) {
    return (
      <div style={styles.empty}>
        <span style={{ color: 'var(--text-muted)' }}>暂无记录</span>
      </div>
    )
  }

  const sortedRecords = [...records].sort((a, b) => parseRecordTimeMs(b.created_at) - parseRecordTimeMs(a.created_at))
  const today = getBeijingDate()
  const rows = []
  let lastDate = null
  for (const r of sortedRecords) {
    const d = parseDateTime(r.created_at)
    const dateKey = d && !Number.isNaN(d.getTime()) ? getBeijingDate(d) : ''
    if (dateKey && dateKey !== lastDate) {
      rows.push({ kind: 'divider', dateKey })
      lastDate = dateKey
    }
    rows.push({ kind: 'record', record: r })
  }

  return (
    <>
      <div style={styles.list}>
        {rows.map((row, rowIndex) => {
          if (row.kind === 'divider') {
            return (
              <div key={`divider-${row.dateKey}-${rowIndex}`} style={styles.dayDivider}>
                <span style={styles.dayDividerText}>{formatDayLabel(row.dateKey, today)}</span>
              </div>
            )
          }

          const r = row.record
          const meta = TYPE_LABELS[r.type] || { label: r.type, icon: '📝' }
          const detail = formatDetail(r)
          return (
            <div key={r.id} style={styles.item}>
              <span style={styles.icon}>{meta.icon}</span>
              <div style={styles.content}>
                <div style={styles.row}>
                  <span style={styles.title}>{meta.label}</span>
                </div>
                {detail && <div style={styles.detail}>{detail}</div>}
                {r.note && <div style={styles.note}>{r.note}</div>}
              </div>

              <div style={styles.side}>
                <span style={styles.time}>{formatTime(r.created_at)}</span>
                <div style={styles.actions}>
                  <button onClick={() => openEdit(r)} style={styles.editBtn} title="编辑">✏️</button>
                  <button onClick={() => handleDelete(r.id)} style={styles.delBtn} title="删除">🗑️</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {onLoadMore && (
        <div style={styles.loadMoreWrap}>
          <button
            type="button"
            style={styles.loadMoreBtn}
            onClick={onLoadMore}
            disabled={loadingMore || !hasMore}
          >
            {loadingMore ? '加载中...' : hasMore ? '加载更多' : '没有更多了'}
          </button>
        </div>
      )}

      <EditRecordModal
        record={editing}
        form={editForm}
        setForm={setEditForm}
        onClose={() => setEditing(null)}
        onSubmit={saveEdit}
      />
    </>
  )
}

function Modal({ title, children, onClose }) {
  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.box} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <h3 style={modalStyles.title}>{title}</h3>
          <button onClick={onClose} style={modalStyles.close} aria-label="关闭">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const modalStyles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(45, 42, 38, 0.4)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    zIndex: 2000,
  },
  box: {
    background: 'var(--bg-card)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    width: '100%',
    maxWidth: 480,
    maxHeight: '85vh',
    overflow: 'auto',
    boxShadow: '0 -8px 32px var(--shadow)',
    border: '1px solid var(--border)',
    borderBottom: 'none',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '20px 24px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: '1.15rem',
    fontWeight: 600,
  },
  close: {
    background: 'var(--bg)',
    width: 36,
    height: 36,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: '1.1rem',
  },
}

const formStyles = {
  form: {
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  label: {
    fontSize: '0.9rem',
    fontWeight: 500,
    color: 'var(--text-muted)',
    marginBottom: -8,
  },
  input: {
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '1rem',
  },
  stepperRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 38px',
    gap: 8,
    alignItems: 'center',
  },
  stepperCol: {
    height: 48,
    display: 'grid',
    gridTemplateRows: '1fr 1fr',
    gap: 4,
  },
  stepBtnArrowTop: {
    borderRadius: '10px 10px 6px 6px',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '0.72rem',
    lineHeight: 1,
    fontWeight: 600,
    minHeight: 0,
    minWidth: 0,
    padding: 0,
  },
  stepBtnArrowBottom: {
    borderRadius: '6px 6px 10px 10px',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '0.72rem',
    lineHeight: 1,
    fontWeight: 600,
    minHeight: 0,
    minWidth: 0,
    padding: 0,
  },
  select: {
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '1rem',
    cursor: 'pointer',
  },
  toggleRow: {
    display: 'flex',
    gap: 8,
    marginTop: 2,
  },
  toggleBtn: {
    flex: 1,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text-muted)',
  },
  toggleActive: {
    background: 'var(--primary)',
    borderColor: 'var(--primary)',
    color: '#fff',
  },
  btns: {
    display: 'flex',
    gap: 12,
    marginTop: 8,
  },
  btnCancel: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text-muted)',
    fontSize: '1rem',
  },
  btnOk: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    background: 'var(--primary)',
    color: '#fff',
    fontSize: '1rem',
    fontWeight: 500,
  },
}

const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  dayDivider: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '4px 0 -2px',
  },
  dayDividerText: {
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    padding: '2px 8px',
    lineHeight: 1.2,
  },
  empty: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 32,
    textAlign: 'center',
    border: '1px dashed var(--border)',
  },
  item: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 12,
    background: 'var(--bg-card)',
    borderRadius: 12,
    padding: '10px 12px',
    border: '1px solid var(--border)',
  },
  icon: { fontSize: '1.5rem', marginTop: 2, alignSelf: 'center' },
  content: { flex: 1, minWidth: 0 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontWeight: 600 },
  side: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'stretch',
    marginLeft: 4,
    whiteSpace: 'nowrap',
    width: 108,
    justifyContent: 'flex-end',
  },
  time: {
    color: 'var(--text-muted)',
    fontSize: '0.88rem',
    minWidth: 42,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    fontFeatureSettings: '"tnum"',
  },
  detail: { fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 },
  note: { fontSize: '0.85rem', marginTop: 4 },
  actions: { display: 'flex', flexDirection: 'row', gap: 6 },
  editBtn: { background: 'var(--bg)', padding: '4px 6px', opacity: 0.9, borderRadius: 8, border: '1px solid var(--border)' },
  delBtn: { background: 'var(--bg)', padding: '4px 6px', opacity: 0.8, borderRadius: 8, border: '1px solid var(--border)' },
  loadMoreWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginTop: 2,
  },
  loadMoreBtn: {
    padding: '7px 14px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text-muted)',
    fontSize: '0.86rem',
  },
}

