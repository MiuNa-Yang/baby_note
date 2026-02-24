const TZ = 'Asia/Shanghai'

/** 后端 SQLite 的 datetime 格式如 "YYYY-MM-DD HH:MM:SS"（UTC，无 Z），需按 UTC 解析 */
export function parseDateTime(str) {
  if (!str) return null
  const s = String(str).trim()
  if (!s) return null
  if (s.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + 'Z')
  return new Date(s)
}

export function formatTime(iso) {
  const d = parseDateTime(iso)
  if (!d || isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  })
}

export function formatDate(iso) {
  const d = parseDateTime(iso)
  if (!d || isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TZ,
  })
}

export function formatDateTime(iso) {
  const d = parseDateTime(iso)
  if (!d || isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  })
}

/** 用于 datetime-local 的当前北京时间 YYYY-MM-DDTHH:mm */
export function getBeijingNowForInput() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ })
  return s.slice(0, 16).replace(' ', 'T')
}

/** 将 ISO 或 datetime 转为 datetime-local 格式（北京时间） */
export function toDateTimeLocal(iso) {
  const d = parseDateTime(iso)
  if (!d || isNaN(d.getTime())) return ''
  const s = d.toLocaleString('sv-SE', { timeZone: TZ })
  return s.slice(0, 16).replace(' ', 'T')
}

/** 获取北京日期 YYYY-MM-DD */
export function getBeijingDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ })
}

/** 北京时间的 N 天前 */
export function getBeijingDateDaysAgo(days) {
  const d = new Date()
  d.setTime(d.getTime() - days * 24 * 60 * 60 * 1000)
  return getBeijingDate(d)
}


