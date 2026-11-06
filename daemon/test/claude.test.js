import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClaudeArgs, claudeCommand, noteText, resolveExecutable, runClaude } from '../claude.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url))
let tmp, wiki

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'wikichat-claude-'))
  wiki = join(tmp, 'WIKI 知識庫')
  await mkdir(join(wiki, '金流'), { recursive: true })
  await writeFile(join(wiki, '金流', '串接設計.md'), '# 串接')
})

after(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function run(mode, overrides = {}) {
  return runClaude({
    command: [process.execPath, FIXTURE],
    wikiDir: wiki,
    question: '金流怎麼串？',
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    promptFile: 'system.md',
    env: { ...process.env, FAKE_CLAUDE_MODE: mode },
    ...overrides,
  })
}

async function collect(handle, onEvent = () => {}) {
  const events = []
  for await (const event of handle.events) {
    events.push(event)
    onEvent(event, handle)
  }
  return events
}

test('buildClaudeArgs 新對話用 --session-id、追問用 --resume', () => {
  const fresh = buildClaudeArgs({ sessionId: 'u1', resume: false, promptFile: 'P' })
  assert.deepEqual(fresh, ['-p', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk',
    '--include-partial-messages',
    '--strict-mcp-config', '--append-system-prompt-file', 'P',
    '--session-id', 'u1'])
  assert.deepEqual(buildClaudeArgs({ sessionId: 'u1', resume: true, promptFile: 'P' }).slice(-2), ['--resume', 'u1'])
})

test('claudeCommand：.js 用 node 執行，其他原樣', () => {
  assert.deepEqual(claudeCommand('x/fake.js'), [process.execPath, 'x/fake.js'])
  assert.deepEqual(claudeCommand('claude'), ['claude'])
})

test('ok：依序產生 session、text、Note、tool、done；問題從 stdin 傳入；只保留存在的引用', async () => {
  const events = await collect(run('ok', { question: '-金流怎麼串？' }))
  assert.deepEqual(events.map(e => e.kind), ['session', 'text', 'tool', 'tool', 'done'])
  assert.deepEqual(events[1], { kind: 'text', text: '先讀串接設計' })
  assert.deepEqual(events[2], { kind: 'tool', tool: 'Note', detail: '先讀串接設計' })
  assert.deepEqual(events[3], { kind: 'tool', tool: 'Read', detail: '金流/串接設計.md' })
  assert.equal(events[4].text, '回答：-金流怎麼串？')
  assert.deepEqual(events[4].sources, ['金流/串接設計.md'])
})

test('partial：文字用 delta 組出完整內容，不用被截斷的 assistant 快照', async () => {
  const events = await collect(run('partial'))
  assert.deepEqual(events.filter(e => e.kind === 'delta').map(e => e.text).join(''),
    '<br>\n\n先讀串接設計回答：金流怎麼串？\n<sources>\n金流/串接設計.md\n</sources>')
  const texts = events.filter(e => e.kind === 'text').map(e => e.text)
  assert.deepEqual(texts, ['<br>\n\n先讀串接設計', '回答：金流怎麼串？\n<sources>\n金流/串接設計.md\n</sources>'])
  assert.deepEqual(events.filter(e => e.kind === 'tool'), [
    { kind: 'tool', tool: 'Note', detail: '先讀串接設計' },
    { kind: 'tool', tool: 'Read', detail: '金流/串接設計.md' },
  ])
  assert.deepEqual(events.at(-1), { kind: 'done', text: '回答：金流怎麼串？', sources: ['金流/串接設計.md'],
    stats: { durationMs: 12_345, turns: 2, costUsd: 0.0234 } })
})

test('maxturns：超過輪數上限時給明確訊息，不誤報成未登入，並保留統計', async () => {
  const events = await collect(run('maxturns', { maxTurns: 40 }))
  const last = events.at(-1)
  assert.equal(last.kind, 'error')
  assert.match(last.message, /查了 40 輪還沒找到結論/)
  assert.doesNotMatch(last.message, /登入/)
  assert.deepEqual(last.stats, { durationMs: 4384, turns: 2, costUsd: 0.0096 })
})

test('noteText 合併空白、去掉 <br>、過長截斷', () => {
  assert.equal(noteText(['<br>\n\n先讀  索引', '再搜尋']), '先讀 索引 再搜尋')
  assert.equal(noteText(['字'.repeat(250)]), `${'字'.repeat(200)}…`)
})

test('nosources：用讀過的檔當引用', async () => {
  const events = await collect(run('nosources'))
  assert.deepEqual(events.at(-1), { kind: 'done', text: '回答：金流怎麼串？', sources: ['金流/串接設計.md'] })
})

test('badsources：宣告的引用全都不存在時，改用讀過的檔', async () => {
  const events = await collect(run('badsources'))
  assert.deepEqual(events.at(-1), { kind: 'done', text: '回答：金流怎麼串？', sources: ['金流/串接設計.md'] })
})

test('cwd 是 wikiDir，參數由 buildClaudeArgs 產生', async () => {
  const events = await collect(run('args', { resume: true, maxTurns: 40 }))
  const { args, cwd } = JSON.parse(events.at(-1).text)
  assert.equal(await realpath(cwd), await realpath(wiki))
  assert.deepEqual(args, buildClaudeArgs({ sessionId: '11111111-1111-4111-8111-111111111111', resume: true, promptFile: 'system.md', maxTurns: 40 }))
  assert.deepEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '40'])
})

test('buildClaudeArgs 沒給 maxTurns 時不帶 --max-turns', () => {
  assert.ok(!buildClaudeArgs({ sessionId: 'u1', resume: false, promptFile: 'P' }).includes('--max-turns'))
})

test('fail：error 訊息提示確認登入', async () => {
  const events = await collect(run('fail'))
  assert.equal(events.at(-1).kind, 'error')
  assert.match(events.at(-1).message, /退出代碼 1/)
  assert.match(events.at(-1).message, /登入/)
})

test('找不到執行檔：error 訊息含執行檔名稱', async () => {
  const events = await collect(run('ok', { command: [join(tmp, 'nope', 'claude.exe')] }))
  assert.equal(events.length, 1)
  assert.match(events[0].message, /找不到 claude 執行檔/)
})

test('hang：逾時後 error', async () => {
  const events = await collect(run('hang', { timeoutMs: 500 }))
  assert.deepEqual(events.map(e => e.kind), ['session', 'error'])
  assert.match(events[1].message, /逾時/)
})

test('cancel：error「已取消」', async () => {
  const events = await collect(run('hang'), (event, handle) => { if (event.kind === 'session') handle.cancel() })
  assert.deepEqual(events.at(-1), { kind: 'error', message: '已取消' })
})

test('resolveExecutable：Windows 上找不到就報錯，不退回裸檔名；略過相對 PATH', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wikichat-exe-'))
  const saved = process.env.PATH
  try {
    await writeFile(join(dir, 'fakeclaude.exe'), '')
    process.env.PATH = ['.', dir].join(';')
    assert.equal(await resolveExecutable('fakeclaude'), join(dir, 'fakeclaude.exe'))
    process.env.PATH = '.'
    await assert.rejects(resolveExecutable('fakeclaude'), /找不到 fakeclaude\.exe/)
  } finally {
    process.env.PATH = saved
    await rm(dir, { recursive: true, force: true })
  }
})
