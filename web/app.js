import { elapsedText, shortPath, statsText, visibleAnswer } from './format.js'
import { splitFrontMatter } from './frontmatter.js'
import { IMAGE_EXTENSIONS, attachmentPath, classifyHref, classifyImage, dirOf, findHeading, isTruncatedDataImage, wrapSpacedTargets } from './links.js'
import { createSseParser } from './sse.js'

const TOKEN_KEY = 'wikichat.token'
const ROLE_KEY = 'wikichat.role'
const CLICK_DELAY_MS = 250
const TOOL_LABELS = { Read: '🔍 讀取', Grep: '🔎 搜尋', Glob: '📂 列出', Note: '💬' }
const DRAFT_RENDER_MS = 80 // re-render the streaming text at most this often
const LIST_POLL_MS = 4000 // refresh the list while some conversation is still answering
const SEARCH_DELAY_MS = 250
const COPIED_MS = 1500
// Stay pinned to the bottom while streaming, unless the user scrolled up to read.
const STICK_THRESHOLD_PX = 80

const $ = id => document.getElementById(id)
const els = {
  layout: $('layout'),
  wikiPath: $('wiki-path'),
  wikiChange: $('wiki-change'),
  wikiForm: $('wiki-form'),
  wikiInput: $('wiki-input'),
  wikiBrowse: $('wiki-browse'),
  wikiCancel: $('wiki-cancel'),
  wikiError: $('wiki-error'),
  newChat: $('new-chat'),
  search: $('conversation-search'),
  list: $('conversation-list'),
  tokenBar: $('token-bar'),
  tokenInput: $('token-input'),
  banner: $('banner'),
  messages: $('messages'),
  roleBar: $('role-bar'),
  composer: $('composer'),
  question: $('question'),
  send: $('send'),
  stop: $('stop'),
  preview: $('preview'),
  previewTitle: $('preview-title'),
  previewBody: $('preview-body'),
  previewClose: $('preview-close'),
  previewBack: $('preview-back'),
}

const state = {
  token: '',
  conversations: [],
  current: null, // the open conversation, or null for a new unsaved one
  job: null, // { id, conversationId, abort: AbortController }
  previewPath: null,
  previewStack: [], // documents opened in the preview by following links; see showPreview
  roles: [], // [{ id, label }] from the daemon
  defaultRole: '',
  role: '', // the role for the next new conversation
  query: '', // conversation list search
  listTimer: null,
}

// ---- token ----

function readStoredToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

function storeToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token) } catch {}
}

function takeTokenFromHash() {
  const match = location.hash.match(/(?:^#|&)token=([a-f0-9]{64})/)
  if (!match) return null
  history.replaceState(null, '', location.pathname + location.search)
  return match[1]
}

// ---- role ----

// The role list lives in daemon/roles.js; the page asks for it instead of keeping its own copy.
async function loadRoles() {
  const { roles, defaultRole } = await apiJson('/roles')
  state.roles = roles
  state.defaultRole = defaultRole
  state.role = readStoredRole()
}

function readStoredRole() {
  let stored = null
  try { stored = localStorage.getItem(ROLE_KEY) } catch {}
  return state.roles.some(role => role.id === stored) ? stored : state.defaultRole
}

function chooseRole(role) {
  state.role = role
  try { localStorage.setItem(ROLE_KEY, role) } catch {}
  renderRoleBar()
}

function roleLabel(role) {
  return state.roles.find(item => item.id === role)?.label || role
}

// A new conversation lets the user pick a role; an existing one keeps the role it was created with.
function renderRoleBar() {
  els.roleBar.replaceChildren()
  if (state.current) {
    els.roleBar.append('身分：', el('span', 'role-current', roleLabel(state.current.role)), '　開新對話可換身分')
    return
  }
  els.roleBar.append('用哪個身分提問：')
  for (const { id: role, label } of state.roles) {
    const button = el('button', 'role-option', label)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(role === state.role))
    button.addEventListener('click', () => chooseRole(role))
    els.roleBar.append(button)
  }
}

// ---- token ----

function showTokenBar(show) {
  els.tokenBar.hidden = !show
  if (show) els.tokenInput.focus()
}

class UnauthorizedError extends Error {}

async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'X-WikiChat-Token': state.token }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
  if (res.status === 401) {
    showTokenBar(true)
    throw new UnauthorizedError('token 無效或未提供')
  }
  return res
}

async function apiJson(path, options) {
  const res = await api(path, options)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `請求失敗（${res.status}）`)
  return data
}

// ---- helpers ----

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

let mermaidReady = false
let mermaidSeq = 0
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')

function setupMermaid() {
  if (!window.mermaid) return false
  if (!mermaidReady) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: darkScheme.matches ? 'dark' : 'default' })
    mermaidReady = true
  }
  return true
}

// Turn ```mermaid blocks into diagrams. A block that does not parse (or is still streaming in) stays as code.
function renderDiagrams(target) {
  if (!setupMermaid()) return
  for (const code of target.querySelectorAll('pre > code.language-mermaid')) {
    const pre = code.parentElement
    const id = `mermaid-${++mermaidSeq}`
    window.mermaid.render(id, code.textContent).then(({ svg }) => {
      if (!pre.isConnected) return
      const diagram = el('div', 'diagram')
      diagram.innerHTML = svg
      pre.replaceWith(diagram)
    }).catch(() => {
      // mermaid leaves its scratch element behind when parsing fails.
      document.getElementById(`d${id}`)?.remove()
    })
  }
}

// diagrams: false while text is still streaming in, so a diagram is not re-drawn on every chunk.
// base: the WIKI folder the markdown lives in, for resolving its relative links and images ('' = WIKI root).
// Returns how many images were cut off in conversion (see isTruncatedDataImage), and a promise that
// settles once the WIKI images are in place.
function renderMarkdown(target, text, { diagrams = true, base = '' } = {}) {
  // Built in a <template> first: its content is inert, so relative <img> sources are not requested
  // (unauthenticated, against the app itself) before they are rewritten.
  const template = document.createElement('template')
  template.innerHTML = window.DOMPurify.sanitize(window.marked.parse(wrapSpacedTargets(text)))
  for (const link of template.content.querySelectorAll('a')) wireLink(link, base, target)
  const images = []
  let truncated = 0
  for (const img of template.content.querySelectorAll('img')) {
    if (isTruncatedDataImage(img.getAttribute('src'))) truncated++
    const image = wireImage(img, base)
    if (image) images.push(image)
  }
  releaseImages(target)
  target.replaceChildren(template.content)
  if (diagrams) renderDiagrams(target)
  const imagesLoaded = images.length ? loadImages(target, images) : Promise.resolve()
  return { truncated, imagesLoaded }
}

function wireLink(link, base, container) {
  const destination = classifyHref(link.getAttribute('href'), base)
  if (destination.type === 'external') {
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    return
  }
  const span = el('span', destination.type === 'text' ? 'internal-link' : 'wiki-link')
  span.append(...link.childNodes)
  link.replaceWith(span)
  if (destination.type === 'text') {
    const href = link.getAttribute('href') || ''
    try { span.title = decodeURI(href) } catch { span.title = href }
    return
  }
  span.title = destination.type === 'anchor' ? `#${destination.anchor}` : destination.path
  span.setAttribute('role', 'link')
  span.tabIndex = 0
  const follow = () => {
    if (destination.type === 'anchor') scrollToHeading(container, destination.anchor)
    else void followWikiLink(destination, container === els.previewBody)
  }
  span.addEventListener('click', follow)
  span.addEventListener('keydown', event => { if (event.key === 'Enter') follow() })
}

// Returns { img, path } for a WIKI image to fetch, after replacing anything that cannot be shown.
function wireImage(img, base) {
  const src = img.getAttribute('src') || ''
  const image = classifyImage(src, base)
  const alt = img.getAttribute('alt') || ''
  if (image.type === 'wiki') {
    img.removeAttribute('src')
    img.classList.add('wiki-image')
    return { img, path: image.path }
  }
  if (image.type === 'external') {
    // The page only loads its own content (CSP), so an outside image becomes a link to open it.
    const link = el('a', 'image-note', `🖼 外部圖片：${alt || image.url}`)
    link.href = image.url
    link.title = image.url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    img.replaceWith(link)
  } else if (isTruncatedDataImage(src)) {
    img.replaceWith(el('span', 'image-note', `🖼 ${alt || '這張圖'}在轉檔時被截斷了`))
  } else if (!/^data:/i.test(src)) {
    const note = el('span', 'image-note', `🖼 ${alt || '圖片'}（無法顯示這個圖片）`)
    note.title = src
    img.replaceWith(note)
  }
  return null
}

// <img> cannot send the token header, so WIKI images are fetched with it and shown as blob URLs.
const blobUrls = new WeakMap()

function releaseImages(target) {
  for (const url of blobUrls.get(target) || []) URL.revokeObjectURL(url)
  blobUrls.delete(target)
}

async function loadImages(target, images) {
  const conversationId = state.current?.id
  await Promise.all(images.map(async ({ img, path }) => {
    try {
      const params = new URLSearchParams({ path })
      if (conversationId) params.set('conv', conversationId)
      const res = await api(`/wiki/asset?${params}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const url = URL.createObjectURL(await res.blob())
      // The container may have been re-rendered while this was loading.
      if (!img.isConnected) { URL.revokeObjectURL(url); return }
      blobUrls.set(target, [...(blobUrls.get(target) || []), url])
      img.src = url
      await img.decode().catch(() => {}) // so the caller sees the final layout
    } catch (error) {
      if (!img.isConnected) return
      const name = path.split('/').pop()
      // Pages exported from another wiki often point at pictures that were never copied into this one.
      const text = error.message === '404' ? `🖼 原圖沒有匯入 WIKI：${name}` : `🖼 圖片讀不到：${img.alt || name}`
      const note = el('span', 'image-note', text)
      note.title = path
      img.replaceWith(note)
    }
  }))
}

function scrollToHeading(container, anchor, { quiet = false } = {}) {
  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')]
  const index = findHeading(headings.map(heading => heading.textContent), anchor)
  if (index === -1) { if (!quiet) showBanner(`這份文件裡找不到「${anchor}」這一節`); return }
  headings[index].scrollIntoView({ block: 'start' })
}

function folderName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path
}

function relativeTime(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return `${Math.floor(hours / 24)} 天前`
}

function showBanner(message) {
  els.banner.textContent = message || ''
  els.banner.hidden = !message
}

function reportError(error) {
  if (error instanceof UnauthorizedError || error.name === 'AbortError') return
  showBanner(error.message)
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight
}

function nearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = els.messages
  return scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX
}

// Runs a DOM update and keeps the view at the bottom only if it already was there.
function keepPinned(update) {
  const pinned = nearBottom()
  update()
  if (pinned) scrollToBottom()
}

async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text)
    const label = button.textContent
    button.textContent = '已複製'
    button.disabled = true
    setTimeout(() => { button.textContent = label; button.disabled = false }, COPIED_MS)
  } catch {
    showBanner('無法寫入剪貼簿')
  }
}

// ---- WIKI source settings ----

async function loadSettings() {
  const settings = await apiJson('/settings')
  els.wikiPath.textContent = settings.wikiDir
  els.wikiPath.title = settings.wikiDir
  return settings
}

function toggleWikiForm(open) {
  els.wikiForm.hidden = !open
  els.wikiError.hidden = true
  if (open) {
    els.wikiInput.value = els.wikiPath.textContent
    els.wikiInput.focus()
    els.wikiInput.select()
  }
}

async function saveWikiDir(event) {
  event.preventDefault()
  els.wikiError.hidden = true
  try {
    const settings = await apiJson('/settings', { method: 'PUT', body: { wikiDir: els.wikiInput.value.trim() } })
    els.wikiPath.textContent = settings.wikiDir
    els.wikiPath.title = settings.wikiDir
    toggleWikiForm(false)
  } catch (error) {
    if (error instanceof UnauthorizedError) return
    els.wikiError.textContent = error.message
    els.wikiError.hidden = false
  }
}

async function browseWikiDir() {
  els.wikiBrowse.disabled = true
  try {
    const { path } = await apiJson('/settings/pick-folder', { method: 'POST' })
    if (path) els.wikiInput.value = path
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      els.wikiError.textContent = error.message
      els.wikiError.hidden = false
    }
  } finally {
    els.wikiBrowse.disabled = false
  }
}

// ---- conversation list ----

async function loadList() {
  const params = state.query ? `?${new URLSearchParams({ q: state.query })}` : ''
  const { items } = await apiJson(`/conversations${params}`)
  state.conversations = items
  renderList()
  // A conversation answering in the background (not the one on screen) has no stream to tell us it ended.
  clearTimeout(state.listTimer)
  state.listTimer = items.some(item => item.running)
    ? setTimeout(() => void loadList().catch(() => {}), LIST_POLL_MS)
    : null
}

function renderList() {
  els.list.replaceChildren()
  if (!state.conversations.length) {
    els.list.append(el('div', 'empty-list', state.query ? '找不到符合的對話' : '還沒有對話'))
    return
  }
  for (const item of state.conversations) {
    const row = el('div', 'conversation')
    if (item.id === state.current?.id) row.classList.add('active')
    row.tabIndex = 0
    const main = el('div', 'conversation-main')
    main.append(el('div', 'conversation-title', item.title || '（未命名）'))
    const meta = el('div', 'conversation-meta')
    if (item.running) meta.append(el('span', 'conversation-running', '● 回答中'), ' · ')
    meta.append(`${roleLabel(item.role)} · ${folderName(item.wikiDir)} · ${relativeTime(item.updatedAt)}`)
    main.append(meta)
    main.title = item.title
    const remove = el('button', 'conversation-delete', '🗑')
    remove.type = 'button'
    remove.title = '刪除對話'
    let confirmTimer
    remove.addEventListener('click', event => {
      event.stopPropagation()
      // Deleting cannot be undone, so the first click only asks for confirmation.
      if (!remove.classList.contains('confirming')) {
        remove.classList.add('confirming')
        remove.textContent = '確定刪除？'
        confirmTimer = setTimeout(() => { remove.classList.remove('confirming'); remove.textContent = '🗑' }, 3000)
        return
      }
      clearTimeout(confirmTimer)
      void deleteConversation(item.id)
    })
    remove.addEventListener('keydown', event => event.stopPropagation())
    row.append(main, remove)
    row.addEventListener('click', () => void openConversation(item.id))
    row.addEventListener('keydown', event => { if (event.key === 'Enter') void openConversation(item.id) })
    els.list.append(row)
  }
}

async function deleteConversation(id) {
  try {
    await apiJson(`/conversations/${id}`, { method: 'DELETE' })
    if (state.current?.id === id) startNewConversation()
    await loadList()
  } catch (error) {
    reportError(error)
  }
}

// ---- chat ----

function detachJob() {
  state.job?.abort.abort()
  state.job = null
}

function startNewConversation() {
  detachJob()
  state.current = null
  closePreview()
  showBanner('')
  renderMessages()
  renderList()
  renderRoleBar()
  updateComposer()
  els.question.focus()
}

async function openConversation(id) {
  detachJob()
  showBanner('')
  if (state.current?.id !== id) closePreview()
  try {
    state.current = await apiJson(`/conversations/${id}`)
  } catch (error) {
    reportError(error)
    await loadList().catch(() => {})
    return
  }
  renderMessages()
  renderList()
  renderRoleBar()
  if (state.current.runningJobId) {
    const live = appendLiveAnswer()
    void followJob(state.current.runningJobId, id, live)
  }
  updateComposer()
}

function renderMessages() {
  els.messages.replaceChildren()
  const conversation = state.current
  if (!conversation || !conversation.messages.length) {
    els.messages.append(el('div', 'welcome', '問 WIKI 一個問題，例如「點餐流程是什麼？」'))
    return
  }
  const { messages } = conversation
  // Only the last question can be asked again, and only when nothing is running and the WIKI is still there.
  const canRetry = !conversation.runningJobId && conversation.wikiDirAvailable !== false
  const lastQuestion = messages.findLast(message => message.role === 'user')?.text
  messages.forEach((message, index) => {
    const isLast = index === messages.length - 1
    if (message.role === 'user') {
      const pending = isLast && !conversation.runningJobId
      els.messages.append(renderUser(message.text, { pending, retry: pending && canRetry ? message.text : null }))
    } else {
      els.messages.append(renderAnswer(message, { retry: isLast && message.error && canRetry ? lastQuestion : null }))
    }
  })
  scrollToBottom()
}

function retryButton(question) {
  const button = el('button', 'message-action', '↻ 重新提問')
  button.type = 'button'
  button.addEventListener('click', () => {
    if (state.job) return
    els.question.value = question
    void send()
  })
  return button
}

function renderUser(text, { pending = false, retry = null } = {}) {
  const node = el('div', 'message user')
  node.append(el('div', 'bubble', text))
  if (pending) {
    const note = el('div', 'pending-note', '（未完成：daemon 中斷或已取消）')
    if (retry) note.append(' ', retryButton(retry))
    node.append(note)
  }
  return node
}

function renderTools(tools, open) {
  const details = el('details', 'tools')
  details.open = open
  const summary = el('summary', null, `查了 ${tools.filter(tool => tool.tool !== 'Note').length} 個步驟`)
  const list = el('ul')
  for (const tool of tools) list.append(el('li', null, `${TOOL_LABELS[tool.tool] || tool.tool} ${tool.detail}`.trim()))
  details.append(summary, list)
  return { details, summary, list }
}

function renderSources(sources) {
  const wrap = el('div', 'sources')
  for (const path of sources) {
    const button = el('button', 'source', shortPath(path))
    button.type = 'button'
    button.title = `${path}（單擊預覽，雙擊用預設程式開啟）`
    let timer
    button.addEventListener('click', () => {
      clearTimeout(timer)
      timer = setTimeout(() => void openPreview(path), CLICK_DELAY_MS)
    })
    button.addEventListener('dblclick', () => {
      clearTimeout(timer)
      void openWithDefaultApp(path)
    })
    wrap.append(button)
  }
  return wrap
}

function renderAnswer(message, { retry = null } = {}) {
  const node = el('div', 'message assistant')
  if (message.tools?.length) node.append(renderTools(message.tools, false).details)
  const bubble = el('div', 'bubble markdown')
  renderMarkdown(bubble, message.text)
  node.append(bubble)
  if (message.error) node.append(el('div', 'answer-error', message.error))
  if (message.sources?.length) node.append(renderSources(message.sources))
  const actions = el('div', 'message-actions')
  if (message.text) {
    const copy = el('button', 'message-action', '⧉ 複製')
    copy.type = 'button'
    copy.title = '複製回答（Markdown）'
    copy.addEventListener('click', () => void copyText(copy, message.text))
    actions.append(copy)
  }
  if (retry) actions.append(retryButton(retry))
  const stats = statsText(message.stats)
  if (stats) {
    const line = el('span', 'answer-stats', stats)
    line.title = '金額是依 API 定價估算的參考值；用訂閱方案登入時不一定實際計費'
    actions.append(line)
  }
  if (actions.childElementCount) node.append(actions)
  return node
}

function appendLiveAnswer() {
  const node = el('div', 'message assistant')
  const tools = renderTools([], true)
  tools.details.hidden = true
  const thinking = el('div', 'thinking', '思考中…')
  const bubble = el('div', 'bubble markdown')
  bubble.hidden = true
  // Finished text blocks (diagrams drawn) and the block still streaming in (re-rendered as it grows).
  const done = el('div')
  const draft = el('div')
  bubble.append(done, draft)
  node.append(tools.details, thinking, bubble)
  els.messages.append(node)
  scrollToBottom()
  const startedAt = Date.now()
  const clock = setInterval(() => { thinking.textContent = `思考中…（${elapsedText(Date.now() - startedAt)}）` }, 1000)
  return { node, tools, thinking, bubble, done, draft, clock, renderTimer: null, toolCount: 0, texts: [], draftText: '' }
}

function stopLive(live) {
  clearInterval(live.clock)
  clearTimeout(live.renderTimer)
  live.thinking.remove()
}

function renderDraft(live) {
  live.renderTimer = null
  keepPinned(() => {
    renderMarkdown(live.draft, visibleAnswer(live.draftText), { diagrams: false })
    live.bubble.hidden = !live.texts.length && !live.draftText.trim()
  })
}

function handleLiveEvent(live, event) {
  if (event.kind === 'delta') {
    live.draftText += event.text
    live.renderTimer ??= setTimeout(() => renderDraft(live), DRAFT_RENDER_MS)
    return
  }
  keepPinned(() => {
    if (event.kind === 'tool') {
      // The text so far was narration; the daemon sends it again as a Note step, so clear it from the answer.
      live.texts = []
      live.draftText = ''
      live.done.replaceChildren()
      live.draft.replaceChildren()
      live.bubble.hidden = true
      if (event.tool !== 'Note') live.toolCount += 1
      live.tools.details.hidden = false
      live.tools.summary.textContent = `查了 ${live.toolCount} 個步驟`
      live.tools.list.append(el('li', null, `${TOOL_LABELS[event.tool] || event.tool} ${event.detail}`.trim()))
    } else if (event.kind === 'text') {
      // A finished block replaces its streamed draft.
      clearTimeout(live.renderTimer)
      live.renderTimer = null
      live.texts.push(event.text)
      live.draftText = ''
      live.draft.replaceChildren()
      renderMarkdown(live.done, visibleAnswer(live.texts.join('\n\n')))
      live.bubble.hidden = false
    }
  })
}

async function followJob(jobId, conversationId, live) {
  const abort = new AbortController()
  state.job = { id: jobId, conversationId, abort }
  updateComposer()
  let terminal = null
  try {
    const res = await api(`/jobs/${jobId}/events`, { signal: abort.signal })
    if (!res.ok || !res.body) throw new Error('無法取得回答串流')
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    const feed = createSseParser(event => {
      if (event.kind === 'done' || event.kind === 'error') terminal = event
      else handleLiveEvent(live, event)
    })
    while (!terminal) {
      const { value, done } = await reader.read()
      if (done) break
      feed(value)
    }
    reader.cancel().catch(() => {})
  } catch (error) {
    if (error.name === 'AbortError') { stopLive(live); return }
    reportError(error)
  }
  stopLive(live)
  if (state.job?.id !== jobId) return
  state.job = null
  // The server saves the answer before sending the terminal event, so a reload shows the stored answer.
  if (state.current?.id === conversationId) await openConversation(conversationId)
  await loadList().catch(() => {})
}

async function send(event) {
  event?.preventDefault()
  const question = els.question.value.trim()
  if (!question || state.job) return
  showBanner('')
  els.send.disabled = true
  let created = null
  try {
    if (!state.current) {
      created = await apiJson('/conversations', { method: 'POST', body: { role: state.role } })
      state.current = { ...created, runningJobId: null, wikiDirAvailable: true }
      renderRoleBar()
    }
    const conversationId = state.current.id
    const { jobId } = await apiJson(`/conversations/${conversationId}/messages`, { method: 'POST', body: { question } })
    els.question.value = ''
    state.current.messages.push({ role: 'user', text: question })
    state.current.runningJobId = jobId
    if (state.current.messages.length === 1) els.messages.replaceChildren()
    els.messages.append(renderUser(question))
    const live = appendLiveAnswer()
    void loadList().catch(() => {})
    void followJob(jobId, conversationId, live)
  } catch (error) {
    // The first question was refused: drop the conversation just created, so no empty "（未命名）" stays behind.
    if (created && state.current?.id === created.id && !state.current.messages.length) {
      void apiJson(`/conversations/${created.id}`, { method: 'DELETE' }).catch(() => {})
      state.current = null
      renderRoleBar()
    }
    reportError(error)
  } finally {
    updateComposer()
  }
}

async function stop() {
  if (!state.job) return
  els.stop.disabled = true
  try {
    await apiJson(`/jobs/${state.job.id}/cancel`, { method: 'POST' })
  } catch (error) {
    reportError(error)
  } finally {
    els.stop.disabled = false
  }
}

function updateComposer() {
  const running = Boolean(state.job)
  const unavailable = state.current && state.current.wikiDirAvailable === false
  els.question.disabled = unavailable
  els.send.disabled = running || unavailable
  els.stop.hidden = !running
  if (unavailable) showBanner(`這個對話的 WIKI 路徑已不存在：${state.current.wikiDir}`)
}

// ---- preview & open ----

// The preview keeps a history of the documents opened by following links: [{ path, scrollTop }, …],
// the last entry being the one on screen.
let previewSeq = 0
let previewRender = 0 // bumped on every preview render, so a late attachment list is not added twice

// A Word-converted document whose pictures were cut off: list the pictures from its attachment folder
// at the end. Their order follows the file names, which need not match where they sat in the text.
async function showAttachments(path, render) {
  const params = new URLSearchParams({ path })
  if (state.current) params.set('conv', state.current.id)
  let images
  try { ({ images } = await apiJson(`/wiki/attachments?${params}`)) } catch { return }
  if (render !== previewRender || state.previewPath !== path || !images.length) return
  const section = el('section', 'attachments')
  section.append(
    el('h3', null, `本文附圖（${images.length} 張）`),
    el('p', 'image-note', '文件裡的圖片在轉檔時被截斷了。下面是同名附件資料夾裡的圖檔，依檔名排序，不一定對應文中的位置。'),
  )
  const items = images.map(name => {
    const img = document.createElement('img')
    img.alt = name
    const figure = el('figure', 'attachment')
    figure.append(img, el('figcaption', null, name))
    section.append(figure)
    return { img, path: attachmentPath(path, name) }
  })
  els.previewBody.append(section)
  void loadImages(els.previewBody, items)
}

function previewEntry() {
  return state.previewStack.at(-1) || null
}

function updatePreviewHeader() {
  const entry = previewEntry()
  els.previewTitle.textContent = entry?.path || ''
  els.previewTitle.title = entry?.path || ''
  els.previewBack.hidden = state.previewStack.length < 2
}

async function fetchWikiFile(path) {
  const params = new URLSearchParams({ path })
  if (state.current) params.set('conv', state.current.id)
  const res = await api(`/wiki/file?${params}`)
  if (res.ok) return { text: await res.text() }
  const data = await res.json().catch(() => null)
  return { status: res.status, error: data?.error || `無法讀取（${res.status}）` }
}

function renderPreview(text, { path, scrollTop = 0, anchor = null }) {
  const { frontMatter, body } = splitFrontMatter(text)
  const { truncated, imagesLoaded } = renderMarkdown(els.previewBody, body, { base: dirOf(path) })
  const render = ++previewRender
  if (truncated) void showAttachments(path, render)
  if (frontMatter) els.previewBody.prepend(el('pre', 'front-matter', frontMatter))
  els.previewBody.scrollTop = scrollTop
  if (anchor) scrollToHeading(els.previewBody, anchor)
  // Pictures above the target push it down as they load, so go there again once they are in,
  // unless the reader has scrolled in the meantime.
  if (!anchor && !scrollTop) return
  const settled = els.previewBody.scrollTop
  void imagesLoaded.then(() => {
    if (render !== previewRender || els.previewBody.scrollTop !== settled) return
    if (anchor) scrollToHeading(els.previewBody, anchor, { quiet: true })
    else els.previewBody.scrollTop = scrollTop
  })
}

// mode: 'open' starts a new history (citation tags, links in answers); 'push' follows a link in the
// document on screen; 'back' returns to the previous document; 'reload' redraws the one on screen.
// A failed 'push' or 'back' keeps the current document and says why in the banner.
async function showPreview(path, { mode = 'open', anchor = null, notFound = null } = {}) {
  const seq = ++previewSeq
  if (mode === 'open') {
    state.previewStack = [{ path, scrollTop: 0 }]
    state.previewPath = path
    els.layout.classList.add('with-preview')
    els.preview.hidden = false
    updatePreviewHeader()
    releaseImages(els.previewBody)
    els.previewBody.textContent = '讀取中…'
  }
  let result
  try {
    // Answers may cite a picture itself (e.g. an attachment Claude looked at); show it as it is.
    result = isImagePath(path) ? { image: true } : await fetchWikiFile(path)
  } catch (error) {
    if (error instanceof UnauthorizedError) return
    result = { error: error.message }
  }
  if (seq !== previewSeq) return
  if (result.error) {
    const message = result.status === 404 && notFound ? notFound : result.error
    if (mode === 'open') els.previewBody.textContent = message
    else showBanner(`無法開啟 ${path}：${message}`)
    return
  }
  let scrollTop = 0
  if (mode === 'push') {
    previewEntry().scrollTop = els.previewBody.scrollTop
    state.previewStack.push({ path, scrollTop: 0 })
  } else if (mode === 'back') {
    state.previewStack.pop()
    scrollTop = previewEntry().scrollTop
  } else if (mode === 'reload') {
    scrollTop = els.previewBody.scrollTop
  }
  state.previewPath = path
  updatePreviewHeader()
  if (result.image) renderImagePreview(path)
  else renderPreview(result.text, { path, scrollTop, anchor })
}

function isImagePath(path) {
  return IMAGE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))
}

function renderImagePreview(path) {
  previewRender++
  releaseImages(els.previewBody)
  const img = document.createElement('img')
  img.alt = path.split('/').pop()
  els.previewBody.replaceChildren(img)
  void loadImages(els.previewBody, [{ img, path }])
}

function openPreview(path, options) {
  return showPreview(path, { ...options, mode: 'open' })
}

function followWikiLink(destination, fromPreview) {
  const notFound = destination.type === 'folder' ? '這個資料夾沒有 index.md' : null
  const options = { anchor: destination.anchor || null, notFound }
  return fromPreview ? showPreview(destination.path, { ...options, mode: 'push' }) : openPreview(destination.path, options)
}

function previewBack() {
  const previous = state.previewStack.at(-2)
  if (previous) void showPreview(previous.path, { mode: 'back' })
}

function closePreview() {
  previewSeq += 1
  state.previewPath = null
  state.previewStack = []
  releaseImages(els.previewBody)
  els.preview.hidden = true
  els.layout.classList.remove('with-preview')
}

async function openWithDefaultApp(path) {
  try {
    await apiJson('/wiki/open', { method: 'POST', body: { conversationId: state.current?.id, path } })
  } catch (error) {
    reportError(error)
  }
}

// ---- startup ----

async function boot() {
  try {
    await loadSettings()
    await loadRoles()
    await loadList()
    showTokenBar(false)
    startNewConversation()
  } catch (error) {
    reportError(error)
  }
}

els.tokenBar.addEventListener('submit', event => {
  event.preventDefault()
  const token = els.tokenInput.value.trim()
  if (!token) return
  state.token = token
  storeToken(token)
  els.tokenInput.value = ''
  void boot()
})
els.wikiChange.addEventListener('click', () => toggleWikiForm(els.wikiForm.hidden))
els.wikiCancel.addEventListener('click', () => toggleWikiForm(false))
els.wikiForm.addEventListener('submit', saveWikiDir)
els.wikiBrowse.addEventListener('click', () => void browseWikiDir())
els.newChat.addEventListener('click', startNewConversation)
let searchTimer
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim()
    void loadList().catch(reportError)
  }, SEARCH_DELAY_MS)
})
// Diagrams are drawn with the theme of the moment, so redraw them when Windows switches light/dark.
darkScheme.addEventListener('change', () => {
  mermaidReady = false
  if (!state.job) renderMessages()
  if (state.previewPath) void showPreview(state.previewPath, { mode: 'reload' })
})
els.composer.addEventListener('submit', send)
els.stop.addEventListener('click', () => void stop())
els.previewClose.addEventListener('click', closePreview)
els.previewBack.addEventListener('click', previewBack)
els.question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
})

const fromHash = takeTokenFromHash()
if (fromHash) storeToken(fromHash)
state.token = fromHash || readStoredToken()
if (state.token) void boot()
else showTokenBar(true)
