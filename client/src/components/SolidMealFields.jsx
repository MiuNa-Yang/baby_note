import { useEffect, useMemo, useState } from 'react'
import { API } from '../App'
import { getBeijingNowForInput, toDateTimeLocal } from '../utils/date'

export const SOLID_REACTIONS = [
  { key: 'vomiting', label: '呕吐' },
  { key: 'diarrhea', label: '腹泻' },
  { key: 'constipation', label: '便秘' },
  { key: 'perioral_rash', label: '嘴周红疹' },
  { key: 'generalized_rash', label: '全身红疹' },
  { key: 'bloating_abdominal_pain', label: '腹胀/腹痛' },
  { key: 'other', label: '其他' },
]

export function createSolidMealForm(record = null) {
  const items = record
    ? parseArray(record.solid_items_json ?? record.solid_items).map(item => ({
      food_id: item.food_id ?? '',
      name: item.name || '',
      grams: item.grams ?? '',
    }))
    : [{ food_id: '', name: '', grams: '' }]
  return {
    eaten_at: record?.created_at ? toDateTimeLocal(record.created_at) : getBeijingNowForInput(),
    items: items.length ? items : [{ food_id: '', name: '', grams: '' }],
    reaction_types: parseArray(record?.reaction_types_json ?? record?.reaction_types),
    reaction_note: record?.reaction_note || '',
    suspected_food_ids: parseArray(record?.suspected_food_ids_json ?? record?.suspected_food_ids).map(Number),
    note: record?.note || '',
  }
}

export function buildSolidMealPayload(form) {
  return {
    eaten_at: form.eaten_at,
    items: form.items.map(item => ({
      food_id: item.food_id || undefined,
      name: item.name,
      grams: item.grams,
    })),
    reaction_types: form.reaction_types || [],
    reaction_note: form.reaction_note || '',
    suspected_food_ids: form.suspected_food_ids || [],
    note: form.note || '',
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default function SolidMealFields({ babyId, form, setForm }) {
  const [foods, setFoods] = useState([])

  useEffect(() => {
    if (!babyId) return
    fetch(`${API}/solid-foods?baby_id=${babyId}`)
      .then(response => response.json())
      .then(data => setFoods(Array.isArray(data) ? data : []))
      .catch(() => setFoods([]))
  }, [babyId])

  const foodOptions = useMemo(() => foods.map(food => `${food.name} · ${food.category}`), [foods])
  const updateItem = (index, patch) => {
    setForm(prev => ({
      ...prev,
      items: prev.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }
  const chooseFood = (index, value) => {
    const matched = foods.find(food => food.name === value || `${food.name} · ${food.category}` === value)
    updateItem(index, { name: matched?.name || value, food_id: matched?.id || '' })
  }
  const addItem = () => setForm(prev => ({
    ...prev,
    items: [...prev.items, { food_id: '', name: '', grams: '' }],
  }))
  const removeItem = (index) => setForm(prev => ({
    ...prev,
    items: prev.items.length <= 1 ? prev.items : prev.items.filter((_, itemIndex) => itemIndex !== index),
    suspected_food_ids: prev.suspected_food_ids.filter(id => id !== Number(prev.items[index]?.food_id)),
  }))
  const toggleReaction = (key) => setForm(prev => {
    const current = new Set(prev.reaction_types || [])
    if (current.has(key)) current.delete(key)
    else current.add(key)
    return { ...prev, reaction_types: [...current] }
  })
  const toggleSuspectedFood = (foodId) => setForm(prev => {
    const id = Number(foodId)
    const current = new Set(prev.suspected_food_ids || [])
    if (current.has(id)) current.delete(id)
    else current.add(id)
    return { ...prev, suspected_food_ids: [...current] }
  })
  const hasReaction = (form.reaction_types || []).length > 0

  return (
    <div style={styles.form}>
      <label style={styles.label}>进食时间</label>
      <input
        style={styles.input}
        type="datetime-local"
        value={form.eaten_at || getBeijingNowForInput()}
        onChange={e => setForm({ ...form, eaten_at: e.target.value })}
      />

      <div style={styles.sectionHeader}>
        <label style={styles.label}>本餐吃了什么</label>
        <span style={styles.hint}>每种食物单独填写克数</span>
      </div>
      <datalist id="solid-food-options">
        {foodOptions.map(option => <option key={option} value={option} />)}
      </datalist>
      <div style={styles.items}>
        {form.items.map((item, index) => (
          <div key={`${index}-${item.food_id}`} style={styles.itemRow}>
            <input
              style={{ ...styles.input, flex: 1 }}
              list="solid-food-options"
              placeholder="搜索或输入食物"
              value={item.name || ''}
              onChange={e => chooseFood(index, e.target.value)}
            />
            <input
              style={styles.gramsInput}
              type="number"
              min="0.1"
              step="0.1"
              placeholder="克"
              value={item.grams ?? ''}
              onChange={e => updateItem(index, { grams: e.target.value })}
            />
            <button type="button" style={styles.removeBtn} onClick={() => removeItem(index)} aria-label="删除食物">×</button>
          </div>
        ))}
      </div>
      <button type="button" style={styles.addBtn} onClick={addItem}>＋ 添加另一种食物</button>

      <div style={styles.sectionHeader}>
        <label style={styles.label}>餐后反应</label>
        <span style={styles.hint}>{hasReaction ? '可多选' : '默认：正常'}</span>
      </div>
      <div style={styles.chips}>
        <button
          type="button"
          style={{ ...styles.chip, ...(!hasReaction ? styles.chipActive : {}) }}
          onClick={() => setForm({ ...form, reaction_types: [], suspected_food_ids: [] })}
        >正常</button>
        {SOLID_REACTIONS.map(reaction => {
          const active = (form.reaction_types || []).includes(reaction.key)
          return (
            <button
              key={reaction.key}
              type="button"
              style={{ ...styles.chip, ...(active ? styles.chipActive : {}) }}
              onClick={() => toggleReaction(reaction.key)}
            >{reaction.label}</button>
          )
        })}
      </div>

      {hasReaction && (
        <>
          <label style={styles.label}>疑似关联食物（可选）</label>
          <div style={styles.suspectedList}>
            {form.items.map((item, index) => item.name && (
              <label key={`${item.food_id || item.name}-${index}`} style={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={(form.suspected_food_ids || []).includes(Number(item.food_id)) && Number(item.food_id) > 0}
                  disabled={!item.food_id}
                  onChange={() => toggleSuspectedFood(item.food_id)}
                />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
          <label style={styles.label}>反应说明（可选）</label>
          <textarea
            style={styles.textarea}
            rows={3}
            placeholder="例如：饭后约 30 分钟，嘴周出现少量红疹"
            value={form.reaction_note || ''}
            onChange={e => setForm({ ...form, reaction_note: e.target.value })}
          />
        </>
      )}

      <label style={styles.label}>补充备注（可选）</label>
      <textarea
        style={styles.textarea}
        rows={2}
        placeholder="例如：泥糊状、第一次尝试"
        value={form.note || ''}
        onChange={e => setForm({ ...form, note: e.target.value })}
      />
    </div>
  )
}

const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: 12, padding: 24 },
  label: { fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-muted)' },
  hint: { fontSize: '0.72rem', color: 'var(--text-muted)' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  input: {
    width: '100%', padding: '11px 12px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: '0.92rem', minWidth: 0,
  },
  items: { display: 'flex', flexDirection: 'column', gap: 8 },
  itemRow: { display: 'flex', alignItems: 'center', gap: 8 },
  gramsInput: {
    width: 72, padding: '11px 8px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: '0.92rem',
  },
  removeBtn: { width: 34, minWidth: 34, minHeight: 38, borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--danger)', fontSize: '1.15rem' },
  addBtn: { padding: '9px 12px', borderRadius: 10, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--primary-dark)', fontSize: '0.85rem' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 7 },
  chip: { padding: '8px 11px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: '0.82rem' },
  chipActive: { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' },
  suspectedList: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--bg)' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.88rem' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 },
}
