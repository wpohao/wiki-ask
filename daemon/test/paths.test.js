import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizeWikiPath, relativeToWiki, resolveInside, validateWikiDir } from '../paths.js'

let tmp
let wiki
let outsideDir

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wikichat-paths-'))
  wiki = join(tmp, 'WIKI 知識庫')
  outsideDir = join(tmp, 'outside')
  await mkdir(join(wiki, '金流'), { recursive: true })
  await mkdir(outsideDir)
  await writeFile(join(wiki, '金流', '串接設計.md'), '# 串接')
  await writeFile(join(wiki, 'index.md'), '# index')
  await writeFile(join(tmp, 'outside.md'), 'secret')
  await writeFile(join(outsideDir, 'outside.md'), 'secret')
})

after(async () => {
  await rm(tmp, { recursive: true, force: true })
})

test('resolveInside 接受含中文的相對路徑', async () => {
  assert.equal(await resolveInside(wiki, '金流/串接設計.md'), await realpath(join(wiki, '金流', '串接設計.md')))
})

test('resolveInside 拒絕 ..、絕對路徑、不存在的檔、空字串、NUL', async () => {
  for (const p of ['../outside.md', join(tmp, 'outside.md'), '金流/../../outside.md', 'nope.md', '', 'a\0b', null]) {
    assert.equal(await resolveInside(wiki, p), null, String(p))
  }
})

test('resolveInside 擋住指向 WIKI 外的 junction', async () => {
  await symlink(outsideDir, join(wiki, 'link'), 'junction')
  assert.equal(await resolveInside(wiki, 'link/outside.md'), null)
})

test('resolveInside 的 root 大小寫不同仍視為同一目錄（win32）', { skip: process.platform !== 'win32' }, async () => {
  assert.ok(await resolveInside(wiki.toUpperCase(), 'index.md'))
})

test('normalizeWikiPath 正規化各種寫法', () => {
  assert.equal(normalizeWikiPath('金流\\串接設計.md'), '金流/串接設計.md')
  assert.equal(normalizeWikiPath('./金流/串接設計.md'), '金流/串接設計.md')
  assert.equal(normalizeWikiPath('- 金流/串接設計.md '), '金流/串接設計.md')
  assert.equal(normalizeWikiPath('`index.md`'), 'index.md')
  for (const bad of ['', '../x.md', 'a/../../x.md', 'C:\\x.md', '/x.md', 42]) {
    assert.equal(normalizeWikiPath(bad), null, String(bad))
  }
})

test('relativeToWiki 轉換 WIKI 內絕對路徑、拒絕 WIKI 外', () => {
  assert.equal(relativeToWiki(wiki, join(wiki, '金流', '串接設計.md')), '金流/串接設計.md')
  assert.equal(relativeToWiki(wiki, '金流/串接設計.md'), '金流/串接設計.md')
  assert.equal(relativeToWiki(wiki, join(tmp, 'outside.md')), null)
})

test('validateWikiDir 只接受存在的絕對資料夾', async () => {
  assert.equal(await validateWikiDir(wiki), resolve(wiki))
  for (const bad of ['relative/dir', join(wiki, 'index.md'), join(wiki, 'missing'), '', 42]) {
    assert.equal(await validateWikiDir(bad), null, String(bad))
  }
})
