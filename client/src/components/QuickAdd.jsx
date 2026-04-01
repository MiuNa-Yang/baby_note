import { useState } from 'react'
import { API } from '../App'
import { getBeijingNowForInput, parseDateTime } from '../utils/date'

const TYPES = [
  { type: 'feeding', label: '喂奶', icon: '🍼' },
  { type: 'ad_supplement', label: 'AD补给', icon: '🌞' },
  { type: 'sleep', label: '睡眠', icon: '😴' },
  { type: 'diaper', label: '换尿布', icon: '👶' },
  { type: 'weight', label: '体重', icon: '⚖️' },
  { type: 'height', label: '身高', icon: '📏' },
  { type: 'bath', label: '洗澡', icon: '🛁' },
  { type: 'cards', label: '黑白卡', icon: '🃏' },
  { type: 'medication', label: '用药', icon: '💊' },
  { type: 'milestone', label: '里程碑', icon: '📌' },
]

function toISOFromLocal(value) {
  if (!value) return new Date().toISOString()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function adjustMl(value, delta) {
  const current = Number(value || 0)
  const next = Math.max(0, current + delta)
  return next
}

function getDefaultFeedingAmount(records) {
  const targetTime = Date.now() - 24 * 60 * 60 * 1000
  let nearestAmount = null
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const record of records || []) {
    if (record?.type !== 'feeding' || record?.amount_ml == null) continue
    const recordTime = parseDateTime(record.created_at)?.getTime()
    if (!recordTime || Number.isNaN(recordTime)) continue
    const distance = Math.abs(recordTime - targetTime)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestAmount = Number(record.amount_ml)
    }
  }

  return nearestAmount
}

export default function QuickAdd({ babyId, onAdd, openSleep }) {
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({})
  const [toast, setToast] = useState('')
  const [expanded, setExpanded] = useState(false)

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }

  const handleSleep = () => {
    const now = new Date().toISOString()
    if (openSleep) {
      fetch(API + `/records/${openSleep.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sleep_end: now }),
      }).then(() => {
        onAdd?.()
        const start = new Date(openSleep.sleep_start)
        const end = new Date(now)
        const min = Math.round((end - start) / 60000)
        showToast(`已记录醒来，睡了 ${Math.floor(min / 60)}h${min % 60}m`)
      })
    } else {
      fetch(API + '/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baby_id: babyId,
          type: 'sleep',
          sleep_start: now,
          sleep_end: null,
        }),
      }).then(() => {
        onAdd?.()
        showToast('已记录入睡，醒来时请再点一次睡眠')
      })
    }
  }

  const quickAdd = async (type) => {
    if (type === 'sleep') {
      handleSleep()
      return
    }
    if (type === 'ad_supplement') {
      submit({
        type: 'medication',
        medicine_name: '维生素AD',
        medicine_amount: '1次',
        note: 'AD补给',
      })
      showToast('已记录 AD 补给')
      return
    }
    if (type === 'diaper') {
      submit({ type: 'diaper', stool: 1 })
      return
    }
    if (['feeding', 'medication', 'milestone', 'weight', 'height', 'diaper'].includes(type)) {
      if (type === 'feeding') {
        let defaultAmount = null
        try {
          const response = await fetch(API + `/records?baby_id=${babyId}&paged=1&page=1&page_size=100`)
          const data = await response.json()
          defaultAmount = getDefaultFeedingAmount(Array.isArray(data?.records) ? data.records : [])
        } catch {
          defaultAmount = null
        }
        setForm({ feeding_type: 'formula', feeding_time: getBeijingNowForInput(), amount_ml: defaultAmount })
      } else if (type === 'weight') {
        setForm({ weight_kg: '', weight_time: getBeijingNowForInput() })
      } else if (type === 'height') {
        setForm({ height_cm: '', height_time: getBeijingNowForInput() })
      } else {
        setForm({})
      }
      setModal(type)
      return
    }
    submit({ type })
  }

  const submit = (extra = {}) => {
    const payload = { baby_id: babyId, type: modal || extra.type, ...(modal ? form : {}), ...extra }
    if (payload.feeding_time) {
      payload.created_at = payload.created_at || toISOFromLocal(payload.feeding_time)
      delete payload.feeding_time
    }
    if (payload.weight_time) {
      payload.created_at = payload.created_at || toISOFromLocal(payload.weight_time)
      delete payload.weight_time
    }
    if (payload.height_time) {
      payload.created_at = payload.created_at || toISOFromLocal(payload.height_time)
      delete payload.height_time
    }
    if (payload.type === 'weight') {
      payload.weight_kg = payload.weight_kg === '' || payload.weight_kg == null ? null : Number(payload.weight_kg)
    }
    if (payload.type === 'height') {
      payload.height_cm = payload.height_cm === '' || payload.height_cm == null ? null : Number(payload.height_cm)
    }

    fetch(API + '/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(r => r.json())
      .then(() => {
        setModal(null)
        setForm({})
        onAdd?.()
      })
  }

  const sleepLabel = openSleep ? '醒来' : '睡眠'
  const visibleTypes = expanded
    ? TYPES
    : TYPES.filter(t => ['feeding', 'ad_supplement', 'sleep', 'diaper', 'weight', 'height'].includes(t.type))

  const openSleepManual = () => {
    setForm({
      sleep_start: getBeijingNowForInput(),
      sleep_end: '',
    })
    setModal('sleep_manual')
  }

  return (
    <>
      <div style={styles.grid}>
        {visibleTypes.map(t => (
          <button
            key={t.type}
            onClick={() => quickAdd(t.type)}
            style={{
              ...styles.btn,
              ...(t.type === 'sleep' && openSleep ? styles.btnHighlight : {}),
            }}
          >
            <span style={{ fontSize: '1.8rem' }}>{t.type === 'sleep' ? (openSleep ? '👀' : '😴') : t.icon}</span>
            <span style={{ fontSize: '0.85rem' }}>{t.type === 'sleep' ? sleepLabel : t.label}</span>
          </button>
        ))}
      </div>

      <div style={styles.toggleWrap}>
        <button type="button" onClick={() => setExpanded(v => !v)} style={styles.toggleBtn}>
          {expanded ? '收起' : '更多操作'}
        </button>
      </div>

      {expanded && (
        <div style={styles.manualLink}>
          <button type="button" onClick={openSleepManual} style={styles.manualBtn}>
            手动填写睡眠时间
          </button>
        </div>
      )}

      {toast && (
        <div style={toastStyles}>
          {toast}
        </div>
      )}

      {modal === 'feeding' && (
        <FeedingModal
          form={form}
          setForm={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => submit({ type: 'feeding' })}
        />
      )}
      {modal === 'medication' && (
        <MedicationModal
          form={form}
          setForm={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => submit({ type: 'medication' })}
        />
      )}
      {modal === 'sleep_manual' && (
        <SleepModal
          form={form}
          setForm={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => submit({ type: 'sleep' })}
        />
      )}
      {modal === 'weight' && (
        <WeightModal
          form={form}
          setForm={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => submit({ type: 'weight' })}
        />
      )}
      {modal === 'height' && (
        <HeightModal
          form={form}
          setForm={setForm}
          onClose={() => setModal(null)}
          onSubmit={() => submit({ type: 'height' })}
        />
      )}
      {modal === 'milestone' && (
        <Modal onClose={() => setModal(null)} title="记录里程碑">
          <div style={formStyles.form}>
            <label style={formStyles.label}>里程碑描述</label>
            <input
              style={formStyles.input}
              placeholder="例：第一次抬头、第一次翻身"
              value={form.note || ''}
              onChange={e => setForm({ ...form, note: e.target.value })}
            />
            <div style={formStyles.btns}>
              <button onClick={() => setModal(null)} style={formStyles.btnCancel}>取消</button>
              <button onClick={() => submit({ type: 'milestone' })} style={formStyles.btnOk}>确定</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}


function WeightModal({ form, setForm, onClose, onSubmit }) {
  return (
    <Modal onClose={onClose} title="记录体重">
      <div style={formStyles.form}>
        <label style={formStyles.label}>体重 (kg)</label>
        <input
          style={formStyles.input}
          type="number"
          step="0.01"
          placeholder="例: 6.35"
          value={form.weight_kg ?? ''}
          onChange={e => setForm({ ...form, weight_kg: e.target.value })}
        />
        <label style={formStyles.label}>记录时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.weight_time || getBeijingNowForInput()}
          onChange={e => setForm({ ...form, weight_time: e.target.value })}
        />
        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>确定</button>
        </div>
      </div>
    </Modal>
  )
}

function HeightModal({ form, setForm, onClose, onSubmit }) {
  return (
    <Modal onClose={onClose} title="记录身高">
      <div style={formStyles.form}>
        <label style={formStyles.label}>身高 (cm)</label>
        <input
          style={formStyles.input}
          type="number"
          step="0.1"
          placeholder="例: 62.5"
          value={form.height_cm ?? ''}
          onChange={e => setForm({ ...form, height_cm: e.target.value })}
        />
        <label style={formStyles.label}>记录时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.height_time || getBeijingNowForInput()}
          onChange={e => setForm({ ...form, height_time: e.target.value })}
        />
        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>确定</button>
        </div>
      </div>
    </Modal>
  )
}

function FeedingModal({ form, setForm, onClose, onSubmit }) {
  return (
    <Modal onClose={onClose} title="记录喂奶">
      <div style={formStyles.form}>
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
                step="10"
                min="0"
                placeholder="例: 90"
                value={form.amount_ml || ''}
                onChange={e => setForm({ ...form, amount_ml: e.target.value === '' ? null : Number(e.target.value) })}
              />
              <div style={formStyles.stepperCol}>
                <button
                  type="button"
                  style={formStyles.stepBtnArrowTop}
                  onClick={() => setForm({ ...form, amount_ml: adjustMl(form.amount_ml, 10) })}
                  title="+10ml"
                >
                  ▲
                </button>
                <button
                  type="button"
                  style={formStyles.stepBtnArrowBottom}
                  onClick={() => setForm({ ...form, amount_ml: adjustMl(form.amount_ml, -10) })}
                  title="-10ml"
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
              placeholder="0"
              value={form.left_minutes ?? ''}
              onChange={e => setForm({ ...form, left_minutes: e.target.value ? parseInt(e.target.value) : null })}
            />
            <label style={formStyles.label}>右乳 (分钟)</label>
            <input
              style={formStyles.input}
              type="number"
              placeholder="0"
              value={form.right_minutes ?? ''}
              onChange={e => setForm({ ...form, right_minutes: e.target.value ? parseInt(e.target.value) : null })}
            />
          </>
        )}

        <label style={formStyles.label}>喂奶时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.feeding_time || getBeijingNowForInput()}
          onChange={e => setForm({ ...form, feeding_time: e.target.value })}
        />

        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>确定</button>
        </div>
      </div>
    </Modal>
  )
}

function SleepModal({ form, setForm, onClose, onSubmit }) {
  return (
    <Modal onClose={onClose} title="手动记录睡眠">
      <div style={formStyles.form}>
        <label style={formStyles.label}>入睡时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.sleep_start || getBeijingNowForInput()}
          onChange={e => setForm({ ...form, sleep_start: e.target.value })}
        />
        <label style={formStyles.label}>醒来时间</label>
        <input
          style={formStyles.input}
          type="datetime-local"
          value={form.sleep_end || ''}
          onChange={e => setForm({ ...form, sleep_end: e.target.value })}
        />
        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>确定</button>
        </div>
      </div>
    </Modal>
  )
}

function MedicationModal({ form, setForm, onClose, onSubmit }) {
  return (
    <Modal onClose={onClose} title="记录用药">
      <div style={formStyles.form}>
        <label style={formStyles.label}>药物名称</label>
        <input
          style={formStyles.input}
          placeholder="例: 维生素D"
          value={form.medicine_name || ''}
          onChange={e => setForm({ ...form, medicine_name: e.target.value })}
        />
        <label style={formStyles.label}>用量</label>
        <input
          style={formStyles.input}
          placeholder="例: 1粒"
          value={form.medicine_amount || ''}
          onChange={e => setForm({ ...form, medicine_amount: e.target.value })}
        />
        <div style={formStyles.btns}>
          <button onClick={onClose} style={formStyles.btnCancel}>取消</button>
          <button onClick={onSubmit} style={formStyles.btnOk}>确定</button>
        </div>
      </div>
    </Modal>
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
    gap: 10,
  },
  toggleBtn: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text-muted)',
    fontSize: '1rem',
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

const toastStyles = {
  position: 'fixed',
  bottom: 100,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '12px 24px',
  background: 'var(--text)',
  color: 'var(--bg)',
  borderRadius: 12,
  fontSize: '0.95rem',
  zIndex: 1300,
  boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
  maxWidth: '90%',
}

const styles = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 12,
  },
  btn: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: '16px 8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text)',
    boxShadow: '0 2px 8px var(--shadow)',
  },
  btnHighlight: {
    borderColor: 'var(--accent)',
    background: 'rgba(133, 205, 202, 0.15)',
  },
  toggleWrap: {
    marginTop: 10,
    textAlign: 'center',
  },
  toggleBtn: {
    background: 'var(--bg-card)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    fontSize: '0.85rem',
    padding: '6px 14px',
  },
  manualLink: {
    marginTop: 12,
    textAlign: 'center',
  },
  manualBtn: {
    background: 'none',
    color: 'var(--text-muted)',
    fontSize: '0.85rem',
    textDecoration: 'underline',
    padding: 4,
  },
}

