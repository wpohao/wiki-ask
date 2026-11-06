import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProjectsDir, removeClaudeSession } from '../sessions.js'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
let projects

beforeEach(async () => {
  projects = await mkdtemp(join(tmpdir(), 'wikichat-sessions-'))
})

afterEach(async () => {
  await rm(projects, { recursive: true, force: true })
})

test('刪掉各專案資料夾裡該 id 的 .jsonl 與同名資料夾，其他 session 不動', async () => {
  const wiki = join(projects, 'C--Users-x-Desktop-WIKI')
  const other = join(projects, 'C--Work-Repo')
  await mkdir(join(wiki, ID, 'subagents'), { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(join(wiki, `${ID}.jsonl`), '{}')
  await writeFile(join(wiki, ID, 'subagents', 'a.jsonl'), '{}')
  await writeFile(join(wiki, `${OTHER}.jsonl`), '{}')
  await writeFile(join(other, `${ID}.jsonl`), '{}')
  await mkdir(join(wiki, 'memory'))

  assert.equal(await removeClaudeSession(projects, ID), 3)
  assert.deepEqual((await readdir(wiki)).sort(), [`${OTHER}.jsonl`, 'memory'])
  assert.deepEqual(await readdir(other), [])
})

test('不是 UUID 的 id 不刪任何東西（防路徑穿越）', async () => {
  await mkdir(join(projects, 'p'))
  await writeFile(join(projects, 'p', 'x.jsonl'), '{}')
  for (const id of ['..', '*', '', 'x', '../p']) assert.equal(await removeClaudeSession(projects, id), 0, id)
  assert.deepEqual(await readdir(join(projects, 'p')), ['x.jsonl'])
})

test('projects 資料夾不存在時回 0', async () => {
  assert.equal(await removeClaudeSession(join(projects, 'missing'), ID), 0)
})

test('claudeProjectsDir 優先用 CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: join('D:', 'cc') }), join('D:', 'cc', 'projects'))
  assert.equal(claudeProjectsDir({}), join(homedir(), '.claude', 'projects'))
})
