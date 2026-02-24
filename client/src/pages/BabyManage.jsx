import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { API } from '../App'

export default function BabyManage({ onDone }) {
  const navigate = useNavigate()
  const [babies, setBabies] = useState([])
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ name: '', birthdate: '' })

  useEffect(() => {
    fetch(API + '/babies')
      .then(r => r.json())
      .then(data => {
        setBabies(data)
        if (data.length && !editing) setEditing(null)
      })
  }, [])

  const submit = (e) => {
    e.preventDefault()
    if (!form.name || !form.birthdate) return
    if (editing) {
      fetch(API + `/babies/${editing}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
        .then(() => {
          setEditing(null)
          setForm({ name: '', birthdate: '' })
          return fetch(API + '/babies').then(r => r.json())
        })
        .then(setBabies)
    } else {
      fetch(API + '/babies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
        .then(() => {
          setForm({ name: '', birthdate: '' })
          return fetch(API + '/babies').then(r => r.json())
        })
        .then(data => {
          setBabies(data)
          onDone?.()
        })
    }
  }

  const remove = (id) => {
    if (!confirm('确定删除该宝宝？相关记录也会被删除。')) return
    fetch(API + `/babies/${id}`, { method: 'DELETE' })
      .then(() => fetch(API + '/babies').then(r => r.json()))
      .then(data => {
        setBabies(data)
        setEditing(null)
        if (!data.length) onDone?.()
      })
  }

  const startEdit = (b) => {
    setEditing(b.id)
    setForm({ name: b.name, birthdate: b.birthdate })
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <h1 style={styles.title}>宝宝档案</h1>
        {babies.length > 0 && (
          <button onClick={() => navigate('/')} style={styles.backBtn}>
            返回首页
          </button>
        )}
      </div>

      <form onSubmit={submit} style={styles.form}>
        <input
          placeholder="宝宝姓名"
          value={form.name}
          onChange={e => setForm({ ...form, name: e.target.value })}
          style={styles.input}
          required
        />
        <input
          type="date"
          placeholder="出生日期"
          value={form.birthdate}
          onChange={e => setForm({ ...form, birthdate: e.target.value })}
          style={styles.input}
          required
        />
        <button type="submit" style={styles.submit}>
          {editing ? '保存' : '添加宝宝'}
        </button>
        {editing && (
          <button type="button" onClick={() => { setEditing(null); setForm({ name: '', birthdate: '' }); }} style={styles.cancel}>
            取消
          </button>
        )}
      </form>

      {babies.length > 0 && (
        <div style={styles.list}>
          <h3 style={styles.subtitle}>已添加的宝宝</h3>
          {babies.map(b => (
            <div key={b.id} style={styles.item}>
              <div>
                <div style={styles.itemName}>{b.name}</div>
                <div style={styles.itemDate}>出生: {b.birthdate}</div>
              </div>
              <div style={styles.actions}>
                <button onClick={() => startEdit(b)} style={styles.actionBtn}>编辑</button>
                <button onClick={() => remove(b.id)} style={{ ...styles.actionBtn, color: 'var(--danger)' }}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: { padding: 20, maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  title: { fontSize: '1.5rem' },
  backBtn: {
    padding: '8px 16px',
    borderRadius: 8,
    background: 'var(--primary)',
    color: '#fff',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 },
  input: {
    padding: 14,
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text)',
  },
  submit: {
    padding: 14,
    borderRadius: 10,
    background: 'var(--primary)',
    color: '#fff',
  },
  cancel: {
    padding: 10,
    background: 'transparent',
    color: 'var(--text-muted)',
  },
  list: { marginTop: 24 },
  subtitle: { fontSize: '1rem', marginBottom: 12 },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    background: 'var(--bg-card)',
    borderRadius: 12,
    marginBottom: 10,
    border: '1px solid var(--border)',
  },
  itemName: { fontWeight: 600 },
  itemDate: { fontSize: '0.9rem', color: 'var(--text-muted)' },
  actions: { display: 'flex', gap: 12 },
  actionBtn: { background: 'none', color: 'var(--primary)' },
}
