import { createServer as createHttpServer } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreateToken, tokenMatches } from './auth.js'
import { claudeCommand, resolveExecutable, runClaude } from './claude.js'
import { createConversationStore } from './conversations.js'
import { createJobStore } from './jobs.js'
import { openWithDefaultApp, pickFolder as pickFolderDialog } from './oshelpers.js'
import { resolveInside, validateWikiDir } from './paths.js'
import { DEFAULT_ROLE, ROLES, isRole, writeRolePrompts } from './roles.js'
import { claudeProjectsDir, removeClaudeSession } from './sessions.js'
import { createSettingsStore } from './settings.js'

const DAEMON_DIR = fileURLToPath(new URL('.', import.meta.url))
const MAX_BODY = 16_384
const MAX_QUESTION = 4000
const PURGE_INTERVAL_MS = 3_600_000
// Upper bound on model turns per question, so a search that never converges stops instead of running on.
const DEFAULT_MAX_TURNS = 40
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
// Mermaid diagrams carry inline <style> and style attributes; scripts stay limited to 'self'.
// blob: is for WIKI images, which the page fetches with the token header and shows as blob URLs.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'"
// Raster images only: an SVG can carry script, and a blob URL of it opened in a tab would run in this origin.
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_ATTACHMENTS = 300

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function empty(res, status) {
  res.writeHead(status, { 'Cache-Control': 'no-store' })
  res.end()
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body 過大')
    chunks.push(chunk)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('body 不是合法 JSON') }
}

function isMarkdown(path) {
  return typeof path === 'string' && path.toLowerCase().endsWith('.md')
}

export function createServer({ token, settings, conversations, jobs, runQuestion, openFile, pickFolder, webDir, checkHost = false, log = () => {} }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('server token 格式無效')

  // Resolve a WIKI-relative path against the conversation's WIKI (or the current setting).
  // Only .md files, unless `image` is set: then only the raster image types in IMAGE_TYPES.
  async function wikiFile(conversationId, path, { image = false } = {}) {
    let root = settings.get().wikiDir
    if (conversationId) {
      const conversation = await conversations.get(conversationId)
      if (!conversation) return { status: 404, error: '找不到這個對話' }
      root = conversation.wikiDir
    }
    const allowed = p => image ? typeof p === 'string' && Boolean(IMAGE_TYPES[extname(p).toLowerCase()]) : isMarkdown(p)
    if (!allowed(path)) {
      return { status: 400, error: image ? `只能讀取 ${Object.keys(IMAGE_TYPES).join('、')} 圖片` : '只能開啟 .md 檔' }
    }
    const file = await resolveInside(root, path)
    if (!file) return { status: 404, error: '找不到這個 WIKI 檔案' }
    // resolveInside follows symlinks: check the real target too, so a.png -> evil.exe is never opened.
    if (!allowed(file)) return { status: 400, error: '連結指向的檔案類型不允許' }
    return { file, root }
  }

  async function serveStatic(res, pathname) {
    let rel
    try { rel = decodeURIComponent(pathname.slice(1)) || 'index.html' } catch { return false }
    const type = STATIC_TYPES[extname(rel).toLowerCase()]
    if (!type) return false
    const file = await resolveInside(webDir, rel)
    if (!file) return false
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' }
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP
    res.writeHead(200, headers)
    res.end(await readFile(file))
    return true
  }

  async function sendQuestion(req, res, id) {
    let body
    try { body = await readBody(req) } catch (error) { json(res, 400, { error: error.message }); return }
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    if (!question || question.length > MAX_QUESTION) { json(res, 400, { error: `問題不能是空白，也不能超過 ${MAX_QUESTION} 字` }); return }
    const conversation = await conversations.get(id)
    if (!conversation) { json(res, 404, { error: '找不到這個對話' }); return }
    if (!(await validateWikiDir(conversation.wikiDir))) { json(res, 409, { error: `這個對話的 WIKI 路徑已不存在：${conversation.wikiDir}` }); return }

    const tools = []
    const texts = []
    const job = jobs.start(id, () => runQuestion({ conversation, question }), {
      onEvent(event) {
        if (event.kind === 'session') void conversations.markSessionStarted(id).catch(() => {})
        else if (event.kind === 'tool') {
          tools.push({ tool: event.tool, detail: event.detail })
          // Text before a tool call was narration (now a Note step); a failed answer keeps only what came after.
          texts.length = 0
        }
        else if (event.kind === 'text') texts.push(event.text)
      },
      onTerminal(_job, event) {
        const answer = event.kind === 'done'
          ? { text: event.text, sources: event.sources, tools, error: null }
          : { text: texts.join('\n\n'), sources: [], tools, error: event.message }
        if (event.stats) answer.stats = event.stats
        return conversations.addAnswer(id, answer)
      },
    })
    if (!job) { json(res, 409, { error: '上一個問題還在回答中' }); return }
    // Called in the same tick as jobs.start, so the question is queued before any answer write.
    await conversations.addQuestion(id, question)
    json(res, 201, { jobId: job.id })
  }

  function streamEvents(res, job) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    let unsubscribe = () => {}
    let heartbeat
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      res.end()
    }
    res.on('close', finish)
    unsubscribe = job.subscribe(event => {
      if (closed) return
      const write = () => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`) }
      // Send the terminal event only after the answer is saved, so a reload right after it sees the answer.
      if (event.kind === 'done' || event.kind === 'error') void job.settled.then(() => { write(); finish() })
      else write()
    })
    if (closed) unsubscribe()
    else heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000)
  }

  const server = createHttpServer(async (req, res) => {
    try {
      if (checkHost) {
        const port = server.address()?.port
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { json(res, 403, { error: '不允許的 Host' }); return }
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') { json(res, 200, { ok: true }); return }
      if (req.method === 'GET' && !path.startsWith('/conversations') && !path.startsWith('/jobs/') &&
        !path.startsWith('/wiki/') && !path.startsWith('/settings') && path !== '/roles' && await serveStatic(res, path)) return

      // Authenticate before parsing a body or starting work.
      if (!tokenMatches(token, req.headers['x-wikichat-token'])) { json(res, 401, { error: 'token 無效或未提供' }); return }

      if (path === '/conversations') {
        if (req.method === 'GET') {
          const items = await conversations.list({ query: url.searchParams.get('q') || '' })
          json(res, 200, { items: items.map(item => ({ ...item, running: Boolean(jobs.runningFor(item.id)) })) })
          return
        }
        if (req.method === 'POST') {
          let body
          try { body = await readBody(req) } catch (error) { json(res, 400, { error: error.message }); return }
          if (!isRole(body?.role)) { json(res, 400, { error: `身分必須是 ${Object.keys(ROLES).join('、')} 其中之一` }); return }
          json(res, 201, await conversations.create({ wikiDir: settings.get().wikiDir, role: body.role }))
          return
        }
      }

      let match = path.match(/^\/conversations\/([^/]+)$/)
      if (match) {
        const id = match[1]
        if (req.method === 'GET') {
          const conversation = await conversations.get(id)
          if (!conversation) { json(res, 404, { error: '找不到這個對話' }); return }
          json(res, 200, {
            ...conversation,
            runningJobId: jobs.runningFor(id)?.id || null,
            wikiDirAvailable: Boolean(await validateWikiDir(conversation.wikiDir)),
          })
          return
        }
        if (req.method === 'DELETE') {
          const job = jobs.runningFor(id)
          if (job) { job.cancel(); await job.settled }
          const title = (await conversations.get(id))?.title
          const removed = await conversations.remove(id)
          if (removed) log(`${new Date().toLocaleString('zh-TW', { hour12: false })} 已刪除對話：${title || '（未命名）'}（${id}）`)
          empty(res, removed ? 204 : 404)
          return
        }
      }

      match = path.match(/^\/conversations\/([^/]+)\/messages$/)
      if (match && req.method === 'POST') { await sendQuestion(req, res, match[1]); return }

      match = path.match(/^\/jobs\/([^/]+)\/(events|cancel)$/)
      if (match) {
        const job = jobs.get(match[1])
        if (match[2] === 'events' && req.method === 'GET') {
          if (!job) { json(res, 404, { error: '找不到這個 job' }); return }
          streamEvents(res, job)
          return
        }
        if (match[2] === 'cancel' && req.method === 'POST') {
          if (!job) { json(res, 404, { error: '找不到這個 job' }); return }
          job.cancel()
          empty(res, 202)
          return
        }
      }

      if (path === '/wiki/file' && req.method === 'GET') {
        const found = await wikiFile(url.searchParams.get('conv'), url.searchParams.get('path'))
        if (!found.file) { json(res, found.status, { error: found.error }); return }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(await readFile(found.file))
        return
      }

      if (path === '/wiki/asset' && req.method === 'GET') {
        const found = await wikiFile(url.searchParams.get('conv'), url.searchParams.get('path'), { image: true })
        if (!found.file) { json(res, found.status, { error: found.error }); return }
        if ((await stat(found.file)).size > MAX_IMAGE_BYTES) { json(res, 413, { error: '圖片超過 20MB' }); return }
        res.writeHead(200, {
          'Content-Type': IMAGE_TYPES[extname(found.file).toLowerCase()],
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(await readFile(found.file))
        return
      }

      // Images of a document converted from Word, kept in <folder>/.attachments/<document name>/.
      // The document's own image links were cut off in conversion, so the preview lists these instead.
      if (path === '/wiki/attachments' && req.method === 'GET') {
        const docPath = url.searchParams.get('path')
        const found = await wikiFile(url.searchParams.get('conv'), docPath)
        if (!found.file) { json(res, found.status, { error: found.error }); return }
        const folder = docPath.replace(/\\/g, '/').split('/').slice(0, -1)
        const dir = await resolveInside(found.root,[...folder, '.attachments', basename(docPath, extname(docPath))].join('/'), { directory: true })
        let names = []
        if (dir) {
          const entries = await readdir(dir, { withFileTypes: true })
          names = entries
            .filter(entry => entry.isFile() && IMAGE_TYPES[extname(entry.name).toLowerCase()])
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
            .slice(0, MAX_ATTACHMENTS)
        }
        json(res, 200, { images: names })
        return
      }

      if (path === '/roles' && req.method === 'GET') {
        json(res, 200, { roles: Object.entries(ROLES).map(([id, label]) => ({ id, label })), defaultRole: DEFAULT_ROLE })
        return
      }

      if (path === '/wiki/open' && req.method === 'POST') {
        let body
        try { body = await readBody(req) } catch (error) { json(res, 400, { error: error.message }); return }
        // Pictures cited in an answer open in the default image viewer, like .md files do in theirs.
        const found = await wikiFile(body?.conversationId, body?.path, { image: !isMarkdown(body?.path) })
        if (!found.file) { json(res, found.status, { error: found.error }); return }
        await openFile(found.file)
        empty(res, 204)
        return
      }

      if (path === '/settings') {
        if (req.method === 'GET') { json(res, 200, settings.get()); return }
        if (req.method === 'PUT') {
          let body
          try { body = await readBody(req) } catch (error) { json(res, 400, { error: error.message }); return }
          try { json(res, 200, await settings.setWikiDir(body?.wikiDir)) } catch (error) { json(res, 400, { error: error.message }) }
          return
        }
      }

      if (path === '/settings/pick-folder' && req.method === 'POST') {
        try { json(res, 200, { path: await pickFolder() }) } catch { json(res, 500, { error: '無法開啟資料夾選擇視窗' }) }
        return
      }

      json(res, 404, { error: '找不到這個路徑' })
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'daemon 處理請求失敗' })
      else res.end()
    }
  })
  return server
}

export async function main() {
  const port = Number(process.env.WIKICHAT_PORT || 7798)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WIKICHAT_PORT 必須介於 1 與 65535')
  const retentionDays = Number(process.env.WIKICHAT_RETENTION_DAYS || 14)
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('WIKICHAT_RETENTION_DAYS 必須是正數')
  const maxTurns = Number(process.env.WIKICHAT_MAX_TURNS || DEFAULT_MAX_TURNS)
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) throw new Error('WIKICHAT_MAX_TURNS 必須是正整數')
  const configDir = process.env.WIKICHAT_CONFIG_DIR || join(homedir(), '.wikichat')
  const defaultWikiDir = process.env.WIKICHAT_WIKI_DIR || join(homedir(), 'Desktop', 'WIKI')
  const claudeSetting = process.env.WIKICHAT_CLAUDE || 'claude'
  const promptFiles = await writeRolePrompts({
    systemFile: join(DAEMON_DIR, 'prompts', 'system.md'),
    agentFile: join(DAEMON_DIR, 'prompts', 'agent.md'),
    dir: join(configDir, 'prompts'),
  })

  const token = await loadOrCreateToken(configDir)
  const settings = await createSettingsStore({ configDir, defaultWikiDir })
  const projectsDir = claudeProjectsDir()
  // Claude's own session files go with the conversation, so they never outlive the retention period.
  const conversations = createConversationStore({
    dir: join(configDir, 'conversations'),
    retentionDays,
    onRemove: id => removeClaudeSession(projectsDir, id),
  })
  const jobs = createJobStore()
  const server = createServer({
    token,
    settings,
    conversations,
    jobs,
    checkHost: true,
    log: line => console.log(line),
    webDir: join(DAEMON_DIR, '..', 'web'),
    openFile: openWithDefaultApp,
    pickFolder: pickFolderDialog,
    runQuestion: ({ conversation, question }) => runClaude({
      command: claudeCommand(claudeSetting),
      wikiDir: conversation.wikiDir,
      question,
      sessionId: conversation.id,
      resume: conversation.sessionStarted,
      promptFile: promptFiles[conversation.role],
      maxTurns,
    }),
  })

  const purge = () => conversations.purgeExpired()
    .then(count => { if (count) console.log(`已清除 ${count} 個超過 ${retentionDays} 天的對話`) })
    .catch(error => console.error(`清除過期對話失敗：${error.message}`))
  await purge()
  setInterval(purge, PURGE_INTERVAL_MS).unref()

  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  const executable = await resolveExecutable(claudeCommand(claudeSetting)[0]).catch(error => `（${error.message}）`)
  console.log(`wiki-ask daemon：http://127.0.0.1:${port}`)
  console.log(`token：${token}`)
  console.log(`WIKI：${settings.get().wikiDir}${(await validateWikiDir(settings.get().wikiDir)) ? '' : '（找不到這個資料夾，請在網頁上變更）'}`)
  console.log(`claude：${executable}`)

  const stop = () => { jobs.cancelAll(); server.close(); server.closeAllConnections() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
