import { useEffect, useState } from 'react'
import './AgentDashboard.css'

const number = value => Number(value || 0).toLocaleString('zh-CN')
const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const statusName = { running: '处理中', success: '完成', error: '失败' }
const channelName = { xiaoai: '小爱同学', weixin: '微信' }

export default function AgentDashboard({ babyId }) {
  const [filters, setFilters] = useState({ days: '7', channel: '', status: '', q: '' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [updated, setUpdated] = useState(null)
  useEffect(() => {
    const controller = new AbortController()
    let timer
    setLoading(true); setData(null)
    async function refresh() {
      try {
        const query = new URLSearchParams({ ...filters, page, baby_id: babyId })
        const response = await fetch(`/api/agent-dashboard?${query}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`读取失败（${response.status}）`)
        const result = await response.json()
        if (!controller.signal.aborted) { setData(result); setError(''); setUpdated(new Date()) }
      } catch (e) { if (!controller.signal.aborted) setError(e.message) }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(refresh, 15000) }
      }
    }
    refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [babyId, filters, page, revision])
  const change = (key, value) => { setPage(1); setFilters(old => ({ ...old, [key]: value })) }
  const summary = data?.summary
  return <section className="agent-dashboard">
    <header className="agent-heading"><div><h1>Agent 看板</h1><p>小爱与微信的请求、用量和处理记录 · 北京时间</p></div>
      <button onClick={() => setRevision(v => v + 1)} disabled={loading}>刷新</button></header>
    <div className="agent-filters">
      <label>时间范围<select value={filters.days} onChange={e => change('days', e.target.value)}><option value="1">最近 24 小时</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></label>
      <label>渠道<select value={filters.channel} onChange={e => change('channel', e.target.value)}><option value="">全部渠道</option><option value="xiaoai">小爱同学</option><option value="weixin">微信</option></select></label>
      <label>状态<select value={filters.status} onChange={e => change('status', e.target.value)}><option value="">全部状态</option><option value="success">完成</option><option value="error">失败</option><option value="running">处理中</option></select></label>
      <label className="agent-search">搜索提问或回复<input type="search" value={filters.q} onChange={e => change('q', e.target.value)} placeholder="例如：上次喝奶" /></label>
    </div>
    {error && <p role="alert" className="agent-error">{error}，可点击刷新重试。</p>}
    <div className="agent-metrics" aria-busy={loading}>
      {[['请求数', summary?.requests], ['输入 Token', summary?.input_tokens], ['输出 Token', summary?.output_tokens], ['模型回退', summary?.fallbacks], ['失败请求', summary?.errors]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value == null ? '—' : number(value)}</strong></div>)}
    </div>
    <p className="agent-note">Token 累计包含已返回用量的重试和回退调用；未返回的用量不估算。{summary?.incomplete_usage > 0 && `有 ${summary.incomplete_usage} 条请求用量不完整。`}历史从启用采集后开始记录。</p>
    <div className="agent-list-heading"><h2>历史提问</h2><span>{updated ? `${time(updated)} 更新 · 每 15 秒刷新` : '正在读取'}</span></div>
    {loading && <p role="status" className="agent-empty">正在加载请求记录…</p>}
    {!loading && data?.items.length === 0 && <p className="agent-empty">当前筛选下还没有请求。通过小爱或微信提问后，记录会显示在这里。</p>}
    {data?.items.map(row => <details className="agent-request" key={row.id}>
      <summary><div className="agent-request-meta"><span>{channelName[row.channel] || row.channel} · {time(row.started_at)}</span><span className={row.status === 'error' ? 'agent-error' : ''}>{statusName[row.status]}{row.fallback ? ' · 已回退' : ''}</span></div>
        <h3>{row.question || '（空请求）'}</h3><p className="agent-preview">{row.reply || row.error || '等待处理结果…'}</p>
        <div className="agent-request-meta"><span>{row.model || '规则处理'} · {row.duration_ms == null ? '计时中' : `${(row.duration_ms / 1000).toFixed(1)} 秒`}</span><span>{number(row.input_tokens + row.output_tokens)} Token{!row.usage_complete ? '（部分）' : ''} · 展开详情</span></div>
      </summary>
      <div className="agent-detail"><h4>完整回复</h4><p className="agent-reply">{row.reply || '暂无回复'}</p>{row.error && <p className="agent-error">{row.error}</p>}
        <h4>模型处理过程</h4>
        {!row.attempts.length && <p>未调用模型。</p>}
        {row.attempts.map((attempt, index) => <div className="agent-attempt" key={index}>
          <p><strong>{index + 1}. {attempt.provider === 'local' ? '本地模型' : attempt.provider === 'gateway' ? '本地中转 → GPT' : '云端模型'} · {attempt.model}</strong></p>
          <p>思考深度：{attempt.reasoning} · {statusName[attempt.status]} · {attempt.duration_ms == null ? '处理中' : `${(attempt.duration_ms / 1000).toFixed(1)} 秒`} · 模型调用 {attempt.calls.length} 次</p>
          {attempt.calls.map((call, i) => <p key={i}>调用 {i + 1}：输入 {call.input_tokens == null ? '未知' : number(call.input_tokens)} / 输出 {call.output_tokens == null ? '未知' : number(call.output_tokens)} Token</p>)}
          {attempt.error && <p className="agent-error">失败原因：{attempt.error}</p>}
          {(attempt.tools || (attempt.tool ? [{ name: attempt.tool, arguments: attempt.arguments, result: attempt.result }] : [])).map((tool, i) => <div key={i}><p>执行工具 {i + 1}：{tool.name}</p><details><summary>工具输入与结果</summary><pre>{JSON.stringify({ input: tool.arguments, output: tool.result }, null, 2)}</pre></details></div>)}
        </div>)}
      </div>
    </details>)}
    {data?.total > 0 && <footer className="agent-pagination"><button disabled={page === 1} onClick={() => setPage(v => v - 1)}>上一页</button><span>第 {page} / {Math.ceil(data.total / data.page_size)} 页 · 共 {number(data.total)} 条</span><button disabled={page * data.page_size >= data.total} onClick={() => setPage(v => v + 1)}>下一页</button></footer>}
  </section>
}
