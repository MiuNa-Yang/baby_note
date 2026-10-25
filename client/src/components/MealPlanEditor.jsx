import { useEffect, useState } from 'react'
import { API } from '../App'

const EMPTY_ITEM = { name: '', amount: '', unit: 'g' }

export default function MealPlanEditor({ babyId, date }) {
  const [items, setItems] = useState([{ ...EMPTY_ITEM }])
  const [note, setNote] = useState('')
  const [exists, setExists] = useState(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')

  const load = () => {
    if (!babyId || !date) return
    setStatus('loading')
    setError('')
    fetch(`${API}/meal-plans?baby_id=${babyId}&from=${date}&to=${date}`)
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || '计划加载失败')
        const plan = Array.isArray(data) ? data[0] : null
        setExists(Boolean(plan))
        setItems(plan?.items?.length ? plan.items.map(item => ({
          name: item.name || '',
          amount: item.amount ?? item.grams ?? '',
          unit: item.unit || (item.grams != null ? 'g' : 'g'),
        })) : [{ ...EMPTY_ITEM }])
        setNote(plan?.note || '')
        setStatus('idle')
      })
      .catch(loadError => {
        setError(loadError.message || '计划加载失败')
        setStatus('error')
      })
  }

  useEffect(load, [babyId, date]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateItem = (index, patch) => {
    setItems(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  }

  const save = () => {
    const normalized = items.filter(item => item.name.trim())
    if (!normalized.length || normalized.some(item => !Number(item.amount) || Number(item.amount) <= 0)) {
      setError('请填写至少一种食物及用量')
      return
    }
    setStatus('saving')
    setError('')
    fetch(`${API}/meal-plans/${date}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baby_id: babyId,
        items: normalized.map(item => ({ ...item, amount: Number(item.amount) })),
        note,
      }),
    })
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || '保存失败')
        setExists(true)
        setItems(data.items.map(item => ({
          name: item.name,
          amount: item.amount ?? item.grams,
          unit: item.unit || 'g',
        })))
        setStatus('saved')
        setTimeout(() => setStatus('idle'), 1600)
      })
      .catch(saveError => {
        setError(saveError.message || '保存失败')
        setStatus('error')
      })
  }

  const clear = () => {
    if (!exists || !window.confirm(`清除 ${date} 的辅食计划？`)) return
    setStatus('saving')
    fetch(`${API}/meal-plans/${date}?baby_id=${babyId}`, { method: 'DELETE' })
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || '清除失败')
        setExists(false)
        setItems([{ ...EMPTY_ITEM }])
        setNote('')
        setStatus('idle')
      })
      .catch(clearError => {
        setError(clearError.message || '清除失败')
        setStatus('error')
      })
  }

  return (
    <section style={styles.wrap}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>当天辅食计划</h3>
          <p style={styles.hint}>{date} · 每日提醒会读取这里的内容</p>
        </div>
        <span style={{ ...styles.state, ...(exists ? styles.stateReady : {}) }}>
          {status === 'loading' ? '读取中' : exists ? '已设置' : '未设置'}
        </span>
      </div>

      <div style={styles.rows}>
        {items.map((item, index) => (
          <div key={index} style={styles.row}>
            <input
              value={item.name}
              onChange={event => updateItem(index, { name: event.target.value })}
              placeholder="食物，例如南瓜"
              style={{ ...styles.input, flex: 1 }}
            />
            <input
              type="number"
              min="0.01"
              step="0.1"
              value={item.amount}
              onChange={event => updateItem(index, { amount: event.target.value })}
              placeholder="用量"
              style={styles.amount}
            />
            <select value={item.unit} onChange={event => updateItem(index, { unit: event.target.value })} style={styles.unit}>
              {['g', 'ml', '勺', '个', '份'].map(unit => <option key={unit}>{unit}</option>)}
            </select>
            <button
              type="button"
              aria-label="删除这项食物"
              onClick={() => setItems(current => current.length === 1 ? [{ ...EMPTY_ITEM }] : current.filter((_, itemIndex) => itemIndex !== index))}
              style={styles.remove}
            >×</button>
          </div>
        ))}
      </div>

      <button type="button" onClick={() => setItems(current => [...current, { ...EMPTY_ITEM }])} style={styles.add}>＋ 添加食物</button>
      <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="备注，例如：蛋黄试敏第 1 天" rows={2} style={styles.note} />

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.actions}>
        {exists && <button type="button" onClick={clear} disabled={status === 'saving'} style={styles.clear}>清除计划</button>}
        <button type="button" onClick={save} disabled={status === 'saving' || status === 'loading'} style={styles.save}>
          {status === 'saving' ? '保存中…' : status === 'saved' ? '已保存 ✓' : '保存当天计划'}
        </button>
      </div>
    </section>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: '1rem', fontWeight: 700 },
  hint: { marginTop: 3, color: 'var(--text-muted)', fontSize: '0.76rem' },
  state: { padding: '5px 8px', borderRadius: 999, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', fontSize: '0.72rem', transition: 'all .2s ease' },
  stateReady: { color: 'var(--primary)', borderColor: 'color-mix(in srgb, var(--primary) 35%, var(--border))' },
  rows: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 7 },
  input: { minWidth: 0, padding: '9px 10px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' },
  amount: { width: 78, minWidth: 0, padding: '9px 8px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' },
  unit: { width: 64, padding: '9px 6px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' },
  remove: { width: 34, minWidth: 34, minHeight: 36, color: 'var(--text-muted)', background: 'transparent', borderRadius: 8 },
  add: { alignSelf: 'flex-start', color: 'var(--primary)', fontSize: '0.8rem', padding: '4px 0' },
  note: { width: '100%', resize: 'vertical', padding: '10px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit' },
  error: { color: 'var(--danger, #c94b45)', fontSize: '0.78rem' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
  clear: { padding: '9px 12px', color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 9 },
  save: { minWidth: 126, padding: '9px 13px', color: '#fff', background: 'var(--primary)', borderRadius: 9, fontWeight: 600, transition: 'transform .15s ease, opacity .15s ease' },
}
