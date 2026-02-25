import { useState, useEffect, useMemo, useRef } from 'react'
import { API } from '../App'
import { formatTime, getBeijingDate } from '../utils/date'

function formatAge(ageDays) {
  const days = Number(ageDays || 0)
  if (days < 30) return `${days}天`
  if (days < 365) return `${Math.floor(days / 30)}个月${days % 30}天`
  return `${Math.floor(days / 365)}岁`
}

function formatDuration(min) {
  if (!min) return '0分钟'
  if (min < 60) return `${min}分钟`
  return `${Math.floor(min / 60)}小时${min % 60}分钟`
}

function getNiceStep(maxVal, tickCount = 4) {
  if (maxVal <= 0) return 1
  const roughStep = maxVal / tickCount
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const residual = roughStep / magnitude

  if (residual <= 1) return 1 * magnitude
  if (residual <= 2) return 2 * magnitude
  if (residual <= 5) return 5 * magnitude
  return 10 * magnitude
}

function getAxisMeta(maxVal, tickCount = 4) {
  if (maxVal <= 0) {
    return { axisMax: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  }
  const step = getNiceStep(maxVal, tickCount)
  const axisMax = Math.ceil(maxVal / step) * step
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (axisMax / tickCount) * i)
  return { axisMax, ticks }
}

function formatAxisValue(value, dataKey) {
  if (value === 0) return '0'
  if (dataKey === 'total_minutes') return `${Math.round(value / 60)}h`
  if (dataKey === 'avg_weight_kg') return `${Number(value).toFixed(1)}`
  return `${Math.round(value)}`
}

function getLabelStep(length) {
  if (length <= 6) return 1
  if (length <= 12) return 2
  if (length <= 20) return 3
  if (length <= 28) return 4
  return 5
}

function getRecentDividerStyle(length, recentDays = 7) {
  if (length <= recentDays) return null
  const offsetPercent = ((length - recentDays) / length) * 100
  return {
    position: 'absolute',
    left: `calc(${offsetPercent}% + 8px)`,
    top: 6,
    bottom: 24,
    width: 0,
    borderLeft: '1px dashed var(--stats-grid)',
    pointerEvents: 'none',
    zIndex: 1,
  }
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  dt.setUTCDate(dt.getUTCDate() + deltaDays)
  return dt.toISOString().slice(0, 10)
}

function getContinuousDates(endDate, count) {
  const safeCount = Math.max(Number(count) || 0, 1)
  return Array.from({ length: safeCount }, (_, i) => shiftDate(endDate, -(safeCount - 1 - i)))
}

function useDragScroll() {
  const dragRef = useRef({
    active: false,
    startX: 0,
    startScrollLeft: 0,
  })

  const onMouseDown = (e) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    dragRef.current.active = true
    dragRef.current.startX = e.clientX
    dragRef.current.startScrollLeft = el.scrollLeft
    el.style.cursor = 'grabbing'
    e.preventDefault()
  }

  const onMouseMove = (e) => {
    const el = e.currentTarget
    if (!dragRef.current.active) return
    const delta = e.clientX - dragRef.current.startX
    el.scrollLeft = dragRef.current.startScrollLeft - delta
  }

  const stopDrag = (e) => {
    const el = e.currentTarget
    dragRef.current.active = false
    el.style.cursor = 'grab'
  }

  return {
    onMouseDown,
    onMouseMove,
    onMouseUp: stopDrag,
    onMouseLeave: stopDrag,
  }
}

function SimpleBarChart({ data, dataKey, color = '#c97d52' }) {
  if (!data || data.length === 0) return null

  const maxVal = Math.max(...data.map(d => d[dataKey] || 0), 0)
  const { axisMax, ticks } = getAxisMeta(maxVal)
  const displayTicks = [...ticks].reverse()
  const labelStep = getLabelStep(data.length)
  const recentDividerStyle = getRecentDividerStyle(data.length)
  const scrollRef = useRef(null)
  const dragHandlers = useDragScroll()
  const shouldScroll = data.length > 8
  const contentWidth = useMemo(() => data.length * 44 + 16, [data.length])

  useEffect(() => {
    if (!shouldScroll) return
    if (!scrollRef.current) return
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
  }, [data.length, dataKey, shouldScroll])

  const shortDate = (d) => {
    const s = d.slice(5)
    return s.replace('-', '/')
  }

  return (
    <div style={simpleChartStyles.wrap}>
      <div style={simpleChartStyles.container}>
        <div style={simpleChartStyles.chartBody}>
          <div style={simpleChartStyles.yAxis}>
            {displayTicks.map((tick, i) => (
              <span key={i} style={simpleChartStyles.yLabel}>
                {formatAxisValue(tick, dataKey)}
              </span>
            ))}
          </div>
          <div style={simpleChartStyles.plotArea}>
            <div
              ref={scrollRef}
              style={{
                ...simpleChartStyles.scrollViewport,
                overflowX: shouldScroll ? 'auto' : 'hidden',
                cursor: shouldScroll ? 'grab' : 'default',
              }}
              {...(shouldScroll ? dragHandlers : {})}
              title="左右拖动查看全部日期"
            >
              <div style={{ ...simpleChartStyles.scrollContent, width: shouldScroll ? contentWidth : '100%' }}>
                <div style={simpleChartStyles.grid}>
                  {displayTicks.map((_, i) => (
                    <div key={i} style={simpleChartStyles.gridLine} />
                  ))}
                </div>
                {recentDividerStyle && <div style={recentDividerStyle} />}
                <div style={{ ...simpleChartStyles.bars, gap: shouldScroll ? 8 : 14 }}>
                  {data.map((d, i) => {
                    const value = d[dataKey] || 0
                    const height = value > 0 ? `${(value / axisMax) * 100}%` : '0%'
                    const showLabel = i % labelStep === 0 || i === data.length - 1
                    return (
                      <div key={i} style={shouldScroll ? simpleChartStyles.barWrapper : simpleChartStyles.barWrapperFit}>
                        <div style={simpleChartStyles.barTrack}>
                          {value > 0 && (
                            <div
                              style={{
                                ...simpleChartStyles.bar,
                                height: height,
                                background: `linear-gradient(180deg, ${color} 0%, ${color}cc 100%)`,
                                boxShadow: `0 8px 20px ${color}33`,
                                minHeight: '10px',
                              }}
                            />
                          )}
                        </div>
                        <span style={simpleChartStyles.label}>{showLabel ? shortDate(d.date) : ''}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FeedingComboChart({
  data,
  barKey = 'total_ml',
  lineKey = 'feeding_count',
  barColor = '#c97d52',
}) {
  if (!data || data.length === 0) return null

  const barMaxVal = Math.max(...data.map(d => d[barKey] || 0), 0)
  const { axisMax: barAxisMax, ticks: barTicks } = getAxisMeta(barMaxVal)
  const displayBarTicks = [...barTicks].reverse()
  const seriesData = data
  const labelStep = getLabelStep(seriesData.length)
  const recentDividerStyle = getRecentDividerStyle(seriesData.length)
  const scrollRef = useRef(null)
  const dragHandlers = useDragScroll()
  const shouldScroll = seriesData.length > 8
  const contentWidth = useMemo(() => seriesData.length * 44 + 16, [seriesData.length])

  useEffect(() => {
    if (!shouldScroll) return
    if (!scrollRef.current) return
    scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
  }, [seriesData.length, barKey, lineKey, shouldScroll])

  const shortDate = (d) => {
    const s = d.slice(5)
    return s.replace('-', '/')
  }

  return (
    <div style={simpleChartStyles.wrap}>
      <div style={simpleChartStyles.container}>
        <div style={comboChartStyles.legend}>
          <span style={comboChartStyles.legendItem}>
            <i style={{ ...comboChartStyles.legendBar, background: barColor }} />
            喂奶量(ml)
          </span>
          <span style={comboChartStyles.legendItem}>
            <i style={comboChartStyles.legendCount} />
            柱顶数字=喂奶次数
          </span>
        </div>

        <div style={comboChartStyles.chartBody}>
          <div style={simpleChartStyles.yAxis}>
            {displayBarTicks.map((tick, i) => (
              <span key={`l-${i}`} style={simpleChartStyles.yLabel}>
                {Math.round(tick)}
              </span>
            ))}
          </div>

          <div style={simpleChartStyles.plotArea}>
            <div
              ref={scrollRef}
              style={{
                ...simpleChartStyles.scrollViewport,
                overflowX: shouldScroll ? 'auto' : 'hidden',
                cursor: shouldScroll ? 'grab' : 'default',
              }}
              {...(shouldScroll ? dragHandlers : {})}
              title="左右拖动查看全部日期"
            >
              <div style={{ ...simpleChartStyles.scrollContent, width: shouldScroll ? contentWidth : '100%' }}>
                <div style={simpleChartStyles.grid}>
                  {displayBarTicks.map((_, i) => (
                    <div key={i} style={simpleChartStyles.gridLine} />
                  ))}
                </div>
                {recentDividerStyle && <div style={recentDividerStyle} />}

                <div style={{ ...comboChartStyles.bars, gap: shouldScroll ? 8 : 0 }}>
                  {seriesData.map((d, i) => {
                    const barValue = d[barKey] || 0
                    const countValue = d[lineKey] || 0
                    const height = barValue > 0 ? `${(barValue / barAxisMax) * 100}%` : '0%'
                    const showLabel = i % labelStep === 0 || i === seriesData.length - 1
                    return (
                      <div key={i} style={shouldScroll ? comboChartStyles.barWrapper : comboChartStyles.barWrapperFit}>
                        <div style={comboChartStyles.barTrack}>
                          {barValue > 0 && (
                            <div style={comboChartStyles.barGroup}>
                              <span style={comboChartStyles.countTag}>{countValue}次</span>
                              <div
                                style={{
                                  ...comboChartStyles.bar,
                                  height,
                                  background: `linear-gradient(180deg, ${barColor} 0%, ${barColor}cc 100%)`,
                                  boxShadow: `0 8px 20px ${barColor}33`,
                                  minHeight: '10px',
                                }}
                              />
                            </div>
                          )}
                          {barValue <= 0 && <span style={comboChartStyles.countTagMuted}>{countValue}次</span>}
                        </div>
                        <span style={simpleChartStyles.label}>{showLabel ? shortDate(d.date) : ''}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

function GrowthLineChart({ data }) {
  if (!data || data.length === 0) return null

  const width = 100
  const height = 160
  const leftPad = 12
  const rightPad = 12
  const topPad = 10
  const bottomPad = 18
  const plotWidth = width - leftPad - rightPad
  const plotHeight = height - topPad - bottomPad

  const weightVals = data.map((d) => d.avg_weight_kg).filter((v) => v != null)
  const heightVals = data.map((d) => d.avg_height_cm).filter((v) => v != null)
  const labelStep = getLabelStep(data.length)

  const calcRange = (vals, fallbackMin = 0, fallbackMax = 1) => {
    if (!vals.length) return { min: fallbackMin, max: fallbackMax }
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    if (min === max) return { min: min - 0.5, max: max + 0.5 }
    const pad = (max - min) * 0.12
    return { min: min - pad, max: max + pad }
  }

  const weightRange = calcRange(weightVals, 0, 1)
  const heightRange = calcRange(heightVals, 0, 1)

  const xAt = (i) => {
    if (data.length <= 1) return leftPad + plotWidth / 2
    return leftPad + (i / (data.length - 1)) * plotWidth
  }
  const yAt = (v, range) => topPad + ((range.max - v) / (range.max - range.min || 1)) * plotHeight

  const pointsPath = (key, range) => {
    const points = data
      .map((d, i) => (d[key] == null ? null : `${xAt(i)},${yAt(Number(d[key]), range)}`))
      .filter(Boolean)
    if (!points.length) return ''
    return `M ${points.join(' L ')}`
  }

  const weightPath = pointsPath('avg_weight_kg', weightRange)
  const heightPath = pointsPath('avg_height_cm', heightRange)
  const recentDivider = getRecentDividerStyle(data.length)

  const shortDate = (d) => d.slice(5).replace('-', '/')

  return (
    <div style={growthChartStyles.wrap}>
      <div style={growthChartStyles.legend}>
        <span style={growthChartStyles.legendItem}><i style={{ ...growthChartStyles.dot, background: '#8fb3ff' }} />体重(kg)</span>
        <span style={growthChartStyles.legendItem}><i style={{ ...growthChartStyles.dot, background: '#7cc7a6' }} />身高(cm)</span>
      </div>
      <div style={growthChartStyles.chart}>
        <div style={growthChartStyles.leftAxis}>
          <span>{weightRange.max.toFixed(1)}</span>
          <span>{((weightRange.max + weightRange.min) / 2).toFixed(1)}</span>
          <span>{weightRange.min.toFixed(1)}</span>
        </div>
        <div style={growthChartStyles.plot}>
          {recentDivider && <div style={recentDivider} />}
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={growthChartStyles.svg}>
            <line x1={leftPad} y1={topPad} x2={leftPad} y2={height - bottomPad} stroke="var(--stats-axis)" strokeWidth="0.6" />
            <line x1={leftPad} y1={height - bottomPad} x2={width - rightPad} y2={height - bottomPad} stroke="var(--stats-axis)" strokeWidth="0.6" />
            <line x1={leftPad} y1={topPad + plotHeight / 2} x2={width - rightPad} y2={topPad + plotHeight / 2} stroke="var(--stats-grid)" strokeDasharray="2 2" strokeWidth="0.5" />
            {weightPath && <path d={weightPath} fill="none" stroke="#8fb3ff" strokeWidth="1.4" />}
            {heightPath && <path d={heightPath} fill="none" stroke="#7cc7a6" strokeWidth="1.4" />}
            {data.map((d, i) => (
              <g key={i}>
                {d.avg_weight_kg != null && <circle cx={xAt(i)} cy={yAt(Number(d.avg_weight_kg), weightRange)} r="1.6" fill="#8fb3ff" />}
                {d.avg_height_cm != null && <circle cx={xAt(i)} cy={yAt(Number(d.avg_height_cm), heightRange)} r="1.6" fill="#7cc7a6" />}
              </g>
            ))}
          </svg>
          <div style={growthChartStyles.xLabels}>
            {data.map((d, i) => (
              <span key={d.date} style={growthChartStyles.xLabel}>
                {(i % labelStep === 0 || i === data.length - 1) ? shortDate(d.date) : ''}
              </span>
            ))}
          </div>
        </div>
        <div style={growthChartStyles.rightAxis}>
          <span>{heightRange.max.toFixed(1)}</span>
          <span>{((heightRange.max + heightRange.min) / 2).toFixed(1)}</span>
          <span>{heightRange.min.toFixed(1)}</span>
        </div>
      </div>
    </div>
  )
}

const simpleChartStyles = {
  wrap: { marginTop: 12 },
  container: {
    height: 220,
    display: 'flex',
    flexDirection: 'column',
  },
  chartBody: {
    flex: 1,
    display: 'flex',
    gap: 8,
  },
  yAxis: {
    width: 36,
    height: '100%',
    paddingBottom: 24,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  yLabel: {
    fontSize: '0.72rem',
    color: 'var(--stats-muted-2)',
    lineHeight: 1,
  },
  plotArea: {
    flex: 1,
    height: '100%',
    borderLeft: '2px solid var(--stats-border)',
    borderBottom: '2px solid var(--stats-border)',
    borderRadius: 10,
    position: 'relative',
    background: 'var(--stats-section-bg-soft)',
    overflow: 'hidden',
  },
  scrollViewport: {
    position: 'absolute',
    inset: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    cursor: 'grab',
    touchAction: 'pan-x',
    scrollbarWidth: 'thin',
  },
  scrollContent: {
    position: 'relative',
    height: '100%',
  },
  grid: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 24,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    pointerEvents: 'none',
  },
  gridLine: {
    borderTop: '1px dashed var(--stats-grid)',
  },
  bars: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    padding: '0 12px 24px 4px',
  },
  barWrapper: {
    flex: '0 0 36px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
  },
  barWrapperFit: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
    padding: '0 7px',
  },
  barTrack: {
    flex: 1,
    width: '100%',
    display: 'flex',
    alignItems: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: '8px 8px 0 0',
    transition: 'height 0.25s ease',
  },
  label: {
    display: 'block',
    height: 16,
    lineHeight: '16px',
    fontSize: '0.75rem',
    color: 'var(--stats-muted)',
    marginTop: 6,
    whiteSpace: 'nowrap',
  },
}

const comboChartStyles = {
  legend: {
    display: 'flex',
    gap: 14,
    alignItems: 'center',
    marginBottom: 8,
    fontSize: '0.8rem',
    color: 'var(--stats-muted)',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  legendBar: {
    width: 10,
    height: 10,
    borderRadius: 2,
    display: 'inline-block',
  },
  legendCount: {
    width: 20,
    height: 12,
    borderRadius: 6,
    display: 'inline-block',
    border: '1px solid var(--stats-border)',
    background: 'var(--stats-count-muted-bg)',
  },
  chartBody: {
    flex: 1,
    display: 'flex',
    gap: 8,
  },
  bars: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'flex-end',
    gap: 8,
    padding: '0 12px 24px 4px',
    zIndex: 2,
  },
  barWrapper: {
    flex: '0 0 36px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
  },
  barWrapperFit: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    height: '100%',
  },
  barTrack: {
    flex: 1,
    width: '100%',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  barGroup: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '42%',
    margin: '0 auto',
    borderRadius: '8px 8px 0 0',
    transition: 'height 0.25s ease',
  },
  countTag: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1px 6px',
    marginBottom: 6,
    borderRadius: 999,
    fontSize: '0.72rem',
    fontWeight: 700,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    minWidth: 34,
    color: 'var(--stats-text)',
    background: 'var(--stats-count-bg)',
    border: '1px solid var(--stats-count-border)',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  },
  countTagMuted: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1px 6px',
    marginBottom: 6,
    borderRadius: 999,
    fontSize: '0.72rem',
    fontWeight: 700,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    minWidth: 34,
    color: 'var(--stats-muted-2)',
    background: 'var(--stats-count-muted-bg)',
    border: '1px solid var(--stats-count-muted-border)',
  },
}

const growthChartStyles = {
  wrap: { marginTop: 12 },
  legend: {
    display: 'flex',
    gap: 14,
    alignItems: 'center',
    marginBottom: 8,
    fontSize: '0.8rem',
    color: 'var(--stats-muted)',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    display: 'inline-block',
  },
  chart: {
    height: 220,
    display: 'grid',
    gridTemplateColumns: '38px 1fr 38px',
    gap: 8,
    alignItems: 'stretch',
  },
  leftAxis: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 22,
    fontSize: '0.72rem',
    color: 'var(--stats-muted-2)',
  },
  rightAxis: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingBottom: 22,
    fontSize: '0.72rem',
    color: 'var(--stats-muted-2)',
  },
  plot: {
    position: 'relative',
    borderLeft: '2px solid var(--stats-border)',
    borderBottom: '2px solid var(--stats-border)',
    borderRadius: 10,
    overflow: 'hidden',
    background: 'var(--stats-section-bg-soft)',
  },
  svg: {
    width: '100%',
    height: 'calc(100% - 22px)',
    display: 'block',
  },
  xLabels: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 2,
    display: 'flex',
    padding: '0 8px',
    gap: 0,
  },
  xLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: '0.75rem',
    color: 'var(--stats-muted)',
  },
}

export default function Stats({ babyId }) {
  const [feedingData, setFeedingData] = useState([])
  const [sleepData, setSleepData] = useState({ daily: [], periods: [] })
  const [diaperData, setDiaperData] = useState([])
  const [growthData, setGrowthData] = useState({ daily: [], latestWeight: null, latestHeight: null })
  const [overview, setOverview] = useState(null)
  const [days, setDays] = useState(3)

  useEffect(() => {
    if (!babyId) return
    const queryDays = days + 1
    Promise.all([
      fetch(API + `/stats/feeding?baby_id=${babyId}&days=${queryDays}`).then(r => r.json()),
      fetch(API + `/stats/sleep?baby_id=${babyId}&days=${queryDays}`).then(r => r.json()),
      fetch(API + `/stats/diaper?baby_id=${babyId}&days=${queryDays}`).then(r => r.json()),
      fetch(API + `/stats/growth?baby_id=${babyId}&days=${queryDays}`).then(r => r.json()),
    ]).then(([feeding, sleep, diaper, growth]) => {
      setFeedingData(Array.isArray(feeding) ? feeding : [])
      setSleepData(sleep?.daily ? sleep : { daily: [], periods: sleep?.periods || [] })
      setDiaperData(Array.isArray(diaper) ? diaper : [])
      setGrowthData(growth?.daily ? growth : { daily: [], latestWeight: null, latestHeight: null })
    })

    fetch(API + `/overview?baby_id=${babyId}`)
      .then(r => r.json())
      .then(overviewData => {
        setOverview(overviewData?.ageDays == null ? null : overviewData)
      })
      .catch(() => {
      setOverview(null)
    })
  }, [babyId, days])

  if (!babyId) return null

  const today = getBeijingDate()
  const displayDates = getContinuousDates(today, days + 1)
  const avgDates = displayDates.slice(0, -1)
  const feedingByDate = Object.fromEntries(feedingData.map((d) => [d.date, d]))
  const sleepByDate = Object.fromEntries((sleepData.daily || []).map((d) => [d.date, d]))
  const diaperByDate = Object.fromEntries(diaperData.map((d) => [d.date, d]))
  const totalMlForAvg = avgDates.reduce((s, date) => s + (feedingByDate[date]?.total_ml || 0), 0)
  const totalCountForAvg = avgDates.reduce((s, date) => s + (feedingByDate[date]?.count || 0), 0)
  const feedingAvgBase = Math.max(avgDates.length, 1)
  const avgFeedingCount = totalCountForAvg / feedingAvgBase
  const avgFeedingMl = totalMlForAvg / feedingAvgBase
  const totalSleepMin = displayDates.reduce((s, date) => s + (sleepByDate[date]?.total_minutes || 0), 0)
  const totalSleepMinForAvg = avgDates.reduce((s, date) => s + (sleepByDate[date]?.total_minutes || 0), 0)
  const sleepSessions = displayDates.reduce((s, date) => s + (sleepByDate[date]?.sessions || 0), 0)
  const growthSeries = (growthData.daily || [])
    .map((d) => ({
      date: d.date,
      avg_weight_kg: d.avg_weight_kg == null ? null : Number(d.avg_weight_kg),
      avg_height_cm: d.avg_height_cm == null ? null : Number(d.avg_height_cm),
      weight_count: Number(d.weight_count || 0),
      height_count: Number(d.height_count || 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const weightByDate = Object.fromEntries(growthSeries.map((d) => [d.date, d.avg_weight_kg]))
  const heightByDate = Object.fromEntries(growthSeries.map((d) => [d.date, d.avg_height_cm]))
  const latestWeight = growthData.latestWeight?.weight_kg != null ? Number(growthData.latestWeight.weight_kg) : null
  const latestHeight = growthData.latestHeight?.height_cm != null ? Number(growthData.latestHeight.height_cm) : null
  const firstWeight = growthSeries.length ? growthSeries[0].avg_weight_kg : null
  const lastWeight = growthSeries.length ? growthSeries[growthSeries.length - 1].avg_weight_kg : null
  const firstHeight = growthSeries.length ? growthSeries[0].avg_height_cm : null
  const lastHeight = growthSeries.length ? growthSeries[growthSeries.length - 1].avg_height_cm : null
  const weightDelta = firstWeight != null && lastWeight != null ? Number((lastWeight - firstWeight).toFixed(2)) : null
  const heightDelta = firstHeight != null && lastHeight != null ? Number((lastHeight - firstHeight).toFixed(1)) : null

  const mergedByDate = {}
  displayDates.forEach((d) => {
    const feeding = feedingByDate[d]
    const sleep = sleepByDate[d]
    mergedByDate[d] = {
      date: d,
      total_ml: feeding?.total_ml || 0,
      feeding_count: feeding?.count || 0,
      total_minutes: sleep?.total_minutes || 0,
    }
  })
  const totalStoolCount = displayDates.reduce((s, date) => s + Number(diaperByDate[date]?.stool_count || 0), 0)
  const chartData = Object.values(mergedByDate).sort((a, b) => a.date.localeCompare(b.date))
  const trendDates = new Set([...chartData.map((d) => d.date), ...growthSeries.map((d) => d.date)])
  const trendData = Array.from(trendDates)
    .map((date) => {
      const base = chartData.find((d) => d.date === date) || { date, total_ml: 0, feeding_count: 0, total_minutes: 0 }
      return { ...base, avg_weight_kg: weightByDate[date] ?? null, avg_height_cm: heightByDate[date] ?? null }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const todayFeeding = feedingByDate[today]
  const todaySleep = sleepByDate[today]
  const todayMl = Number(todayFeeding?.total_ml || 0)
  const todayFeedingCount = Number(todayFeeding?.count || 0)
  const recent24hMl = Number(
    overview?.recent24h_feeding_total_ml ??
    overview?.recent24hFeedingTotalMl ??
    0
  )
  const recent24hFeedingCount = Number(
    overview?.recent24h_feeding_count ??
    overview?.recent24hFeedingCount ??
    0
  )
  const todaySleepMin = todaySleep?.total_minutes || 0
  const ageText = overview?.ageDays == null ? '--' : formatAge(overview.ageDays)

  return (
    <div style={styles.wrap}>
      <h2 style={styles.pageTitle}>分析中心</h2>

      <section style={styles.todaySection}>
        <div style={styles.todayHeader}>
          <h3 style={styles.sectionTitle}>概况</h3>
          <span style={styles.todayDate}>{today}</span>
        </div>
        <div style={styles.todayCards}>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>今日奶量</span>
            <span style={styles.todayValue}>{todayMl} ml</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>今日喂奶次数</span>
            <span style={styles.todayValue}>{todayFeedingCount} 次</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>近24小时奶量</span>
            <span style={styles.todayValue}>{recent24hMl} ml</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>近24小时喂奶次数</span>
            <span style={styles.todayValue}>{recent24hFeedingCount} 次</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>今日睡眠时长</span>
            <span style={styles.todayValue}>{formatDuration(todaySleepMin)}</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>最新体重</span>
            <span style={styles.todayValue}>{latestWeight == null ? '--' : `${latestWeight.toFixed(2)} kg`}</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>最新身高</span>
            <span style={styles.todayValue}>{latestHeight == null ? '--' : `${latestHeight.toFixed(1)} cm`}</span>
          </div>
          <div style={styles.todayCard}>
            <span style={styles.cardLabel}>宝宝月龄</span>
            <span style={styles.todayValue}>{ageText}</span>
          </div>
        </div>
      </section>

      {/* 喂养分析 */}
      <section style={styles.statsSection}>
        <div style={styles.analysisHeader}>
          <h3 style={{ ...styles.sectionTitle, marginBottom: 0 }}>喂养分析</h3>
          <div style={styles.tabs}>
            {[3, 7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                style={{ ...styles.tab, ...(days === d ? styles.tabActive : {}) }}
              >
                近 {d} 天
              </button>
            ))}
          </div>
        </div>
        <div style={styles.cards}>
          <div style={styles.card}>
            <span style={styles.cardLabel}>日均喂奶次数</span>
            <span style={styles.cardValue}>{avgFeedingCount.toFixed(1)} 次</span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>日均奶量</span>
            <span style={styles.cardValue}>{Math.round(avgFeedingMl)} ml</span>
          </div>
        </div>
        {chartData.length > 0 && (
          <div style={styles.statsChartCard}>
            <span style={styles.chartTitle}>每日喂奶量与次数</span>
            <FeedingComboChart data={chartData} barKey="total_ml" lineKey="feeding_count" />
          </div>
        )}
      </section>

      {/* 睡眠分析 */}
      <section style={styles.statsSection}>
        <h3 style={styles.sectionTitle}>睡眠分析</h3>
        <div style={styles.cards}>
          <div style={styles.card}>
            <span style={styles.cardLabel}>睡眠总时长</span>
            <span style={styles.cardValue}>{formatDuration(totalSleepMin)}</span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>睡眠次数</span>
            <span style={styles.cardValue}>{sleepSessions} 次</span>
          </div>
          {days > 0 && (
            <div style={styles.card}>
              <span style={styles.cardLabel}>日均睡眠</span>
              <span style={styles.cardValue}>
                {formatDuration(Math.round(totalSleepMinForAvg / Math.max(avgDates.length, 1)))}
              </span>
            </div>
          )}
        </div>
        {chartData.length > 0 && (
          <div style={styles.statsChartCard}>
            <span style={styles.chartTitle}>每日睡眠时长</span>
            <SimpleBarChart data={chartData} dataKey="total_minutes" color="#85cdca" />
          </div>
        )}

        {sleepData.periods?.length > 0 && (
          <div style={styles.periods}>
            <h4 style={styles.periodsTitle}>睡眠时间段</h4>
            {sleepData.periods.map((p, i) => (
              <div key={i} style={styles.periodItem}>
                <span style={styles.periodTime}>
                  {formatTime(p.start)} - {formatTime(p.end)}
                </span>
                <span style={styles.periodDur}>{formatDuration(p.duration_minutes)}</span>
                <span style={styles.periodDate}>{p.date}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 护理分析 */}
      <section style={styles.statsSection}>
        <h3 style={styles.sectionTitle}>护理分析</h3>
        <div style={styles.cards}>
          <div style={styles.card}>
            <span style={styles.cardLabel}>排便次数（近{days + 1}天）</span>
            <span style={styles.cardValue}>{totalStoolCount} 次</span>
          </div>
        </div>
      </section>

      {/* 生长分析 */}
      <section style={styles.statsSection}>
        <h3 style={styles.sectionTitle}>生长分析（体重 + 身高）</h3>
        <div style={styles.cards}>
          <div style={styles.card}>
            <span style={styles.cardLabel}>最新体重</span>
            <span style={styles.cardValue}>{latestWeight == null ? '--' : `${latestWeight.toFixed(2)} kg`}</span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>体重区间变化</span>
            <span style={styles.cardValue}>
              {weightDelta == null ? '--' : `${weightDelta > 0 ? '+' : ''}${weightDelta.toFixed(2)} kg`}
            </span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>最新身高</span>
            <span style={styles.cardValue}>{latestHeight == null ? '--' : `${latestHeight.toFixed(1)} cm`}</span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>身高区间变化</span>
            <span style={styles.cardValue}>
              {heightDelta == null ? '--' : `${heightDelta > 0 ? '+' : ''}${heightDelta.toFixed(1)} cm`}
            </span>
          </div>
          <div style={styles.card}>
            <span style={styles.cardLabel}>记录次数</span>
            <span style={styles.cardValue}>
              体重 {growthSeries.reduce((s, d) => s + (d.weight_count || 0), 0)} / 身高 {growthSeries.reduce((s, d) => s + (d.height_count || 0), 0)}
            </span>
          </div>
        </div>
        {growthSeries.length > 0 && (
          <div style={styles.statsChartCard}>
            <span style={styles.chartTitle}>每日身高体重趋势（按日均值）</span>
            <GrowthLineChart data={growthSeries} />
          </div>
        )}
      </section>

      {/* 趋势明细 */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>趋势明细</h3>
        <div style={styles.table}>
          <div style={styles.tableRow}>
            <span style={{ ...styles.th, ...styles.dateCell }}>日期</span>
            <span style={{ ...styles.th, ...styles.metricCell }}>奶量</span>
            <span style={{ ...styles.th, ...styles.metricCell }}>次数</span>
            <span style={{ ...styles.th, ...styles.metricCell }}>睡眠</span>
            <span style={{ ...styles.th, ...styles.metricCell }}>体重</span>
            <span style={{ ...styles.th, ...styles.metricCell }}>身高</span>
          </div>
          {trendData.length ? (
            [...trendData].reverse().map(row => (
              <div key={row.date} style={styles.tableRow}>
                <span style={styles.dateCell}>{row.date}</span>
                <span style={styles.metricCell}>{row.total_ml || 0} ml</span>
                <span style={styles.metricCell}>{row.feeding_count || 0} 次</span>
                <span style={styles.metricCell}>{formatDuration(row.total_minutes)}</span>
                <span style={styles.metricCell}>{row.avg_weight_kg == null ? '--' : `${Number(row.avg_weight_kg).toFixed(2)} kg`}</span>
                <span style={styles.metricCell}>{row.avg_height_cm == null ? '--' : `${Number(row.avg_height_cm).toFixed(1)} cm`}</span>
              </div>
            ))
          ) : (
            <div style={styles.empty}>暂无数据</div>
          )}
        </div>
      </section>
    </div>
  )
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 24 },
  pageTitle: { fontSize: '1.15rem', fontWeight: 700, marginBottom: -10 },
  analysisHeader: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'nowrap',
  },
  tabs: {
    display: 'flex',
    gap: 6,
    flexWrap: 'nowrap',
    whiteSpace: 'nowrap',
  },
  todaySection: {
    background: 'var(--stats-section-bg-soft)',
    borderRadius: 18,
    padding: 18,
    border: '1px solid var(--stats-border-strong)',
    boxShadow: '0 6px 20px rgba(201, 125, 82, 0.06)',
  },
  todayHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  todayDate: {
    fontSize: '0.82rem',
    color: 'var(--stats-muted-2)',
    fontWeight: 500,
  },
  todayCards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
    gap: 10,
  },
  todayCard: {
    background: 'var(--stats-card-bg)',
    borderRadius: 12,
    padding: 12,
    textAlign: 'center',
    border: '1px solid var(--stats-border)',
  },
  todayValue: {
    fontSize: '1.02rem',
    fontWeight: 700,
    color: 'var(--stats-text)',
  },
  tab: {
    padding: '5px 10px',
    borderRadius: 8,
    background: 'var(--stats-surface)',
    border: '1px solid var(--stats-border)',
    color: 'var(--stats-muted)',
    fontSize: '0.78rem',
    lineHeight: 1.1,
  },
  tabActive: {
    background: '#e8a87c',
    color: '#fff',
    borderColor: '#e8a87c',
  },
  section: {
    background: 'var(--stats-surface)',
    borderRadius: 16,
    padding: 20,
    border: '1px solid var(--stats-border)',
  },
  statsSection: {
    background: 'var(--stats-section-bg)',
    borderRadius: 18,
    padding: 20,
    border: '1px solid var(--stats-border)',
    boxShadow: '0 8px 24px rgba(201, 125, 82, 0.08)',
  },
  sectionTitle: { fontSize: '1rem', marginBottom: 16, fontWeight: 600 },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
    gap: 12,
  },
  card: {
    background: 'var(--stats-card-bg)',
    borderRadius: 12,
    padding: 14,
    textAlign: 'center',
    border: '1px solid var(--stats-border)',
  },
  cardLabel: { fontSize: '0.8rem', color: 'var(--stats-muted)', display: 'block', marginBottom: 6 },
  cardValue: { fontSize: '1rem', fontWeight: 600 },
  chartCard: {
    marginTop: 16,
    padding: 16,
    background: 'var(--stats-card-bg)',
    borderRadius: 12,
    border: '1px solid var(--stats-border)',
  },
  statsChartCard: {
    marginTop: 16,
    padding: 16,
    background: 'var(--stats-section-bg-soft)',
    borderRadius: 14,
    border: '1px solid var(--stats-border)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.7)',
  },
  chartTitle: { fontSize: '0.9rem', color: 'var(--stats-muted)', display: 'block', marginBottom: 4 },
  periods: {
    marginTop: 16,
    paddingTop: 16,
    borderTop: '1px solid var(--stats-border)',
  },
  periodsTitle: { fontSize: '0.95rem', marginBottom: 12, color: 'var(--stats-muted)' },
  periodItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid var(--stats-border)',
    fontSize: '0.95rem',
  },
  periodTime: { flex: 1 },
  periodDur: { fontWeight: 500, color: '#85cdca' },
  periodDate: { fontSize: '0.85rem', color: 'var(--stats-muted)' },
  table: {
    background: 'var(--stats-surface)',
    borderRadius: 14,
    overflowX: 'auto',
    border: '1px solid var(--stats-border)',
  },
  tableRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, 1.2fr) minmax(86px, 1fr) minmax(76px, 0.8fr) minmax(110px, 1fr) minmax(100px, 1fr) minmax(100px, 1fr)',
    alignItems: 'center',
    columnGap: 10,
    padding: '12px 16px',
    borderBottom: '1px solid var(--stats-border)',
    fontSize: '0.92rem',
    minWidth: 690,
  },
  th: { fontWeight: 600, color: 'var(--stats-muted)' },
  dateCell: { whiteSpace: 'nowrap' },
  metricCell: {
    textAlign: 'right',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  empty: { padding: 32, textAlign: 'center', color: 'var(--stats-muted)' },
}






