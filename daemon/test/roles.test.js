import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROLE, ROLES, isRole, roleSections, writeRolePrompts } from '../roles.js'

const AGENT = `# 身分定義

說明文字，不會送給 Claude。

## PM/PD

偏流程與業務規則。

## RD

偏實作細節。
`
let tmp

beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'wikichat-roles-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

test('isRole 只接受已定義的身分', () => {
  assert.equal(isRole('pm'), true)
  assert.equal(isRole('rd'), true)
  assert.equal(isRole('qa'), false)
  assert.equal(isRole('toString'), false)
  assert.equal(isRole(undefined), false)
  assert.equal(isRole(DEFAULT_ROLE), true)
})

test('roleSections 依 ## 標題切出各身分的段落，標題以外的說明不算', () => {
  const sections = roleSections(AGENT)
  assert.deepEqual(Object.keys(sections).sort(), ['pm', 'rd'])
  assert.equal(sections.pm, '## PM/PD\n\n偏流程與業務規則。')
  assert.equal(sections.rd, '## RD\n\n偏實作細節。')
})

test('roleSections 缺少某個身分時拋錯', () => {
  assert.throws(() => roleSections('## RD\n\n只有 RD'), /PM\/PD/)
})

test('writeRolePrompts 為每個身分寫出「共用規則＋身分段落」的 prompt 檔', async () => {
  const systemFile = join(tmp, 'system.md')
  const agentFile = join(tmp, 'agent.md')
  await writeFile(systemFile, '共用規則\n')
  await writeFile(agentFile, AGENT)
  const files = await writeRolePrompts({ systemFile, agentFile, dir: join(tmp, 'out') })
  assert.deepEqual(Object.keys(files).sort(), Object.keys(ROLES).sort())
  const pm = await readFile(files.pm, 'utf8')
  assert.ok(pm.startsWith('共用規則'))
  assert.ok(pm.includes('## PM/PD\n\n偏流程與業務規則。'))
  assert.ok(!pm.includes('偏實作細節'))
  assert.ok(!pm.includes('說明文字'))
})

test('專案內的 prompts/agent.md 定義了所有身分', async () => {
  const agentFile = fileURLToPath(new URL('../prompts/agent.md', import.meta.url))
  const sections = roleSections(await readFile(agentFile, 'utf8'))
  for (const role of Object.keys(ROLES)) assert.ok(sections[role].length > ROLES[role].length + 10, role)
})
