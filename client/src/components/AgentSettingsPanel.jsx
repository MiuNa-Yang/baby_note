import { useEffect, useState } from 'react'
import { API } from '../App'

const STATUS_COPY = {
  synced: ['提醒已同步', 'ok'],
  disabled: ['提醒已关闭', 'muted'],
  waiting_for_channel: ['等待绑定微信会话', 'warn'],
  waiting_for_cc_connect: ['等待 cc-connect 配置', 'warn'],
  error: ['提醒同步失败', 'error'],
}

export default function AgentSettingsPanel({ babyId }) {
  const [settings, setSettings] = useState(null)
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState('')

  const load = () => {
    if (!babyId) return
    setStatus('loading')
    fetch(`${API}/agent-settings?baby_id=${babyId}`)
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || 'Agent 设置加载失败')
        setSettings(data)
        setStatus('idle')
      })
      .catch(error => {
        setMessage(error.message || 'Agent 设置加载失败')
        setStatus('error')
      })
  }

  useEffect(load, [babyId]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = values => setSettings(current => ({ ...current, ...values }))
  const save = () => {
    setStatus('saving')
    setMessage('')
    fetch(`${API}/agent-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baby_id: babyId,
        enabled: settings.enabled,
        channel: 'weixin',
        target_session_key: settings.target_session_key,
        reminder_enabled: settings.reminder_enabled,
        reminder_time: settings.reminder_time,
      }),
    })
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || '保存失败')
        setSettings(data)
        setMessage('设置已保存')
        setStatus('saved')
        setTimeout(() => setStatus('idle'), 1600)
      })
      .catch(error => {
        setMessage(error.message || '保存失败')
        setStatus('error')
      })
  }

  const testReminder = () => {
    setStatus('testing')
    setMessage('')
    fetch(`${API}/agent-settings/test-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baby_id: babyId }),
    })
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok) throw new Error(data?.error || '测试提醒失败')
        setMessage(data.message || '测试提醒已触发')
        setStatus('idle')
      })
      .catch(error => {
        setMessage(error.message || '测试提醒失败')
        setStatus('error')
      })
  }

  if (!settings) return <p style={styles.muted}>{status === 'error' ? message : '正在读取 Agent 设置…'}</p>
  const syncState = STATUS_COPY[settings.cron_sync_status] || ['尚未同步', 'muted']

  return (
    <div style={styles.wrap}>
      <div style={styles.lead}>
        <div>
          <strong>微信带娃 Agent</strong>
          <p style={styles.muted}>群聊以数字 0 开头触发；个人私聊直接发送即可。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => patch({ enabled: !settings.enabled })}
          style={{ ...styles.switch, background: settings.enabled ? 'var(--primary)' : 'var(--border)' }}
        ><span style={{ ...styles.knob, transform: settings.enabled ? 'translateX(22px)' : 'translateX(2px)' }} /></button>
      </div>

      <div style={styles.divider} />
      <label style={styles.label}>
        微信群或私聊会话标识
        <input
          value={settings.target_session_key || ''}
          onChange={event => patch({ target_session_key: event.target.value })}
          placeholder="例如 weixin:dm:123456@chatroom"
          style={styles.input}
        />
        <span style={styles.help}>群里触发一次后，从 cc-connect 会话列表复制；格式为 weixin:dm:群ID@chatroom。</span>
      </label>

      <div style={styles.reminderRow}>
        <div>
          <strong style={styles.smallTitle}>每日辅食提醒</strong>
          <p style={styles.muted}>从辅食页读取当天计划；没有计划时也会提示。</p>
        </div>
        <input
          type="time"
          value={settings.reminder_time || '08:30'}
          onChange={event => patch({ reminder_time: event.target.value })}
          disabled={!settings.reminder_enabled}
          style={styles.time}
        />
        <button
          type="button"
          role="switch"
          aria-label="每日辅食提醒"
          aria-checked={settings.reminder_enabled}
          onClick={() => patch({ reminder_enabled: !settings.reminder_enabled })}
          style={{ ...styles.switch, background: settings.reminder_enabled ? 'var(--primary)' : 'var(--border)' }}
        ><span style={{ ...styles.knob, transform: settings.reminder_enabled ? 'translateX(22px)' : 'translateX(2px)' }} /></button>
      </div>

      <div style={styles.statusLine}>
        <span style={{ ...styles.dot, ...(syncState[1] === 'ok' ? styles.dotOk : {}), ...(syncState[1] === 'error' ? styles.dotError : {}) }} />
        <span>{syncState[0]}</span>
        {settings.cron_sync_error && <span style={styles.statusDetail}>· {settings.cron_sync_error}</span>}
      </div>

      {message && <p role="status" style={{ ...styles.feedback, ...(status === 'error' ? styles.feedbackError : {}) }}>{message}</p>}
      <div style={styles.actions}>
        <button type="button" onClick={testReminder} disabled={settings.cron_sync_status !== 'synced' || status === 'testing'} style={styles.secondary}>
          {status === 'testing' ? '触发中…' : '发送测试提醒'}
        </button>
        <button type="button" onClick={save} disabled={status === 'saving'} style={styles.primary}>
          {status === 'saving' ? '保存中…' : status === 'saved' ? '已保存 ✓' : '保存 Agent 设置'}
        </button>
      </div>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14 },
  lead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  muted: { marginTop: 3, color: 'var(--text-muted)', fontSize: '0.78rem', lineHeight: 1.45 },
  divider: { height: 1, background: 'var(--border)' },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.82rem', fontWeight: 600 },
  input: { width: '100%', padding: '10px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontWeight: 400 },
  help: { color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 400 },
  reminderRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', alignItems: 'center', gap: 10 },
  smallTitle: { fontSize: '0.86rem' },
  time: { padding: '8px 9px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' },
  switch: { width: 46, height: 24, minWidth: 46, minHeight: 24, padding: 0, borderRadius: 999, position: 'relative', transition: 'background .2s ease' },
  knob: { position: 'absolute', top: 2, left: 0, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 5px rgba(0,0,0,.22)', transition: 'transform .2s cubic-bezier(.2,.8,.2,1)' },
  statusLine: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, color: 'var(--text-muted)', fontSize: '0.75rem' },
  statusDetail: { opacity: 0.85 },
  dot: { width: 7, height: 7, borderRadius: 99, background: '#c99b45' },
  dotOk: { background: '#46a26c' },
  dotError: { background: '#c94b45' },
  feedback: { color: 'var(--primary)', fontSize: '0.78rem' },
  feedbackError: { color: 'var(--danger, #c94b45)' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  secondary: { padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg)', color: 'var(--text-muted)' },
  primary: { minWidth: 132, padding: '9px 13px', borderRadius: 9, background: 'var(--primary)', color: '#fff', fontWeight: 600, transition: 'opacity .15s ease' },
}
