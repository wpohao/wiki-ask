import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../server.js'
import { createSettingsStore } from '../settings.js'
import { createConversationStore } from '../conversations.js'
import { createJobStore } from '../jobs.js'

const TOKEN = 'a'.repeat(64)
const CONTENT = '# 金流串接'
const DAY = 86_400_000
let tmp, wikiA, wikiB, cfg, web, t
const servers = []

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wikichat-server-'))
  wikiA = join(tmp, 'WIKI A')
  wikiB = join(tmp, '知識庫 B')
  cfg = join(tmp, 'cfg')
  web = join(tmp, 'web')
  await mkdir(join(wikiA, '金流'), { recursive: true })
  await mkdir(wikiB)
  await mkdir(web)
  await writeFile(join(wikiA, '金流', '串接設計.md'), CONTENT)
  await writeFile(join(wikiA, 'index.txt'), 'txt')
  await writeFile(join(wikiB, 'only-b.md'), '# B')
  await writeFile(join(tmp, 'outside.md'), 'secret')
  await writeFile(join(web, 'index.html'), '<!doctype html><title>wiki_chat</title>')
  await writeFile(join(web, 'app.js'), 'console.log(1)')
  t = Date.parse('2026-10-01T00:00:00Z')
})

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  await rm(tmp, { recursive: true, force: true })
})

// A run handle whose events are scripted; a null entry means "wait until cancelled".
function scripted(events) {
  let cancel
  const cancelled = new Promise(resolve => { cancel = resolve })
  return {
    events: (async function* () {
      for (const event of events) {
        if (event === null) { await cancelled; return }
        yield event
      }
    })(),
    cancel,
  }
}

async function start({ runQuestion, scripts = [], jobs = createJobStore(), checkHost = false, log } = {}) {
  const calls = []
  const opened = []
  const settings = await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })
  const conversations = createConversationStore({ dir: join(cfg, 'conversations'), now: () => t })
  const server = createServer({
    token: TOKEN,
    settings,
    conversations,
    jobs,
    webDir: web,
    checkHost,
    log,
    runQuestion: runQuestion || (args => {
      calls.push(structuredClone(args))
      return scripted(scripts.shift() || [{ kind: 'done', text: '答', sources: [] }])
    }),
    openFile: async path => { opened.push(path) },
    pickFolder: async () => wikiB,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  const api = (path, { method = 'GET', body, token = TOKEN } = {}) => {
    const headers = {}
    if (token) headers['X-WikiChat-Token'] = token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  return { base, api, calls, opened, server }
}

async function sseEvents(api, jobId) {
  const text = await (await api(`/jobs/${jobId}/events`)).text()
  return text.split('\n\n').filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)))
}

async function newConversation(api, role = 'rd') {
  return (await api('/conversations', { method: 'POST', body: { role } })).json()
}

async function ask(api, id, question = '金流串接流程是什麼？') {
  return api(`/conversations/${id}/messages`, { method: 'POST', body: { question } })
}

test('/health 不需要 token；其他 API 沒帶 token 回 401', async () => {
  const { api } = await start()
  assert.equal((await api('/health', { token: null })).status, 200)
  for (const path of ['/conversations', '/settings', '/wiki/file?path=index.md']) {
    assert.equal((await api(path, { token: null })).status, 401, path)
    assert.equal((await api(path, { token: 'b'.repeat(64) })).status, 401, path)
  }
})

test('Host 不是 127.0.0.1/localhost 回 403', async () => {
  const { server } = await start({ checkHost: true })
  const port = server.address().port
  const status = host => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/health', headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject).end()
  })
  assert.equal(await status(`evil.example:${port}`), 403)
  assert.equal(await status(`127.0.0.1:${port}`), 200)
  assert.equal(await status(`localhost:${port}`), 200)
})

test('靜態頁不需要 token，且帶 CSP header；不能讀 webDir 外的檔', async () => {
  const { base } = await start()
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/)
  // Inline styles are allowed for diagrams, inline scripts are not.
  assert.doesNotMatch(res.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/)
  assert.match((await fetch(`${base}/app.js`)).headers.get('content-type'), /javascript/)
  // A miss falls through to the authenticated API, so without a token it is 401 rather than 404.
  for (const path of ['/..%2Fcfg%2Fsettings.json', '/nope.js']) {
    const res = await fetch(base + path)
    assert.ok([401, 404].includes(res.status), path)
    assert.doesNotMatch(await res.text(), /wikiDir/)
  }
})

test('建立對話 → 送問題 → SSE 收到 tool/text/done → 對話裡存了問答與引用', async () => {
  const { api } = await start({ scripts: [[
    { kind: 'session' },
    { kind: 'tool', tool: 'Read', detail: '金流/串接設計.md' },
    { kind: 'text', text: '找到了' },
    { kind: 'done', text: '答', sources: ['金流/串接設計.md'] },
  ]] })
  const conv = await newConversation(api)
  assert.equal(conv.wikiDir, wikiA)
  const res = await ask(api, conv.id)
  assert.equal(res.status, 201)
  const { jobId } = await res.json()
  assert.deepEqual((await sseEvents(api, jobId)).map(e => e.kind), ['session', 'tool', 'text', 'done'])
  const saved = await (await api(`/conversations/${conv.id}`)).json()
  assert.equal(saved.sessionStarted, true)
  assert.equal(saved.runningJobId, null)
  assert.equal(saved.wikiDirAvailable, true)
  assert.equal(saved.title, '金流串接流程是什麼？')
  assert.deepEqual(saved.messages[1], { ...saved.messages[1], role: 'assistant', text: '答', sources: ['金流/串接設計.md'], tools: [{ tool: 'Read', detail: '金流/串接設計.md' }], error: null })
  const list = await (await api('/conversations')).json()
  assert.deepEqual(list.items.map(c => c.id), [conv.id])
})

test('第二個問題傳給 runQuestion 的 conversation 是同一個 id，且 sessionStarted === true', async () => {
  const { api, calls } = await start({ scripts: [
    [{ kind: 'session' }, { kind: 'done', text: '一', sources: [] }],
    [{ kind: 'done', text: '二', sources: [] }],
  ] })
  const conv = await newConversation(api)
  await sseEvents(api, (await (await ask(api, conv.id, '第一題')).json()).jobId)
  await sseEvents(api, (await (await ask(api, conv.id, '那失敗時怎麼處理？')).json()).jobId)
  assert.deepEqual(calls.map(c => [c.conversation.id, c.conversation.sessionStarted, c.question]),
    [[conv.id, false, '第一題'], [conv.id, true, '那失敗時怎麼處理？']])
})

test('同一對話執行中再送回 409', async () => {
  const { api } = await start({ scripts: [[{ kind: 'session' }, null]] })
  const conv = await newConversation(api)
  assert.equal((await ask(api, conv.id)).status, 201)
  const second = await ask(api, conv.id)
  assert.equal(second.status, 409)
  assert.match((await second.json()).error, /還在回答中/)
  const saved = await (await api(`/conversations/${conv.id}`)).json()
  assert.equal(saved.messages.length, 1)
  assert.ok(saved.runningJobId)
})

test('空白或過長問題 400；不存在的對話 404', async () => {
  const { api } = await start()
  const conv = await newConversation(api)
  assert.equal((await ask(api, conv.id, '   ')).status, 400)
  assert.equal((await ask(api, conv.id, 'x'.repeat(4001))).status, 400)
  assert.equal((await api(`/conversations/${conv.id}/messages`, { method: 'POST', body: 'nope' })).status, 400)
  assert.equal((await ask(api, '11111111-1111-4111-8111-111111111111')).status, 404)
  assert.equal((await api('/conversations/11111111-1111-4111-8111-111111111111')).status, 404)
})

test('daemon 重啟（新的 jobs store）後，只有問題沒有回答的對話可以再送', async () => {
  const first = await start({ scripts: [[{ kind: 'session' }, null]] })
  const conv = await newConversation(first.api)
  assert.equal((await ask(first.api, conv.id)).status, 201)
  const second = await start({ jobs: createJobStore() })
  const saved = await (await second.api(`/conversations/${conv.id}`)).json()
  assert.deepEqual(saved.messages.map(m => m.role), ['user'])
  assert.equal(saved.runningJobId, null)
  assert.equal((await ask(second.api, conv.id, '再問一次')).status, 201)
})

test('runQuestion 發 error 時，回答存成 error 並保留已收到的文字', async () => {
  const { api } = await start({ scripts: [[
    { kind: 'text', text: '前半' },
    { kind: 'text', text: '後半' },
    { kind: 'error', message: 'Claude 執行失敗' },
  ]] })
  const conv = await newConversation(api)
  await sseEvents(api, (await (await ask(api, conv.id)).json()).jobId)
  const answer = (await (await api(`/conversations/${conv.id}`)).json()).messages[1]
  assert.equal(answer.error, 'Claude 執行失敗')
  assert.equal(answer.text, '前半\n\n後半')
  assert.deepEqual(answer.sources, [])
})

test('POST /jobs/:id/cancel 會取消並回 202', async () => {
  const { api } = await start({ scripts: [[{ kind: 'session' }, null]] })
  const conv = await newConversation(api)
  const { jobId } = await (await ask(api, conv.id)).json()
  assert.equal((await api(`/jobs/${jobId}/cancel`, { method: 'POST' })).status, 202)
  assert.deepEqual((await sseEvents(api, jobId)).at(-1), { kind: 'error', message: '已取消' })
  assert.equal((await api('/jobs/11111111-1111-4111-8111-111111111111/cancel', { method: 'POST' })).status, 404)
})

test('/wiki/file 支援中文路徑（encodeURIComponent），拒絕 ..、絕對路徑、非 .md', async () => {
  const { api } = await start()
  const ok = await api(`/wiki/file?path=${encodeURIComponent('金流/串接設計.md')}`)
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type'), /text\/markdown; charset=utf-8/)
  assert.equal(await ok.text(), CONTENT)
  for (const p of ['../outside.md', join(tmp, 'outside.md'), 'index.txt', 'missing.md', '']) {
    const status = (await api(`/wiki/file?path=${encodeURIComponent(p)}`)).status
    assert.ok([400, 403, 404].includes(status), `${p} → ${status}`)
  }
})

test('/wiki/file 帶 conv 時用該對話的 WIKI，不用目前設定', async () => {
  const { api } = await start()
  const conv = await newConversation(api)
  assert.equal((await api('/settings', { method: 'PUT', body: { wikiDir: wikiB } })).status, 200)
  const path = encodeURIComponent('金流/串接設計.md')
  assert.equal((await api(`/wiki/file?conv=${conv.id}&path=${path}`)).status, 200)
  assert.equal((await api(`/wiki/file?path=${path}`)).status, 404)
  assert.equal((await api(`/wiki/file?path=only-b.md`)).status, 200)
  assert.equal((await api(`/wiki/file?conv=11111111-1111-4111-8111-111111111111&path=${path}`)).status, 404)
})

test('/wiki/open 只對 WIKI 內的 .md 與點陣圖呼叫 openFile', async () => {
  await writeFile(join(wikiA, '金流', '流程.png'), 'x')
  await writeFile(join(wikiA, 'logo.svg'), '<svg/>')
  const { api, opened } = await start()
  const conv = await newConversation(api)
  assert.equal((await api('/wiki/open', { method: 'POST', body: { conversationId: conv.id, path: '金流/串接設計.md' } })).status, 204)
  assert.deepEqual(opened, [await realpath(join(wikiA, '金流', '串接設計.md'))])
  for (const path of ['../outside.md', 'index.txt', 'logo.svg', join(tmp, 'outside.md')]) {
    assert.ok([400, 403, 404].includes((await api('/wiki/open', { method: 'POST', body: { path } })).status), path)
  }
  assert.equal(opened.length, 1)
  assert.equal((await api('/wiki/open', { method: 'POST', body: { conversationId: conv.id, path: '金流/流程.png' } })).status, 204)
  assert.deepEqual(opened.at(-1), await realpath(join(wikiA, '金流', '流程.png')))
})

test('/wiki/open 與 /wiki/file 不跟隨指向其他類型檔案的 symlink', async t => {
  await writeFile(join(wikiA, 'evil.cmd'), 'echo pwned')
  try {
    await symlink(join(wikiA, 'evil.cmd'), join(wikiA, 'pic.png'), 'file')
    await symlink(join(wikiA, 'evil.cmd'), join(wikiA, 'doc.md'), 'file')
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('這台機器不能建立檔案 symlink（Windows 需要開發人員模式）')
    throw e
  }
  const { api, opened } = await start()
  const conv = await newConversation(api)
  for (const path of ['pic.png', 'doc.md']) {
    assert.equal((await api('/wiki/open', { method: 'POST', body: { conversationId: conv.id, path } })).status, 400, path)
  }
  assert.equal((await api(`/wiki/file?path=${encodeURIComponent('doc.md')}`)).status, 400)
  assert.equal(opened.length, 0)
})

test('PUT /settings 驗證路徑；新對話用新路徑；舊對話 WIKI 不存在時送問題 409', async () => {
  const { api } = await start()
  assert.deepEqual(await (await api('/settings')).json(), { wikiDir: wikiA })
  const bad = await api('/settings', { method: 'PUT', body: { wikiDir: join(tmp, 'missing') } })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /WIKI 路徑不存在/)
  assert.deepEqual(await (await api('/settings')).json(), { wikiDir: wikiA })

  const temporary = join(tmp, 'temporary-wiki')
  await mkdir(temporary)
  assert.equal((await api('/settings', { method: 'PUT', body: { wikiDir: temporary } })).status, 200)
  const conv = await newConversation(api)
  assert.equal(conv.wikiDir, temporary)
  await rm(temporary, { recursive: true })
  assert.equal((await (await api(`/conversations/${conv.id}`)).json()).wikiDirAvailable, false)
  const res = await ask(api, conv.id)
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /WIKI 路徑已不存在/)
})

test('POST /settings/pick-folder 回傳選到的路徑', async () => {
  const { api } = await start()
  assert.deepEqual(await (await api('/settings/pick-folder', { method: 'POST' })).json(), { path: wikiB })
})

test('GET /conversations 不列出過期對話', async () => {
  const { api } = await start()
  const old = await newConversation(api)
  t += 10 * DAY
  const fresh = await newConversation(api)
  t += 5 * DAY
  assert.deepEqual((await (await api('/conversations')).json()).items.map(c => c.id), [fresh.id])
  assert.equal((await api(`/conversations/${old.id}`)).status, 404)
})

test('DELETE 對話後 GET 回 404，執行中的 job 會被取消', async () => {
  const { api } = await start({ scripts: [[{ kind: 'session' }, null]] })
  const conv = await newConversation(api)
  const { jobId } = await (await ask(api, conv.id)).json()
  assert.equal((await api(`/conversations/${conv.id}`, { method: 'DELETE' })).status, 204)
  assert.deepEqual((await sseEvents(api, jobId)).at(-1), { kind: 'error', message: '已取消' })
  assert.equal((await api(`/conversations/${conv.id}`)).status, 404)
  assert.equal((await api(`/conversations/${conv.id}`, { method: 'DELETE' })).status, 404)
})

test('DELETE 對話會寫一行紀錄（含標題）', async () => {
  const logs = []
  const { api } = await start({ log: line => logs.push(line) })
  const conv = await newConversation(api)
  await sseEvents(api, (await (await ask(api, conv.id, '要刪掉的對話')).json()).jobId)
  await api(`/conversations/${conv.id}`, { method: 'DELETE' })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /已刪除對話/)
  assert.match(logs[0], /要刪掉的對話/)
  assert.match(logs[0], new RegExp(conv.id))
})

test('未知路徑 404', async () => {
  const { api } = await start()
  assert.equal((await api('/nope')).status, 404)
})

test('建立對話時記下身分，GET、清單與 runQuestion 都拿得到', async () => {
  const { api, calls } = await start()
  const conv = await newConversation(api, 'pm')
  assert.equal(conv.role, 'pm')
  assert.equal((await (await api(`/conversations/${conv.id}`)).json()).role, 'pm')
  assert.equal((await (await api('/conversations')).json()).items[0].role, 'pm')
  await sseEvents(api, (await (await ask(api, conv.id)).json()).jobId)
  assert.equal(calls[0].conversation.role, 'pm')
})

test('建立對話時身分不存在或沒給都回 400，也不會建立對話', async () => {
  const { api } = await start()
  for (const body of [{ role: 'qa' }, { role: 'toString' }, {}, undefined]) {
    const res = await api('/conversations', { method: 'POST', body })
    assert.equal(res.status, 400, JSON.stringify(body))
  }
  assert.deepEqual((await (await api('/conversations')).json()).items, [])
})

test('GET /conversations 帶 running 旗標，q 參數可以搜尋', async () => {
  const { api } = await start({ scripts: [[{ kind: 'session' }, null], [{ kind: 'done', text: '答', sources: [] }]] })
  const busy = await newConversation(api)
  await ask(api, busy.id, '金流串接')
  const idle = await newConversation(api)
  const { jobId } = await (await ask(api, idle.id, '點餐流程')).json()
  await sseEvents(api, jobId)
  const items = (await (await api('/conversations')).json()).items
  assert.deepEqual(Object.fromEntries(items.map(c => [c.id, c.running])), { [busy.id]: true, [idle.id]: false })
  const found = (await (await api(`/conversations?q=${encodeURIComponent('點餐')}`)).json()).items
  assert.deepEqual(found.map(c => c.id), [idle.id])
})

test('失敗時存下的文字只保留最後一次工具呼叫之後的部分', async () => {
  const { api } = await start({ scripts: [[
    { kind: 'text', text: '我先搜尋' },
    { kind: 'tool', tool: 'Note', detail: '我先搜尋' },
    { kind: 'tool', tool: 'Grep', detail: '金流' },
    { kind: 'text', text: '寫到一半' },
    { kind: 'error', message: '已取消' },
  ]] })
  const conv = await newConversation(api)
  await sseEvents(api, (await (await ask(api, conv.id)).json()).jobId)
  const saved = await (await api(`/conversations/${conv.id}`)).json()
  assert.equal(saved.messages[1].text, '寫到一半')
  assert.deepEqual(saved.messages[1].tools.map(t => t.tool), ['Note', 'Grep'])
})

test('回答的耗時、輪數、金額會存進對話；失敗時有的話也存', async () => {
  const stats = { durationMs: 5718, turns: 2, costUsd: 0.02 }
  const { api } = await start({ scripts: [
    [{ kind: 'done', text: '答', sources: [], stats }],
    [{ kind: 'error', message: '查了 40 輪還沒找到結論', stats }],
    [{ kind: 'error', message: '已取消' }],
  ] })
  const conv = await newConversation(api)
  for (const q of ['一', '二', '三']) await sseEvents(api, (await (await ask(api, conv.id, q)).json()).jobId)
  const answers = (await (await api(`/conversations/${conv.id}`)).json()).messages.filter(m => m.role === 'assistant')
  assert.deepEqual(answers.map(a => a.stats), [stats, stats, undefined])
})

test('/wiki/asset 只回 WIKI 內的點陣圖，要 token，SVG 與 WIKI 外的檔案都拒絕', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await mkdir(join(wikiA, '金流', 'images'))
  await writeFile(join(wikiA, '金流', 'images', '流程.png'), png)
  await writeFile(join(wikiA, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await writeFile(join(tmp, 'outside.png'), png)
  const { api, base } = await start()
  const asset = path => `/wiki/asset?${new URLSearchParams({ path })}`

  const res = await api(asset('金流/images/流程.png'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)

  assert.equal((await api(asset('金流/images/流程.png'), { token: null })).status, 401)
  assert.equal((await api(asset('logo.svg'))).status, 400)
  assert.equal((await api(asset('金流/串接設計.md'))).status, 400)
  assert.equal((await api(asset('../outside.png'))).status, 404)
  assert.equal((await api(asset('不存在.png'))).status, 404)
  assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /img-src 'self' data: blob:/)
})

test('/wiki/attachments 列出文件同名附件資料夾裡的點陣圖，依數字排序', async () => {
  const dir = join(wikiA, '金流', '.attachments', '串接設計')
  await mkdir(join(dir, 'sub'), { recursive: true })
  for (const name of ['image10.png', 'image2.jpg', 'image1.png', 'note.txt', 'x.svg']) await writeFile(join(dir, name), 'x')
  const { api } = await start()
  const list = path => api(`/wiki/attachments?${new URLSearchParams({ path })}`)

  const res = await list('金流/串接設計.md')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { images: ['image1.png', 'image2.jpg', 'image10.png'] })

  await writeFile(join(wikiA, '沒附件.md'), '# x')
  assert.deepEqual(await (await list('沒附件.md')).json(), { images: [] })
  assert.equal((await list('不存在.md')).status, 404)
  assert.equal((await list('../outside.md')).status, 404)
  assert.equal((await list('index.txt')).status, 400)
  assert.equal((await api(`/wiki/attachments?path=${encodeURIComponent('金流/串接設計.md')}`, { token: null })).status, 401)
})

test('GET /roles 回傳身分清單與預設身分', async () => {
  const { api } = await start()
  const res = await api('/roles')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { roles: [{ id: 'pm', label: 'PM/PD' }, { id: 'rd', label: 'RD' }], defaultRole: 'rd' })
  assert.equal((await api('/roles', { token: null })).status, 401)
})
