// Stand-in for `claude -p --output-format stream-json`; behavior is chosen with FAKE_CLAUDE_MODE.
import { join } from 'node:path'

const mode = process.env.FAKE_CLAUDE_MODE || 'ok'
// FAKE_CLAUDE_DELAY_MS spaces the lines out, so streaming can be watched in the browser.
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 0)
const queue = []
let flushing = false
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const emit = value => {
  if (!delay) { write(value); return }
  queue.push(value)
  if (flushing) return
  flushing = true
  const timer = setInterval(() => {
    write(queue.shift())
    if (!queue.length) { clearInterval(timer); flushing = false }
  }, delay)
}

let question = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { question += chunk })
process.stdin.on('end', () => {
  if (mode === 'fail') {
    process.stderr.write('Not logged in\n')
    process.exit(1)
  }
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session' })
  if (mode === 'hang') {
    setInterval(() => {}, 1000)
    return
  }
  if (mode === 'args') {
    emit({ type: 'result', is_error: false, result: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) })
    return
  }
  if (mode === 'partial') {
    // Like --include-partial-messages in CLI 2.1.317: text comes as deltas and the `assistant` snapshot of a
    // text block can be cut short.
    const block = (deltas, snapshot) => {
      emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
      for (const text of deltas) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: snapshot }] } })
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    }
    block(['<br>\n\n先讀', '串接設計'], '<br>\n\n先讀')
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } })
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(process.cwd(), '金流', '串接設計.md') } }] } })
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    emit({ type: 'user', message: { content: [{ type: 'tool_result', content: '# 串接' }] } })
    const answer = `回答：${question}`
    block([answer.slice(0, 3), answer.slice(3), '\n<sources>\n金流/串接設計.md\n</sources>'], answer.slice(0, 3))
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 12_345, num_turns: 2, total_cost_usd: 0.0234, result: `${answer}\n<sources>\n金流/串接設計.md\n</sources>` })
    return
  }
  if (mode === 'maxturns') {
    // CLI 2.1.317 with --max-turns: no `result` text, exit code 1.
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: '金流' } }] } })
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 4384, num_turns: 2, total_cost_usd: 0.0096, errors: ['Reached maximum number of turns (1)'] })
    process.exitCode = 1
    return
  }
  emit({ type: 'assistant', message: { content: [
    { type: 'text', text: '先讀串接設計' },
    { type: 'tool_use', name: 'Read', input: { file_path: join(process.cwd(), '金流', '串接設計.md') } },
  ] } })
  emit({ type: 'user', message: { content: [{ type: 'tool_result', content: '# 串接' }] } })
  const sources = mode === 'nosources' ? ''
    : mode === 'badsources' ? '\n<sources>\n串接設計.md\nmissing.md\n</sources>'
      : '\n<sources>\n金流/串接設計.md\nmissing.md\n</sources>'
  emit({ type: 'result', is_error: false, result: `回答：${question}${sources}` })
})
