const TZ = 'Asia/Shanghai'

export function getBeijingDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ })
}

export function getBeijingDateDaysAgo(days) {
  const d = new Date()
  d.setTime(d.getTime() - days * 24 * 60 * 60 * 1000)
  return getBeijingDate(d)
}
