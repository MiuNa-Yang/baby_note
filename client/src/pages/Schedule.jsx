import { useState, useEffect, useCallback } from 'react'
import { API } from '../App'

const DEFAULT_SCHEDULE = [
  {
    id: 'wake',
    label: '起床 & 晨间护理',
    startH: 8, startM: 30, endH: 9, endM: 0,
    icon: '🌅',
    summary: '自然醒来，晨间洗漱换尿布',
    notes: [
      '醒了不要立即抱起，让他在床上自己玩一会，培养专注力',
      '玩到宝宝叫了再去抱，边做边跟帅帅说话',
      '洗脸、涂面霜、换尿布',
      '维生素AD 隔天早晨吃一次',
    ],
  },
  {
    id: 'morning-feed',
    label: '早晨喂奶',
    startH: 9, startM: 0, endH: 9, endM: 30,
    icon: '🍼',
    summary: '早上醒后先喂奶，吃好才肯玩',
    notes: [
      '宝宝早上醒后要先吃奶才肯玩，不要强迫',
      '越强迫越厌奶，吃奶不好不用紧张',
      '喂完奶让他先多玩一会儿，不要马上哄睡',
    ],
  },
  {
    id: 'morning-play',
    label: '上午玩耍',
    startH: 9, startM: 30, endH: 10, endM: 30,
    icon: '🎠',
    summary: '看卡片、听音乐，陪聊天',
    notes: [
      '看看卡片、听听音乐、看看小玩具',
      '宝宝很喜欢大人跟他面对面聊天，多说话他会很开心',
      '吃完奶半小时后可以让他多趴趴，多趴就越来越喜欢趴',
      '压压腿、做做操他都喜欢',
    ],
  },
  {
    id: 'morning-nap',
    label: '上午小睡',
    startH: 10, startM: 30, endH: 12, endM: 0,
    icon: '😴',
    summary: '上午小眯一会，不要睡太长',
    notes: [
      '上午大概1小时玩耍后就想小眯，主要抱睡',
      '上午不要特意哄睡太多，睡多了影响下午午觉',
      '哄睡时先脱掉袜子穿上睡袋，抱几分钟',
      '没睡着就嘘嘘声 + 给奶嘴，不要紧张',
    ],
  },
  {
    id: 'noon-feed',
    label: '午饭喂奶',
    startH: 12, startM: 30, endH: 13, endM: 0,
    icon: '🍼',
    summary: '12:30～13:00 喂奶，准备午睡',
    notes: [
      '12点半到1点之间喂奶，吃好了准备午睡',
      '中午太阳好的话尽量带宝宝出去晒晒太阳',
    ],
  },
  {
    id: 'afternoon-nap',
    label: '午睡',
    startH: 13, startM: 0, endH: 15, endM: 30,
    icon: '🛏️',
    summary: '午睡约 2.5 小时',
    notes: [
      '先脱掉袜子穿上睡袋，抱几分钟没睡就嘘嘘声给奶嘴',
      '室温保持 20℃ 左右（宝宝睡觉时尤其重要）',
      '开始几天可能不熟悉睡袋，需要哄时间长一点',
    ],
  },
  {
    id: 'afternoon-wake',
    label: '下午醒来 & 喂奶',
    startH: 15, startM: 30, endH: 16, endM: 0,
    icon: '☀️',
    summary: '3:30 左右醒，吃饱才肯玩',
    notes: [
      '下午醒来同样要先吃奶才肯玩',
      '喂完奶不要马上哄睡，先让他多玩一会儿',
    ],
  },
  {
    id: 'afternoon-play',
    label: '下午玩耍',
    startH: 16, startM: 0, endH: 17, endM: 30,
    icon: '🎈',
    summary: '下午玩 1～1.5 小时，多趴趴',
    notes: [
      '现在还小，大概玩一个小时到一个半小时就又想小眯',
      '吃好奶半小时后让他多趴趴',
      '跟他面对面说说话他很开心',
      '压压腿、做做操',
    ],
  },
  {
    id: 'evening-nap',
    label: '傍晚小打盹',
    startH: 17, startM: 30, endH: 18, endM: 0,
    icon: '💤',
    summary: '打个盹十几分钟',
    notes: [
      '下午玩够后打个盹约 10～20 分钟',
      '不用哄太久，自然睡即可',
    ],
  },
  {
    id: 'evening',
    label: '傍晚活动',
    startH: 18, startM: 0, endH: 20, endM: 0,
    icon: '🌇',
    summary: '傍晚散步、亲子互动时间',
    notes: [
      '天气好、太阳好的话尽量出去晒晒太阳',
      '继续陪宝宝聊天、玩耍',
    ],
  },
  {
    id: 'bedtime',
    label: '准备入睡',
    startH: 20, startM: 0, endH: 21, endM: 0,
    icon: '🌙',
    summary: '8点～8:30 进入夜间睡眠模式',
    notes: [
      '晚上 8 点到 8 点半开始进入夜间睡眠模式',
      '脱掉袜子穿上睡袋，抱几分钟，没睡就给奶嘴',
      '晚上最好让宝宝睡 10～12 小时',
    ],
  },
  {
    id: 'night',
    label: '夜间睡眠',
    startH: 21, startM: 0, endH: 8, endM: 30,
    icon: '🌟',
    summary: '夜间深度睡眠，保持安静',
    notes: [
      '保持室温 20℃ 左右，确保宝宝舒适',
      '尽量不打扰，让宝宝睡足 10～12 小时',
    ],
    isNight: true,
  },
]

const DEFAULT_TIPS = [
  { icon: '🌡️', text: '室温保持 20℃ 左右；洗澡水温冬季 ≤39℃，夏季 37℃' },
  { icon: '🍼', text: '每天 7 餐奶，总奶量约 1000ml，不要强迫喂奶' },
  { icon: '💊', text: '维生素 AD 隔天早晨吃一次（约 48 小时间隔）' },
  { icon: '🤸', text: '每次吃奶半小时后多让宝宝趴趴，越趴越喜欢趴' },
  { icon: '💬', text: '做任何动作都要边做边跟帅帅说话，宝宝很喜欢聊天' },
]

const LS_KEY = 'schedule_custom_v1'

function loadCustom() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : { slots: {}, tips: null }
  } catch {
    return { slots: {}, tips: null }
  }
}

function saveCustom(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch {}
}

function mergeSlot(slot, custom) {
  const c = custom?.slots?.[slot.id]
  if (!c) return slot
  return {
    ...slot,
    label: c.label ?? slot.label,
    notes: c.notes ?? slot.notes,
  }
}

// ── helpers ──────────────────────────────────────────────
function toMinutes(h, m) { return h * 60 + m }

function getCurrentSlot(schedule, now) {
  const totalMin = now.getHours() * 60 + now.getMinutes()
  for (const slot of schedule) {
    if (slot.isNight) continue
    const start = toMinutes(slot.startH, slot.startM)
    const end = toMinutes(slot.endH, slot.endM)
    if (totalMin >= start && totalMin < end) return slot
  }
  return schedule.find(s => s.isNight) || schedule[0]
}

function formatTime(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function getProgress(slot, now) {
  if (slot.isNight) return null
  const totalMin = now.getHours() * 60 + now.getMinutes()
  const start = toMinutes(slot.startH, slot.startM)
  const end = toMinutes(slot.endH, slot.endM)
  const duration = end - start
  if (duration <= 0) return null
  return Math.min(100, Math.max(0, ((totalMin - start) / duration) * 100))
}

function formatRelTime(isoStr) {
  if (!isoStr) return '暂无记录'
  const d = new Date(isoStr)
  const now = new Date()
  const diffMs = now - d
  const h = Math.floor(diffMs / 3600000)
  const m = Math.floor((diffMs % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}天前`
  if (h > 0) return `${h}小时${m > 0 ? m + '分' : ''}前`
  return `${m}分钟前`
}

function formatHourMin(isoStr) {
  if (!isoStr) return '--'
  const d = new Date(isoStr)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function inferFeedingHours(hourDist) {
  if (!hourDist || Object.keys(hourDist).length === 0) return []
  const sorted = Object.entries(hourDist)
    .map(([h, c]) => ({ hour: Number(h), count: c }))
    .sort((a, b) => b.count - a.count)
  const maxCount = sorted[0]?.count || 1
  const threshold = maxCount * 0.4
  return sorted
    .filter(x => x.count >= threshold)
    .slice(0, 7)
    .map(x => x.hour)
    .sort((a, b) => a - b)
}

// ── SlotEditor 组件 ───────────────────────────────────────
function SlotEditor({ slot, onSave, onCancel, onReset, isCustomized }) {
  const [label, setLabel] = useState(slot.label)
  const [notes, setNotes] = useState([...slot.notes])

  const updateNote = (i, val) => setNotes(prev => prev.map((n, idx) => idx === i ? val : n))
  const deleteNote = (i) => setNotes(prev => prev.filter((_, idx) => idx !== i))
  const addNote = () => setNotes(prev => [...prev, ''])

  return (
    <div style={edStyles.wrap} onClick={e => e.stopPropagation()}>
      <div style={edStyles.field}>
        <label style={edStyles.label}>标题</label>
        <input
          style={edStyles.input}
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="时间段标题"
        />
      </div>

      <div style={edStyles.field}>
        <label style={edStyles.label}>注意事项</label>
        {notes.map((n, i) => (
          <div key={i} style={edStyles.noteRow}>
            <textarea
              style={edStyles.textarea}
              value={n}
              onChange={e => updateNote(i, e.target.value)}
              rows={2}
              placeholder="注意事项内容"
            />
            <button style={edStyles.delBtn} onClick={() => deleteNote(i)}>✕</button>
          </div>
        ))}
        <button style={edStyles.addBtn} onClick={addNote}>＋ 添加条目</button>
      </div>

      <div style={edStyles.actions}>
        <button style={edStyles.cancelBtn} onClick={onCancel}>取消</button>
        {isCustomized && (
          <button style={edStyles.resetBtn} onClick={onReset}>恢复默认</button>
        )}
        <button
          style={edStyles.saveBtn}
          onClick={() => onSave({ label: label.trim() || slot.label, notes: notes.filter(n => n.trim()) })}
        >
          保存
        </button>
      </div>
    </div>
  )
}

// ── TipsEditor 组件 ───────────────────────────────────────
function TipsEditor({ tips, onSave, onCancel, onReset, isCustomized }) {
  const [items, setItems] = useState(tips.map(t => ({ ...t })))

  const updateText = (i, val) => setItems(prev => prev.map((t, idx) => idx === i ? { ...t, text: val } : t))
  const updateIcon = (i, val) => setItems(prev => prev.map((t, idx) => idx === i ? { ...t, icon: val } : t))
  const deleteItem = (i) => setItems(prev => prev.filter((_, idx) => idx !== i))
  const addItem = () => setItems(prev => [...prev, { icon: '📌', text: '' }])

  return (
    <div style={edStyles.wrap}>
      {items.map((tip, i) => (
        <div key={i} style={edStyles.tipRow}>
          <input
            style={edStyles.iconInput}
            value={tip.icon}
            onChange={e => updateIcon(i, e.target.value)}
            maxLength={4}
          />
          <textarea
            style={{ ...edStyles.textarea, flex: 1 }}
            value={tip.text}
            onChange={e => updateText(i, e.target.value)}
            rows={2}
            placeholder="护理要点内容"
          />
          <button style={edStyles.delBtn} onClick={() => deleteItem(i)}>✕</button>
        </div>
      ))}
      <button style={edStyles.addBtn} onClick={addItem}>＋ 添加要点</button>

      <div style={edStyles.actions}>
        <button style={edStyles.cancelBtn} onClick={onCancel}>取消</button>
        {isCustomized && (
          <button style={edStyles.resetBtn} onClick={onReset}>恢复默认</button>
        )}
        <button
          style={edStyles.saveBtn}
          onClick={() => onSave(items.filter(t => t.text.trim()))}
        >
          保存
        </button>
      </div>
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────
export default function Schedule({ babyId }) {
  const [now, setNow] = useState(new Date())
  const [expanded, setExpanded] = useState(null)
  const [stats, setStats] = useState(null)
  const [custom, setCustom] = useState(loadCustom)
  // editingSlot: slot.id | null；editingTips: boolean
  const [editingSlot, setEditingSlot] = useState(null)
  const [editingTips, setEditingTips] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!babyId) return
    const fetchStats = () => {
      fetch(`${API}/schedule-stats?baby_id=${babyId}`)
        .then(r => r.json())
        .then(setStats)
        .catch(() => {})
    }
    fetchStats()
    const t = setInterval(fetchStats, 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') fetchStats() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [babyId])

  const persistCustom = useCallback((next) => {
    setCustom(next)
    saveCustom(next)
  }, [])

  // 合并 custom 到 schedule
  const schedule = DEFAULT_SCHEDULE.map(s => mergeSlot(s, custom))
  const tips = custom.tips ?? DEFAULT_TIPS

  const current = getCurrentSlot(schedule, now)
  const progress = getProgress(current, now)
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const idx = schedule.findIndex(s => s.id === current.id)
  const next = schedule[(idx + 1) % schedule.length]

  const feedingHours = stats ? inferFeedingHours(stats.feeding?.hour_distribution) : []
  const ad = stats?.ad
  const adDue = ad?.is_due
  const adText = ad?.last_at
    ? adDue
      ? `已逾期 ${Math.floor((ad.overdue_minutes || 0) / 60)}小时`
      : `${Math.floor((ad.remaining_minutes || 0) / 60)}小时后`
    : '暂无记录，建议今天吃'
  const poop = stats?.poop
  const poopText = poop?.last_at ? formatRelTime(poop.last_at) : '暂无记录'
  const poopAlert = poop?.hours_ago != null && poop.hours_ago > 24
  const feeding = stats?.feeding

  // ── handlers ──
  const handleSlotSave = (slotId, data) => {
    const next = { ...custom, slots: { ...custom.slots, [slotId]: data } }
    persistCustom(next)
    setEditingSlot(null)
  }

  const handleSlotReset = (slotId) => {
    const slots = { ...custom.slots }
    delete slots[slotId]
    persistCustom({ ...custom, slots })
    setEditingSlot(null)
  }

  const handleTipsSave = (newTips) => {
    persistCustom({ ...custom, tips: newTips })
    setEditingTips(false)
  }

  const handleTipsReset = () => {
    persistCustom({ ...custom, tips: null })
    setEditingTips(false)
  }

  const toggleSlot = (slotId) => {
    if (editingSlot === slotId) return  // 编辑中不折叠
    setExpanded(prev => prev === slotId ? null : slotId)
    setEditingSlot(null)
  }

  const startEditSlot = (e, slotId) => {
    e.stopPropagation()
    setExpanded(slotId)
    setEditingSlot(slotId)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h1 style={styles.pageTitle}>护理日程</h1>

      {/* 当前时段 */}
      <div style={styles.currentCard}>
        <div style={styles.currentHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.6rem' }}>{current.icon}</span>
            <div>
              <div style={styles.currentLabel}>现在应该</div>
              <div style={styles.currentTitle}>{current.label}</div>
            </div>
          </div>
          <div style={styles.clockBadge}>{timeStr}</div>
        </div>

        {progress !== null && (
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${progress}%` }} />
          </div>
        )}

        <div style={styles.noteList}>
          {current.notes.map((n, i) => (
            <div key={i} style={styles.noteItem}>
              <span style={styles.noteDot}>•</span>
              <span>{n}</span>
            </div>
          ))}
        </div>

        {!current.isNight && (
          <div style={styles.nextHint}>
            下一阶段：{next.icon} {next.label}（{formatTime(next.startH, next.startM)}）
          </div>
        )}
      </div>

      {/* 今日状态 */}
      <section>
        <h2 style={styles.sectionTitle}>今日状态</h2>
        <div style={styles.statusGrid}>
          <div style={styles.statusCard}>
            <div style={styles.statusIcon}>🍼</div>
            <div style={styles.statusLabel}>今日喂奶</div>
            <div style={styles.statusValue}>{feeding ? `${feeding.today_count}次` : '--'}</div>
            <div style={styles.statusSub}>{feeding ? `共 ${feeding.today_total_ml}ml` : ''}</div>
            {feeding?.today_times?.length > 0 && (
              <div style={styles.feedingTimes}>
                {feeding.today_times.map((t, i) => (
                  <span key={i} style={styles.feedingTimeBadge}>
                    {t.time}{t.amount_ml ? ` ${t.amount_ml}ml` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ ...styles.statusCard, ...(adDue ? styles.statusCardAlert : {}) }}>
            <div style={styles.statusIcon}>💊</div>
            <div style={styles.statusLabel}>维生素AD</div>
            <div style={{ ...styles.statusValue, fontSize: '0.9rem' }}>
              {adDue ? '⚠️ 该吃了' : (ad?.last_at ? '✓ 已吃' : '待记录')}
            </div>
            <div style={styles.statusSub}>
              {ad?.last_at ? `上次：${formatHourMin(ad.last_at)} · ${formatRelTime(ad.last_at)}` : ''}
            </div>
            <div style={{ ...styles.statusSub, color: adDue ? '#e53e3e' : 'var(--text-muted)' }}>
              {adText}
            </div>
          </div>

          <div style={{ ...styles.statusCard, ...(poopAlert ? styles.statusCardAlert : {}) }}>
            <div style={styles.statusIcon}>💩</div>
            <div style={styles.statusLabel}>最近大便</div>
            <div style={{ ...styles.statusValue, fontSize: '0.9rem' }}>
              {poopAlert ? '⚠️ 超24小时' : (poop?.last_at ? formatHourMin(poop.last_at) : '暂无')}
            </div>
            <div style={styles.statusSub}>{poopText}</div>
            {poop?.avg_daily != null && (
              <div style={styles.statusSub}>近7天均 {poop.avg_daily}次/天</div>
            )}
          </div>
        </div>
      </section>

      {/* 历史喂奶规律 */}
      {feedingHours.length > 0 && (
        <section>
          <h2 style={styles.sectionTitle}>近7天喂奶规律</h2>
          <div style={styles.infoCard}>
            <div style={styles.infoText}>根据历史记录，宝宝通常在以下时间段喂奶：</div>
            <div style={styles.hourBadges}>
              {feedingHours.map(h => {
                const isCurrentHour = now.getHours() === h
                return (
                  <span key={h} style={{ ...styles.hourBadge, ...(isCurrentHour ? styles.hourBadgeActive : {}) }}>
                    {String(h).padStart(2, '0')}:xx
                  </span>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* 全天时间表 */}
      <section>
        <h2 style={styles.sectionTitle}>全天时间表</h2>
        <div style={styles.scheduleList}>
          {schedule.filter(s => !s.isNight).map((slot) => {
            const isCurrent = slot.id === current.id
            const isOpen = expanded === slot.id
            const isEditing = editingSlot === slot.id
            const isCustomized = Boolean(custom.slots?.[slot.id])

            return (
              <div
                key={slot.id}
                style={{
                  ...styles.slotCard,
                  ...(isCurrent ? styles.slotCardActive : {}),
                  ...(isEditing ? styles.slotCardEditing : {}),
                }}
                onClick={() => !isEditing && toggleSlot(slot.id)}
              >
                <div style={styles.slotHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '1.1rem' }}>{slot.icon}</span>
                    <div>
                      <span style={styles.slotTime}>
                        {formatTime(slot.startH, slot.startM)}–{formatTime(slot.endH, slot.endM)}
                      </span>
                      <span style={styles.slotLabel}> {slot.label}</span>
                      {isCustomized && <span style={styles.customDot} title="已自定义"> ✎</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isCurrent && !isEditing && <span style={styles.activeBadge}>进行中</span>}
                    {isOpen && !isEditing && (
                      <button
                        style={styles.editBtn}
                        onClick={e => startEditSlot(e, slot.id)}
                      >
                        ✏️ 编辑
                      </button>
                    )}
                    {!isEditing && (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        {isOpen ? '▲' : '▼'}
                      </span>
                    )}
                  </div>
                </div>

                {isOpen && !isEditing && (
                  <div style={styles.slotNotes}>
                    {slot.notes.map((n, i) => (
                      <div key={i} style={styles.noteItem}>
                        <span style={styles.noteDot}>•</span>
                        <span style={{ fontSize: '0.875rem' }}>{n}</span>
                      </div>
                    ))}
                  </div>
                )}

                {isEditing && (
                  <SlotEditor
                    slot={slot}
                    isCustomized={isCustomized}
                    onSave={(data) => handleSlotSave(slot.id, data)}
                    onCancel={() => setEditingSlot(null)}
                    onReset={() => handleSlotReset(slot.id)}
                  />
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* 日常护理要点 */}
      <section>
        <div style={styles.sectionHeader}>
          <h2 style={{ ...styles.sectionTitle, marginBottom: 0 }}>日常护理要点</h2>
          {!editingTips && (
            <button style={styles.editBtn} onClick={() => setEditingTips(true)}>
              ✏️ 编辑
            </button>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          {editingTips ? (
            <div style={styles.tipsCard}>
              <TipsEditor
                tips={tips}
                isCustomized={Boolean(custom.tips)}
                onSave={handleTipsSave}
                onCancel={() => setEditingTips(false)}
                onReset={handleTipsReset}
              />
            </div>
          ) : (
            <div style={styles.tipsCard}>
              {tips.map((tip, i) => (
                <div key={i} style={styles.tipItem}>
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{tip.icon}</span>
                  <span style={{ fontSize: '0.875rem' }}>{tip.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ── 编辑器样式 ────────────────────────────────────────────
const edStyles = {
  wrap: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  label: {
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    fontWeight: 500,
  },
  input: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '0.875rem',
    boxSizing: 'border-box',
  },
  noteRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  tipRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  textarea: {
    flex: 1,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '0.875rem',
    resize: 'vertical',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    boxSizing: 'border-box',
  },
  iconInput: {
    width: 40,
    padding: '8px 4px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '1rem',
    textAlign: 'center',
    flexShrink: 0,
  },
  delBtn: {
    background: 'none',
    border: 'none',
    color: '#e53e3e',
    fontSize: '1rem',
    cursor: 'pointer',
    padding: '6px 4px',
    flexShrink: 0,
    lineHeight: 1,
  },
  addBtn: {
    background: 'none',
    border: '1px dashed var(--border)',
    borderRadius: 8,
    color: 'var(--primary)',
    fontSize: '0.85rem',
    padding: '7px 12px',
    cursor: 'pointer',
    width: '100%',
  },
  actions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    paddingTop: 4,
  },
  cancelBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    color: 'var(--text-muted)',
  },
  resetBtn: {
    background: 'none',
    border: '1px solid #fc8181',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    color: '#e53e3e',
  },
  saveBtn: {
    background: 'var(--primary)',
    border: 'none',
    borderRadius: 8,
    padding: '7px 18px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    color: '#fff',
    fontWeight: 600,
  },
}

// ── 主页面样式 ────────────────────────────────────────────
const styles = {
  pageTitle: {
    fontSize: '1.15rem',
    fontWeight: 700,
    color: 'var(--text)',
    marginBottom: -4,
  },
  currentCard: {
    background: 'var(--primary)',
    borderRadius: 16,
    padding: '18px 16px',
    color: '#fff',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  currentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  currentLabel: { fontSize: '0.75rem', opacity: 0.85 },
  currentTitle: { fontSize: '1.2rem', fontWeight: 700 },
  clockBadge: {
    background: 'rgba(255,255,255,0.2)',
    borderRadius: 20,
    padding: '4px 12px',
    fontSize: '0.9rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  currentSummary: { fontSize: '0.9rem', opacity: 0.9, lineHeight: 1.5 },
  progressBar: { height: 4, background: 'rgba(255,255,255,0.25)', borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#fff', borderRadius: 4, transition: 'width 0.5s ease' },
  noteList: { display: 'flex', flexDirection: 'column', gap: 6 },
  noteItem: { display: 'flex', gap: 8, lineHeight: 1.5, alignItems: 'flex-start' },
  noteDot: { flexShrink: 0, opacity: 0.75 },
  nextHint: {
    fontSize: '0.8rem',
    opacity: 0.8,
    borderTop: '1px solid rgba(255,255,255,0.2)',
    paddingTop: 10,
  },
  sectionTitle: { fontSize: '1rem', fontWeight: 600, marginBottom: 12, color: 'var(--text)' },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  statusGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 },
  statusCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '12px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    alignItems: 'center',
    textAlign: 'center',
  },
  statusCardAlert: { borderColor: '#fc8181', background: '#fff5f5' },
  statusIcon: { fontSize: '1.4rem' },
  statusLabel: { fontSize: '0.72rem', color: 'var(--text-muted)' },
  statusValue: { fontSize: '1rem', fontWeight: 700, color: 'var(--text)' },
  statusSub: { fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 },
  feedingTimes: { marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center' },
  feedingTimeBadge: {
    fontSize: '0.65rem',
    background: 'var(--primary-light, #e6f0ff)',
    color: 'var(--primary)',
    borderRadius: 6,
    padding: '1px 5px',
  },
  infoCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  infoText: { fontSize: '0.875rem', color: 'var(--text-muted)' },
  hourBadges: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  hourBadge: {
    fontSize: '0.85rem',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '4px 10px',
    color: 'var(--text)',
    fontVariantNumeric: 'tabular-nums',
  },
  hourBadgeActive: { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)', fontWeight: 700 },
  scheduleList: { display: 'flex', flexDirection: 'column', gap: 8 },
  slotCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '12px 14px',
    cursor: 'pointer',
  },
  slotCardActive: { borderColor: 'var(--primary)', background: 'var(--primary-light, #fff5eb)' },
  slotCardEditing: { borderColor: 'var(--primary)', cursor: 'default' },
  slotHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  slotTime: { fontSize: '0.8rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' },
  slotLabel: { fontSize: '0.9rem', fontWeight: 500, color: 'var(--text)' },
  customDot: { fontSize: '0.75rem', color: 'var(--primary)', marginLeft: 2 },
  activeBadge: {
    background: 'var(--primary)',
    color: '#fff',
    borderRadius: 10,
    padding: '2px 8px',
    fontSize: '0.7rem',
    fontWeight: 600,
  },
  editBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '3px 10px',
    fontSize: '0.75rem',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  },
  slotNotes: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    color: 'var(--text)',
  },
  tipsCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  tipItem: { display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--text)' },
}
