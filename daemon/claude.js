import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { relativeToWiki, resolveInside } from './paths.js'
import { extractSources, pickSources } from './sources.js'
import { parseStreamLine } from './stream.js'

const DEFAULT_TIMEOUT_MS = 10 * 60_000

export function buildClaudeArgs({ sessionId, resume, promptFile, maxTurns }) {
  return ['-p', '--output-format', 'stream-json', '--verbose',
    ...(maxTurns ? ['--max-turns', String(maxTurns)] : []),
    '--restricted', '--tools', 'Read,Grep,Glob',
    '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'dontAsk',
    '--include-partial-messages',
    '--strict-mcp-config', '--append-system-prompt-file', promptFile,
    resume ? '--resume' : '--session-id', sessionId]
}

export function claudeCommand(setting) {
  return setting.toLowerCase().endsWith('.js') ? [process.execPath, setting] : [setting]
}

// Node cannot execute Windows npm .cmd/.ps1 shims with shell:false, so find the .exe on PATH.
// Never fall back to the bare name: Windows would search the working directory (the WIKI) first,
// so a planted claude.exe there would run. Relative PATH entries are skipped for the same reason.
export async function resolveExecutable(name) {
  if (process.platform !== 'win32' || isAbsolute(name) || /[\\/]/.test(name)) return name
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const file = join(dir, name.endsWith('.exe') ? name : `${name}.exe`)
    try { await access(file); return file } catch {}
  }
  throw new Error(`PATH 上找不到 ${name}.exe，請安裝 Claude Code CLI 或用 WIKICHAT_CLAUDE 指定完整路徑`)
}

const NOTE_LENGTH = 200

// Text written right before a tool call ("I'll search for X first") is narration, not the answer.
export function noteText(texts) {
  const chars = Array.from(texts.join(' ').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim())
  return chars.length > NOTE_LENGTH ? `${chars.slice(0, NOTE_LENGTH).join('')}…` : chars.join('')
}

function toolDetail(wikiDir, tool, input) {
  const show = p => relativeToWiki(wikiDir, p) || p
  if (tool === 'Read' && typeof input.file_path === 'string') return show(input.file_path)
  if (tool === 'Grep' && typeof input.pattern === 'string') {
    return typeof input.path === 'string' ? `${input.pattern}（${show(input.path)}）` : input.pattern
  }
  if (tool === 'Glob' && typeof input.pattern === 'string') return input.pattern
  return ''
}

export function runClaude({ command = ['claude'], wikiDir, question, sessionId, resume, promptFile, maxTurns, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env }) {
  let child
  let cancelled = false

  async function* generate() {
    const [executable, ...prefix] = command
    let timer
    let timedOut = false
    let result
    try {
      if (cancelled) throw new Error('已取消')
      child = spawn(await resolveExecutable(executable), [...prefix, ...buildClaudeArgs({ sessionId, resume, promptFile, maxTurns })], {
        cwd: wikiDir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let spawnError
      const exited = new Promise(resolve => {
        child.once('error', error => { spawnError = error; resolve(null) })
        child.once('close', resolve)
      })
      child.stdin.on('error', () => {})
      child.stdin.end(question, 'utf8')
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_384) })
      timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)

      const readFiles = []
      // Partial streaming: `delta` events go out as they arrive, and the finished block is sent as one `text`.
      let partial = false
      let block = null
      // Text blocks since the last tool call; they become a `Note` step once a tool call follows.
      let narration = []
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        for (const event of parseStreamLine(line)) {
          if (event.kind === 'init') yield { kind: 'session' }
          else if (event.kind === 'block-start') { partial = true; block = '' }
          else if (event.kind === 'delta') {
            partial = true
            block = (block ?? '') + event.text
            yield event
          } else if (event.kind === 'block-stop') {
            if (block?.trim()) { narration.push(block); yield { kind: 'text', text: block } }
            block = null
          } else if (event.kind === 'text') {
            if (!partial) { narration.push(event.text); yield event }
          } else if (event.kind === 'tool') {
            const note = narration.length ? noteText(narration) : ''
            narration = []
            if (note) yield { kind: 'tool', tool: 'Note', detail: note }
            if (event.tool === 'Read' && typeof event.input.file_path === 'string') {
              const rel = relativeToWiki(wikiDir, event.input.file_path)
              if (rel) readFiles.push(rel)
            }
            yield { kind: 'tool', tool: event.tool, detail: toolDetail(wikiDir, event.tool, event.input) }
          } else if (event.kind === 'result') result = event
        }
      }
      // A block cut off by cancel or timeout still counts toward the partial answer that gets saved.
      if (block?.trim()) yield { kind: 'text', text: block }
      const code = await exited
      if (spawnError) {
        throw new Error(spawnError.code === 'ENOENT' ? `找不到 claude 執行檔：${executable}` : `無法啟動 claude：${spawnError.code || '未知錯誤'}`)
      }
      if (cancelled) throw new Error('已取消')
      if (timedOut) throw new Error('回答逾時，請稍後重試。')
      if (result?.subtype === 'error_max_turns') {
        const limit = maxTurns ? ` ${maxTurns} 輪` : '太多輪'
        throw new Error(`查了${limit}還沒找到結論，已停止。請把問題問得更具體，或縮小範圍後重新提問。`)
      }
      if (result?.isError) throw new Error(`Claude 回報錯誤：${result.text || result.subtype || '未知錯誤'}`)
      if (code !== 0 || !result) {
        throw new Error(`Claude 執行失敗（退出代碼 ${code}）。請確認 Claude CLI 已登入。${stderr.trim() ? `\n${stderr.trim().slice(-500)}` : ''}`)
      }

      const { body, sources: declared } = extractSources(result.text)
      // Filter before choosing, so declared paths that don't exist fall back to the files actually read.
      const existing = async paths => {
        const kept = []
        for (const path of paths) if (await resolveInside(wikiDir, path)) kept.push(path)
        return kept
      }
      const sources = pickSources(await existing(declared), await existing(readFiles))
      yield { kind: 'done', text: body, sources, ...(result.stats && { stats: result.stats }) }
    } catch (error) {
      // Stats are kept when Claude got as far as reporting them, e.g. after hitting the turn limit.
      yield { kind: 'error', message: error.message, ...(result?.stats && { stats: result.stats }) }
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null) child.kill()
    }
  }

  return { events: generate(), cancel() { cancelled = true; child?.kill() } }
}
