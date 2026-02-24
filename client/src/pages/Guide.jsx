import { Children, cloneElement, isValidElement, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

async function readSseStream(response, handlers) {
  if (!response.body) throw new Error('流式响应为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let splitIndex = buffer.indexOf('\n\n')

    while (splitIndex >= 0) {
      const block = buffer.slice(0, splitIndex)
      buffer = buffer.slice(splitIndex + 2)
      splitIndex = buffer.indexOf('\n\n')

      if (!block.trim()) continue
      const lines = block.split('\n')
      let eventName = 'message'
      const dataLines = []

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }

      if (!dataLines.length) continue
      const raw = dataLines.join('\n')
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        continue
      }
      if (handlers[eventName]) handlers[eventName](payload)
    }
  }
}

function normalizeCitationIndex(rawId, refsLength, zeroBasedMode = false) {
  const n = Number(rawId)
  if (!Number.isFinite(n)) return null
  if (zeroBasedMode) {
    if (n >= 0 && n < refsLength) return n + 1
    return null
  }
  if (n >= 1 && n <= refsLength) return n
  return null
}

function findReferenceByCitationId(rawId, refs) {
  const target = String(rawId).trim()
  if (!target) return null
  const idx = refs.findIndex((ref) => String(ref?.citation_id ?? '').trim() === target)
  if (idx < 0) return null
  return { index: idx + 1, ref: refs[idx] }
}

function buildCitationView(content, references, anchorPrefix = 'msg-0') {
  const text = String(content || '')
  const refs = Array.isArray(references) ? references : []
  const idMatches = [...text.matchAll(/\[(?:ID:)?(\d+)\](?!\()/g)]
  const numericIds = idMatches
    .map((m) => Number(m?.[1]))
    .filter((n) => Number.isFinite(n))
  // RAGFlow 在本项目中按 0-based 返回 ID（0->第1条，7->第8条）
  // 仅在明显越界且符合 1-based 时回退到 1-based，避免异常模型输出无法映射。
  const maxId = numericIds.length ? Math.max(...numericIds) : -1
  const hasOutOfRangeForZeroBased = maxId >= refs.length && refs.length > 0
  const looksLikeOneBased = numericIds.every((n) => n >= 1 && n <= refs.length)
  const zeroBasedMode = !(hasOutOfRangeForZeroBased && looksLikeOneBased)
  const usedOriginalIndexes = new Set()
  const replaceCitationToken = (rawId, originalToken) => {
    const byCitationId = findReferenceByCitationId(rawId, refs)
    const index = byCitationId?.index ?? normalizeCitationIndex(rawId, refs.length, zeroBasedMode)
    if (!index) return originalToken
    usedOriginalIndexes.add(index)
    return `[${index}](#ref-${anchorPrefix}-${index})`
  }

  let markdown = text
    .replace(/\[ID:(\d+)\]/g, (_, rawId) => replaceCitationToken(rawId, `[ID:${rawId}]`))
    .replace(/\[(\d+)\](?!\()/g, (_, rawId) => replaceCitationToken(rawId, `[${rawId}]`))
  const allReferences = refs.map((ref, idx) => ({ ...ref, _originalIndex: idx + 1 }))
  if (!usedOriginalIndexes.size && allReferences.length > 0) {
    markdown = `${markdown}\n\n参考文档见下方列表。`
  }

  return {
    markdown,
    references: allReferences,
    citedIndexes: usedOriginalIndexes,
  }
}

function normalizeAssistantMarkdown(content) {
  const text = String(content || '')
  return text
    .replace(/(^|\n)(\d+)\.\s*\n+(?=\S)/g, '$1$2. ')
    .replace(/(^|\n)\s*[-*]\s*\n+(?=\S)/g, '$1- ')
    .replace(/\n{2,}(?=\s{0,3}\d+\.\s)/g, '\n')
    .replace(/\n{2,}(?=\s{0,3}[-*]\s)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

function compactListItemChildren(children) {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    if (typeof child.type !== 'string' || child.type !== 'p') return child
    return cloneElement(child, {
      style: {
        ...(child.props?.style || {}),
        margin: 0,
        lineHeight: 1.4,
      },
    })
  })
}

function getThinkingPreview(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function shorten(text, max = 96) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (s.length <= max) return s
  return `${s.slice(0, max)}...`
}

export default function Guide({ babyId }) {
  const [statusLoading, setStatusLoading] = useState(true)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [canChat, setCanChat] = useState(false)
  const [messages, setMessages] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState('')
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionItems, setSessionItems] = useState([])
  const [thinkingOpenMap, setThinkingOpenMap] = useState({})
  const [referencesOpenMap, setReferencesOpenMap] = useState({})
  const [aliveDotFrame, setAliveDotFrame] = useState(0)
  const listEndRef = useRef(null)
  const inputRef = useRef(null)
  const liveThinkingRef = useRef(null)

  useEffect(() => {
    if (!sending) {
      setAliveDotFrame(0)
      return
    }
    const timer = setInterval(() => {
      setAliveDotFrame((prev) => (prev + 1) % 5)
    }, 420)
    return () => clearInterval(timer)
  }, [sending])

  const createSession = async () => {
    setSessionLoading(true)
    try {
      const res = await fetch('/api/guide-ai/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '会话创建失败')

      setSessionId(data?.session_id || null)
      const welcome = String(data?.welcome_message || '').trim()
      setMessages(
        welcome
          ? [
              {
                role: 'assistant',
                content: welcome,
                thinking: '',
                references: [],
              },
            ]
          : []
      )
      setReferencesOpenMap({})
    } finally {
      setSessionLoading(false)
    }
  }

  const loadSessions = async () => {
    setSessionsLoading(true)
    try {
      const res = await fetch('/api/guide-ai/sessions?page=1&page_size=50')
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '会话列表获取失败')
      setSessionItems(Array.isArray(data?.sessions) ? data.sessions : [])
    } catch {
      setSessionItems([])
    } finally {
      setSessionsLoading(false)
    }
  }

  const openSessionPanel = async () => {
    setSessionPanelOpen(true)
    await loadSessions()
  }

  const switchSession = async (id) => {
    if (!id) return
    try {
      const res = await fetch(`/api/guide-ai/sessions/${id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '会话加载失败')
      setSessionId(data?.id || id)
      const history = Array.isArray(data?.messages) ? data.messages : []
      setMessages(
        history
          .filter((m) => ['assistant', 'user'].includes(String(m?.role || '')))
          .map((m) => ({
            role: m.role,
            content: String(m.content || ''),
            thinking: '',
            references: [],
          }))
      )
      setReferencesOpenMap({})
      setSessionPanelOpen(false)
      setError('')
    } catch {
      setError('会话加载失败，请稍后重试。')
    }
  }

  const deleteSession = async (id) => {
    if (!id) return
    try {
      const res = await fetch(`/api/guide-ai/sessions/${id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '会话删除失败')
      setSessionItems((prev) => prev.filter((s) => s.id !== id))
      if (sessionId === id) {
        clearConversation()
      }
    } catch {
      setError('会话删除失败，请稍后重试。')
    }
  }

  const refreshStatus = async () => {
    setStatusLoading(true)
    try {
      const res = await fetch('/api/guide-ai/status')
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '状态获取失败')

      const ready = Boolean(data?.ready)
      setCanChat(ready)
      if (!ready && data?.error) {
        setError('AI助手暂时不可用，请联系管理员检查后端配置。')
        return
      }

      setError('')
      await createSession()
    } catch {
      setCanChat(false)
      setError('AI助手暂时不可用，请稍后重试。')
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => {
    refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  useEffect(() => {
    if (!sending) return
    const el = liveThinkingRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages, sending])

  const clearConversation = () => {
    setSessionId(null)
    setMessages([])
    setThinkingOpenMap({})
    setReferencesOpenMap({})
    setError('')
    setInput('')
    if (canChat) {
      createSession().catch(() => {
        setError('新会话创建失败，请稍后重试。')
      })
    }
  }

  const sendQuestion = async (event) => {
    event.preventDefault()
    if (isComposing) return
    const question = input.trim()
    if (!question || sending || !canChat || !sessionId || sessionLoading) return

    const userMessage = { role: 'user', content: question, references: [] }
    const nextMessages = [...messages, userMessage]
    const pendingAssistant = { role: 'assistant', content: '', thinking: '', references: [] }

    setError('')
    setInput('')
    setSending(true)
    setMessages([...nextMessages, pendingAssistant])

    try {
      const res = await fetch('/api/guide-ai/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          session_id: sessionId,
          baby_id: babyId,
          messages: nextMessages.map((item) => ({
            role: item.role,
            content: item.content,
          })),
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || '问答失败')
      }

      let streamedAnswer = ''
      let streamedThinking = ''
      let streamedReferences = []

      const updateLastAssistant = (patch) => {
        setMessages((prev) => {
          const next = [...prev]
          const idx = next.length - 1
          if (idx < 0 || next[idx].role !== 'assistant') return prev
          next[idx] = { ...next[idx], ...patch }
          return next
        })
      }

      await readSseStream(res, {
        delta: (payload) => {
          if (payload?.session_id) setSessionId(payload.session_id)
          const incoming = String(payload?.delta || '')
          if (!incoming) return
          streamedAnswer += incoming
          updateLastAssistant({ content: streamedAnswer })
        },
        thinking: (payload) => {
          if (payload?.session_id) setSessionId(payload.session_id)
          let incoming = String(payload?.delta || '')
          if (!incoming) {
            const full = String(payload?.thinking || '')
            if (full.startsWith(streamedThinking)) {
              incoming = full.slice(streamedThinking.length)
            }
          }
          if (!incoming) return
          streamedThinking += incoming
          updateLastAssistant({ thinking: streamedThinking })
        },
        references: (payload) => {
          streamedReferences = Array.isArray(payload?.references) ? payload.references : []
          updateLastAssistant({ references: streamedReferences })
        },
        done: (payload) => {
          if (payload?.session_id) setSessionId(payload.session_id)
          const finalAnswer = String(payload?.answer || streamedAnswer).trim()
          const finalThinking = String(payload?.thinking || streamedThinking).trim()
          const finalReferences = Array.isArray(payload?.references) ? payload.references : streamedReferences
          updateLastAssistant({
            content: finalAnswer || '未返回答案',
            thinking: finalThinking,
            references: finalReferences,
          })
        },
        error: (payload) => {
          throw new Error(payload?.error || '问答失败')
        },
      })
    } catch {
      try {
        const fallbackRes = await fetch('/api/guide-ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            session_id: sessionId,
            baby_id: babyId,
            messages: nextMessages.map((item) => ({
              role: item.role,
              content: item.content,
            })),
          }),
        })
        const fallbackData = await fallbackRes.json()
        if (!fallbackRes.ok) throw new Error(fallbackData?.error || '问答失败')
        if (fallbackData?.session_id) setSessionId(fallbackData.session_id)
        setMessages((prev) => {
          const next = [...prev]
          const idx = next.length - 1
          if (idx < 0 || next[idx].role !== 'assistant') return prev
          next[idx] = {
            ...next[idx],
            content: fallbackData?.answer || '未返回答案',
            thinking: String(fallbackData?.thinking || ''),
            references: Array.isArray(fallbackData?.references) ? fallbackData.references : [],
          }
          return next
        })
        setError('')
      } catch {
        setError('问答失败，请稍后重试。')
        setMessages((prev) => {
          const next = [...prev]
          const idx = next.length - 1
          if (idx >= 0 && next[idx].role === 'assistant') {
            const hasContent = Boolean(String(next[idx].content || '').trim())
            next[idx] = {
              ...next[idx],
              content: hasContent ? next[idx].content : '抱歉，这次没有成功回答。你可以稍后再试一次。',
            }
          }
          return next
        })
      }
    } finally {
      setSending(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div style={styles.page}>
      <section style={styles.panel}>
        <header style={styles.header}>
          <div style={styles.headerMain}>
            <h1 style={styles.title}>AI问答</h1>
            <span style={styles.subtitle}>育儿知识库助手</span>
          </div>
          <div style={styles.headerActions}>
            <span style={styles.statusWrap}>
              <i
                style={{
                  ...styles.statusBlock,
                  ...(statusLoading || sessionLoading
                    ? styles.statusPending
                    : canChat
                      ? styles.statusReady
                      : styles.statusDown),
                }}
              />
              <span style={styles.statusText}>
                {statusLoading ? '检查中' : sessionLoading ? '初始化中' : canChat ? '在线' : '离线'}
              </span>
            </span>
            <button
              style={styles.iconBtn}
              onClick={openSessionPanel}
              disabled={statusLoading || sessionLoading}
              title="会话"
              aria-label="会话"
            >
              <svg viewBox="0 0 24 24" style={styles.iconSvg} aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h10" />
              </svg>
            </button>
            <button
              style={styles.iconBtn}
              onClick={clearConversation}
              disabled={sending || sessionLoading}
              title="新对话"
              aria-label="新对话"
            >
              <svg viewBox="0 0 24 24" style={styles.iconSvg} aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </header>

        <div style={styles.messages}>
          {messages.map((message, idx) => {
            const isUser = message.role === 'user'
            const normalizedContent = isUser ? message.content : normalizeAssistantMarkdown(message.content)
            const refAnchorPrefix = `msg-${idx}`
            const citationView = buildCitationView(normalizedContent, message.references, refAnchorPrefix)
            const thinkingRaw = String(message?.thinking || '').trim()
            const isStreamingCurrentAssistant = sending && !isUser && idx === messages.length - 1
            const showThinking = !isUser && (Boolean(thinkingRaw) || isStreamingCurrentAssistant)
            const isThinkingOpen = isStreamingCurrentAssistant || Boolean(thinkingOpenMap[idx])
            const thinkingPreview = shorten(getThinkingPreview(thinkingRaw), 110)
            const thinkingDisplayText = thinkingRaw
            const aliveDots = ['.', '..', '...', '..', '.'][aliveDotFrame]
            const waitingText = `正在阅读相关书籍${aliveDots}`
            const thinkingStatusText = `思考中${aliveDots}`
            const waitingLabel = (
              <>
                <svg viewBox="0 0 16 16" style={styles.waitingSpinner} aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.6" />
                  <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 8 8"
                      to="360 8 8"
                      dur="0.9s"
                      repeatCount="indefinite"
                    />
                  </path>
                </svg>
                {waitingText}
              </>
            )
            const thinkingStatusLabel = (
              <>
                <svg viewBox="0 0 16 16" style={styles.waitingSpinner} aria-hidden="true">
                  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1.6" />
                  <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <animateTransform
                      attributeName="transform"
                      type="rotate"
                      from="0 8 8"
                      to="360 8 8"
                      dur="0.9s"
                      repeatCount="indefinite"
                    />
                  </path>
                </svg>
                {thinkingStatusText}
              </>
            )
            return (
              <article
                key={`${message.role}-${idx}`}
                style={{
                  ...styles.messageRow,
                  ...(isUser ? styles.messageRowUser : styles.messageRowAssistant),
                }}
              >
                <div style={{ ...styles.messageContent, ...(isUser ? styles.userContent : styles.assistantContent) }}>
                  <div style={{ ...styles.roleLabel, ...(isUser ? styles.roleLabelUser : styles.roleLabelAssistant) }}>
                    {isUser ? '你' : '助手'}
                  </div>
                  {showThinking && (
                    <details
                      key={`thinking-${idx}-${isStreamingCurrentAssistant ? 'live' : 'done'}`}
                      open={isStreamingCurrentAssistant ? true : undefined}
                      onToggle={(e) => {
                        if (isStreamingCurrentAssistant) return
                        const open = Boolean(e.currentTarget?.open)
                        setThinkingOpenMap((prev) => ({ ...prev, [idx]: open }))
                      }}
                      style={styles.thinkingBox}
                    >
                      <summary style={styles.thinkingLine}>
                        <span style={styles.thinkingLabel}>思考</span>
                        {!isThinkingOpen && (
                          <span style={styles.thinkingPreview}>
                            {thinkingPreview || waitingLabel}
                          </span>
                        )}
                        {isThinkingOpen && (
                          <span style={styles.thinkingMeta}>
                            {isStreamingCurrentAssistant
                              ? (thinkingRaw ? thinkingStatusLabel : null)
                              : '已展开'}
                          </span>
                        )}
                      </summary>
                      <div
                        ref={isStreamingCurrentAssistant ? liveThinkingRef : null}
                        style={{
                          ...styles.thinkingText,
                          ...(isStreamingCurrentAssistant ? styles.thinkingTextLive : {}),
                        }}
                      >
                        {thinkingDisplayText || waitingLabel}
                      </div>
                    </details>
                  )}
                  <div style={styles.bubbleContent} className="guide-md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="guide-md-p" style={styles.mdP}>{children}</p>,
                        ul: ({ children }) => <ul className="guide-md-ul" style={styles.mdUl}>{children}</ul>,
                        ol: ({ children }) => <ol className="guide-md-ol" style={styles.mdOl}>{children}</ol>,
                        li: ({ children }) => <li className="guide-md-li" style={styles.mdLi}>{compactListItemChildren(children)}</li>,
                        hr: () => <hr style={styles.mdHr} />,
                        strong: ({ children }) => <strong style={styles.mdStrong}>{children}</strong>,
                        a: ({ href, children }) => {
                          const match = String(href || '').match(/^#ref-(.+)$/)
                          if (match) {
                            const targetId = `ref-${match[1]}`
                            return (
                              <a
                                href={href}
                                style={styles.citationLink}
                                onClick={(e) => {
                                  e.preventDefault()
                                  setReferencesOpenMap((prev) => ({ ...prev, [idx]: true }))
                                  requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                      const el = document.getElementById(targetId)
                                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                                    })
                                  })
                                }}
                              >
                                {children}
                              </a>
                            )
                          }
                          return (
                            <a href={href} style={styles.normalLink} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          )
                        },
                      }}
                    >
                      {citationView.markdown}
                    </ReactMarkdown>
                  </div>

                  {!isUser && Array.isArray(citationView.references) && citationView.references.length > 0 && (
                    <details
                      open={Boolean(referencesOpenMap[idx])}
                      onToggle={(e) => {
                        const open = Boolean(e.currentTarget?.open)
                        setReferencesOpenMap((prev) => ({ ...prev, [idx]: open }))
                      }}
                      style={styles.referencesWrap}
                    >
                      <summary style={styles.referencesSummary}>
                        参考来源（{citationView.references.length}，已引用 {citationView.citedIndexes?.size || 0}）
                      </summary>
                      <div style={styles.referenceList}>
                        {citationView.references.map((ref, refIndex) => (
                          <details
                            id={`ref-${refAnchorPrefix}-${ref._originalIndex || refIndex + 1}`}
                            key={`${ref.id || 'ref'}-${ref._originalIndex || refIndex + 1}`}
                            open={Boolean(citationView.citedIndexes?.has(ref._originalIndex))}
                            style={{
                              ...styles.referenceItem,
                              ...(citationView.citedIndexes?.has(ref._originalIndex) ? styles.referenceItemCited : {}),
                            }}
                          >
                            <summary style={styles.referenceTitle}>
                              [{ref._originalIndex || refIndex + 1}]
                              {' '}
                              {ref.document_name || '未知文档'}
                            </summary>
                            <div style={styles.referenceSnippet}>{ref.content || '暂无片段'}</div>
                          </details>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </article>
            )
          })}

          <div ref={listEndRef} />
        </div>

        <form style={styles.composerDock} onSubmit={sendQuestion}>
          <div style={styles.composer}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={(e) => {
                setIsComposing(false)
                setInput(e.target.value)
              }}
              placeholder={canChat ? (sessionLoading ? '正在初始化会话...' : '输入你的育儿问题...') : '助手暂时不可用'}
              disabled={!canChat || sending || sessionLoading || !sessionId}
              style={styles.input}
              rows={1}
            />
            <button
              type="submit"
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              style={styles.sendBtn}
              disabled={!canChat || sending || sessionLoading || !sessionId || !input.trim() || isComposing}
            >
              发送
            </button>
          </div>
          {error && <div style={styles.error}>{error}</div>}
        </form>
      </section>

      {sessionPanelOpen && (
        <div style={styles.sessionMask} onClick={() => setSessionPanelOpen(false)}>
          <aside style={styles.sessionPanel} onClick={(e) => e.stopPropagation()}>
            <div style={styles.sessionPanelHeader}>
              <strong style={styles.sessionPanelTitle}>历史会话</strong>
              <button style={styles.sessionCloseBtn} onClick={() => setSessionPanelOpen(false)}>
                关闭
              </button>
            </div>
            <div style={styles.sessionList}>
              {sessionsLoading && <div style={styles.sessionHint}>加载中...</div>}
              {!sessionsLoading && sessionItems.length === 0 && <div style={styles.sessionHint}>暂无历史会话</div>}
              {!sessionsLoading &&
                sessionItems.map((s) => (
                  <div key={s.id} style={styles.sessionItem}>
                    <button
                      style={{ ...styles.sessionMainBtn, ...(sessionId === s.id ? styles.sessionMainBtnActive : {}) }}
                      onClick={() => switchSession(s.id)}
                    >
                      <div style={styles.sessionName}>{s.name || s.id}</div>
                      <div style={styles.sessionTime}>{s.update_time || s.create_time || ''}</div>
                    </button>
                    <button style={styles.sessionDeleteBtn} onClick={() => deleteSession(s.id)}>
                      删
                    </button>
                  </div>
                ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

const styles = {
  page: {
    display: 'flex',
    justifyContent: 'center',
    minHeight: 'calc(100vh - 172px)',
  },
  panel: {
    width: '100%',
    maxWidth: 980,
    display: 'flex',
    flexDirection: 'column',
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
    boxShadow: 'none',
    overflow: 'hidden',
  },
  header: {
    padding: '10px 2px 8px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'nowrap',
  },
  headerMain: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: '1.1rem',
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
  },
  subtitle: {
    margin: 0,
    color: 'var(--text-muted)',
    fontSize: '0.8rem',
    whiteSpace: 'nowrap',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'nowrap',
    marginLeft: 'auto',
  },
  statusWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 2px',
    whiteSpace: 'nowrap',
  },
  statusBlock: {
    width: 10,
    height: 10,
    borderRadius: 2,
    display: 'inline-block',
  },
  statusText: {
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
  },
  iconBtn: {
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    lineHeight: 1,
    fontSize: '1rem',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  iconSvg: {
    width: 16,
    height: 16,
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  },
  statusPending: {
    background: '#f59e0b',
  },
  statusReady: {
    background: '#2563eb',
  },
  statusDown: {
    background: '#ef4444',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '10px 2px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 260,
    paddingBottom: 6,
  },
  messageRow: {
    display: 'flex',
    borderRadius: 8,
    padding: '2px 0',
  },
  messageRowAssistant: {
    justifyContent: 'flex-start',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageContent: {
    width: '100%',
    lineHeight: 1.65,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '0.95rem',
  },
  assistantContent: {
    maxWidth: '90%',
    paddingLeft: 0,
    borderLeft: 'none',
  },
  userContent: {
    maxWidth: '72%',
    textAlign: 'right',
    color: 'var(--text)',
    paddingRight: 0,
    borderRight: 'none',
  },
  bubbleContent: {
    margin: 0,
  },
  roleLabel: {
    fontSize: '0.73rem',
    marginBottom: 4,
    color: 'var(--text-muted)',
    letterSpacing: '0.02em',
  },
  roleLabelAssistant: {
    textAlign: 'left',
  },
  roleLabelUser: {
    textAlign: 'right',
  },
  mdP: {
    margin: '0 0 5px',
    lineHeight: 1.48,
  },
  mdUl: {
    margin: '3px 0 5px',
    paddingLeft: 18,
    lineHeight: 1.45,
  },
  mdOl: {
    margin: '3px 0 5px',
    paddingLeft: 18,
    lineHeight: 1.45,
  },
  mdLi: {
    margin: '0 0 2px',
    lineHeight: 1.42,
    paddingLeft: 0,
  },
  mdHr: {
    border: 0,
    borderTop: '1px solid var(--border)',
    margin: '6px 0',
  },
  mdStrong: {
    fontWeight: 700,
  },
  citationLink: {
    display: 'inline',
    padding: 0,
    color: '#155e95',
    textDecoration: 'none',
    margin: '0 2px',
    fontSize: '0.78em',
    lineHeight: 1,
    verticalAlign: 'super',
    fontWeight: 500,
    borderBottom: '1px dotted #60a5fa',
  },
  normalLink: {
    color: '#155e95',
    textDecoration: 'underline',
  },
  referencesWrap: {
    marginTop: 8,
  },
  thinkingBox: {
    margin: '0 0 10px',
    background: 'var(--guide-thinking-bg)',
    borderLeft: '3px solid var(--guide-thinking-border)',
    borderRadius: 4,
    padding: '4px 8px 6px',
  },
  thinkingLine: {
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.76rem',
    color: 'var(--guide-thinking-title)',
    userSelect: 'none',
    lineHeight: 1.35,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  thinkingLabel: {
    flex: '0 0 auto',
    color: 'var(--guide-thinking-label)',
    fontWeight: 600,
  },
  thinkingPreview: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--guide-thinking-preview)',
  },
  thinkingMeta: {
    flex: '0 0 auto',
    color: 'var(--guide-thinking-preview)',
    fontSize: '0.74rem',
    letterSpacing: '0.01em',
  },
  waitingSpinner: {
    width: 12,
    height: 12,
    marginRight: 6,
    verticalAlign: '-1px',
    color: 'var(--guide-thinking-preview)',
    display: 'inline-block',
  },
  thinkingText: {
    marginTop: 6,
    whiteSpace: 'pre-wrap',
    fontSize: '0.78rem',
    color: 'var(--guide-thinking-text)',
    lineHeight: 1.45,
    padding: '0 2px',
  },
  thinkingTextLive: {
    maxHeight: 'calc(1.45em * 3)',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    WebkitOverflowScrolling: 'touch',
  },
  referencesSummary: {
    cursor: 'pointer',
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
  },
  referenceList: {
    marginTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  referenceItem: {
    padding: '8px 9px',
    borderRadius: 10,
    background: 'var(--bg)',
    border: '1px solid var(--border)',
  },
  referenceItemCited: {
    background: 'rgba(21, 94, 149, 0.08)',
    border: '1px solid rgba(21, 94, 149, 0.35)',
    boxShadow: 'inset 0 0 0 1px rgba(21, 94, 149, 0.1)',
  },
  referenceTitle: {
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
    userSelect: 'none',
  },
  referenceSnippet: {
    marginTop: 6,
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
  },
  composerDock: {
    position: 'relative',
    padding: '8px 0 calc(env(safe-area-inset-bottom) + 6px)',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg)',
  },
  composer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: '1px solid var(--border)',
    borderRadius: 14,
    background: 'var(--bg)',
    padding: '6px 8px',
    minHeight: 44,
  },
  input: {
    flex: 1,
    width: '100%',
    resize: 'none',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    lineHeight: 1.45,
    minHeight: 30,
    maxHeight: 112,
    padding: '6px 8px',
    display: 'block',
    margin: 0,
  },
  sendBtn: {
    minWidth: 68,
    height: 32,
    borderRadius: 11,
    color: '#fff',
    background: 'linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)',
    fontWeight: 600,
    alignSelf: 'center',
  },
  error: {
    color: '#b42318',
    background: '#fff1f0',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '7px 10px',
    fontSize: '0.8rem',
    marginTop: 8,
  },
  sessionMask: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(17, 24, 39, 0.25)',
    zIndex: 1500,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  sessionPanel: {
    width: 'min(360px, 88vw)',
    height: '100%',
    background: 'var(--bg-card)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
  },
  sessionPanelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    borderBottom: '1px solid var(--border)',
  },
  sessionPanelTitle: {
    fontSize: '0.95rem',
  },
  sessionCloseBtn: {
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    borderRadius: 8,
    padding: '4px 8px',
    fontSize: '0.78rem',
  },
  sessionList: {
    padding: 10,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sessionHint: {
    color: 'var(--text-muted)',
    fontSize: '0.82rem',
  },
  sessionItem: {
    display: 'flex',
    gap: 6,
  },
  sessionMainBtn: {
    flex: 1,
    textAlign: 'left',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '7px 8px',
    background: 'var(--bg)',
  },
  sessionMainBtnActive: {
    borderColor: '#93c5fd',
    background: '#eff6ff',
  },
  sessionName: {
    fontSize: '0.82rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionTime: {
    fontSize: '0.72rem',
    color: 'var(--text-muted)',
    marginTop: 2,
  },
  sessionDeleteBtn: {
    width: 34,
    border: '1px solid #fecaca',
    color: '#b42318',
    background: '#fff1f0',
    borderRadius: 8,
    fontSize: '0.78rem',
  },
}
