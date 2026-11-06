import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from '../conversations.js'

const DAY = 86_400_000
let tmp, dir, wiki, t, store

function makeStore(options = {}) {
  return createConversationStore({ dir, now: () => t, ...options })
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wikichat-conv-'))
  dir = join(tmp, 'conversations')
  wiki = join(tmp, 'WIKI')
  t = Date.parse('2026-10-01T00:00:00Z')
  store = makeStore()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const answer = (text, extra = {}) => ({ text, sources: [], tools: [], error: null, ...extra })

test('create → addQuestion → addAnswer 後 get 拿得到，標題取前 20 字', async () => {
  const c = await store.create({ wikiDir: wiki })
  await store.addQuestion(c.id, '金流串接流程是什麼？請詳細說明每個步驟與失敗處理方式')
  await store.addAnswer(c.id, answer('答', { sources: ['金流/串接設計.md'] }))
  const got = await store.get(c.id)
  assert.equal(got.title, '金流串接流程是什麼？請詳細說明每個步驟與…')
  assert.equal(got.wikiDir, wiki)
  assert.equal(got.sessionStarted, false)
  assert.deepEqual(got.messages.map(m => m.role), ['user', 'assistant'])
  assert.deepEqual(got.messages[1].sources, ['金流/串接設計.md'])
})

test('短標題不加刪節號，第二個問題不改標題', async () => {
  const c = await store.create({ wikiDir: wiki })
  await store.addQuestion(c.id, '金流是什麼？')
  await store.addQuestion(c.id, '另一個問題')
  assert.equal((await store.get(c.id)).title, '金流是什麼？')
})

test('重新建立 store 後資料仍在（一對話一檔）', async () => {
  const c = await store.create({ wikiDir: wiki })
  await store.addQuestion(c.id, '問')
  await store.markSessionStarted(c.id)
  const again = await makeStore().get(c.id)
  assert.equal(again.messages[0].text, '問')
  assert.equal(again.sessionStarted, true)
  assert.deepEqual(await readdir(dir), [`${c.id}.json`])
})

test('list 只列 14 天內、依 updatedAt 新到舊', async () => {
  const old = await store.create({ wikiDir: wiki })
  t += 10 * DAY
  const mid = await store.create({ wikiDir: wiki })
  t += 1 * DAY
  const fresh = await store.create({ wikiDir: wiki })
  t += 4 * DAY // old 15 天、mid 5 天、fresh 4 天
  const items = await store.list()
  assert.deepEqual(items.map(c => c.id), [fresh.id, mid.id])
  assert.deepEqual(Object.keys(items[0]).sort(), ['id', 'role', 'title', 'updatedAt', 'wikiDir'])
  assert.equal(await store.get(old.id), null)
})

test('兩週內有追問的舊對話會繼續保留', async () => {
  const c = await store.create({ wikiDir: wiki })
  t += 13 * DAY
  await store.addQuestion(c.id, '追問')
  t += 13 * DAY
  assert.ok(await store.get(c.id))
})

test('purgeExpired 刪掉過期的檔並回傳數量', async () => {
  await store.create({ wikiDir: wiki })
  await store.create({ wikiDir: wiki })
  t += 10 * DAY
  const keep = await store.create({ wikiDir: wiki })
  t += 5 * DAY
  assert.equal(await store.purgeExpired(), 2)
  assert.deepEqual(await readdir(dir), [`${keep.id}.json`])
})

test('retentionDays 可以覆寫', async () => {
  const short = makeStore({ retentionDays: 1 })
  const c = await short.create({ wikiDir: wiki })
  t += 2 * DAY
  assert.equal(await short.get(c.id), null)
  assert.deepEqual(await short.list(), [])
})

test('get/remove 拒絕非 UUID 的 id（防路徑穿越）', async () => {
  assert.equal(await store.get('../settings'), null)
  assert.equal(await store.remove('..\\token'), false)
  await assert.rejects(store.addQuestion('../x', 'q'))
})

test('remove 刪掉對話', async () => {
  const c = await store.create({ wikiDir: wiki })
  assert.equal(await store.remove(c.id), true)
  assert.equal(await store.get(c.id), null)
  assert.equal(await store.remove(c.id), false)
})

test('remove 排在進行中的 add 之後，對話不會被寫回來', async () => {
  const c = await store.create({ wikiDir: wiki })
  const pending = store.addAnswer(c.id, answer('晚到的回答'))
  assert.equal(await store.remove(c.id), true)
  await pending.catch(() => {})
  assert.equal(await store.get(c.id), null)
  assert.deepEqual(await readdir(dir), [])
})

test('損毀的對話檔被略過，不影響 list', async () => {
  const c = await store.create({ wikiDir: wiki })
  await writeFile(join(dir, '11111111-1111-4111-8111-111111111111.json'), '{bad')
  assert.deepEqual((await store.list()).map(x => x.id), [c.id])
  assert.equal(await store.get('11111111-1111-4111-8111-111111111111'), null)
})

test('同一對話連續 add 不會互相覆蓋', async () => {
  const c = await store.create({ wikiDir: wiki })
  await Promise.all([store.addQuestion(c.id, 'a'), store.addAnswer(c.id, answer('b')), store.markSessionStarted(c.id)])
  const got = await store.get(c.id)
  assert.equal(got.messages.length, 2)
  assert.equal(got.sessionStarted, true)
})

test('add 會更新 updatedAt', async () => {
  const c = await store.create({ wikiDir: wiki })
  t += DAY
  await store.addQuestion(c.id, 'q')
  assert.equal((await store.get(c.id)).updatedAt, new Date(t).toISOString())
})

test('create 記下身分，get 與 list 都帶出來', async () => {
  const c = await store.create({ wikiDir: wiki, role: 'pm' })
  assert.equal(c.role, 'pm')
  assert.equal((await makeStore().get(c.id)).role, 'pm')
  assert.deepEqual((await store.list()).map(item => item.role), ['pm'])
})

test('沒有身分的舊對話一律視為 rd', async () => {
  const c = await store.create({ wikiDir: wiki })
  const file = join(dir, `${c.id}.json`)
  const { role, ...legacy } = await store.get(c.id)
  await writeFile(file, JSON.stringify(legacy))
  assert.equal((await store.get(c.id)).role, 'rd')
  assert.equal((await store.list())[0].role, 'rd')
})

test('remove 與 purgeExpired 都會呼叫 onRemove，失敗不影響刪除', async () => {
  const removedIds = []
  const s = makeStore({ onRemove: async id => { removedIds.push(id); throw new Error('boom') } })
  const a = await s.create({ wikiDir: wiki })
  const b = await s.create({ wikiDir: wiki })
  assert.equal(await s.remove(a.id), true)
  t += 15 * DAY
  assert.equal(await s.purgeExpired(), 1)
  assert.deepEqual(removedIds, [a.id, b.id])
  assert.deepEqual(await readdir(dir), [])
})

test('list 的 query 比對標題與問答內容，不分大小寫', async () => {
  const a = await store.create({ wikiDir: wiki })
  await store.addQuestion(a.id, '金流串接流程')
  await store.addAnswer(a.id, answer('呼叫 SyncAPI 同步'))
  const b = await store.create({ wikiDir: wiki })
  await store.addQuestion(b.id, '點餐流程')
  assert.deepEqual((await store.list({ query: '金流' })).map(c => c.id), [a.id])
  assert.deepEqual((await store.list({ query: 'syncapi' })).map(c => c.id), [a.id])
  assert.deepEqual((await store.list({ query: '  流程 ' })).length, 2)
  assert.deepEqual(await store.list({ query: '沒有這個字' }), [])
})
