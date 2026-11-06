import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSettingsStore } from '../settings.js'

let tmp, cfg, wikiA, wikiB

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wikichat-settings-'))
  cfg = join(tmp, 'cfg')
  wikiA = join(tmp, 'WIKI-A')
  wikiB = join(tmp, '知識庫 B')
  await mkdir(cfg)
  await mkdir(wikiA)
  await mkdir(wikiB)
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

test('沒有 settings.json 時用 defaultWikiDir', async () => {
  const s = await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })
  assert.deepEqual(s.get(), { wikiDir: wikiA })
})

test('setWikiDir 會寫檔，重新建立 store 後沿用', async () => {
  const s = await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })
  assert.deepEqual(await s.setWikiDir(wikiB), { wikiDir: resolve(wikiB) })
  const again = await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })
  assert.equal(again.get().wikiDir, resolve(wikiB))
})

test('setWikiDir 拒絕不存在的路徑且設定不變', async () => {
  const s = await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })
  await assert.rejects(s.setWikiDir(join(wikiA, 'missing')), /WIKI 路徑不存在/)
  assert.equal(s.get().wikiDir, wikiA)
})

test('settings.json 損毀時回到預設值', async () => {
  await writeFile(join(cfg, 'settings.json'), '{oops')
  assert.equal((await createSettingsStore({ configDir: cfg, defaultWikiDir: wikiA })).get().wikiDir, wikiA)
})

test('configDir 不存在時 setWikiDir 會自動建立', async () => {
  const s = await createSettingsStore({ configDir: join(tmp, 'new-cfg'), defaultWikiDir: wikiA })
  await s.setWikiDir(wikiB)
  const again = await createSettingsStore({ configDir: join(tmp, 'new-cfg'), defaultWikiDir: wikiA })
  assert.equal(again.get().wikiDir, resolve(wikiB))
})
