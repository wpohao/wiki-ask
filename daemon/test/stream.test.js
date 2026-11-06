import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStreamLine } from '../stream.js'

test('init 事件帶 session id', () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })), [{ kind: 'init', sessionId: 's1' }])
})

test('一則 assistant 訊息有多個 tool_use 與 text 時全部回傳、保持順序', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: '先找索引' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\W\\index.md' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: '金流' } },
    { type: 'text', text: '   ' },
  ] } })
  assert.deepEqual(parseStreamLine(line), [
    { kind: 'text', text: '先找索引' },
    { kind: 'tool', tool: 'Read', input: { file_path: 'C:\\W\\index.md' } },
    { kind: 'tool', tool: 'Grep', input: { pattern: '金流' } },
  ])
})

test('stream_event：文字區塊開始、delta、結束；其他類型略過', () => {
  const line = event => JSON.stringify({ type: 'stream_event', event })
  assert.deepEqual(parseStreamLine(line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })), [{ kind: 'block-start' }])
  assert.deepEqual(parseStreamLine(line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '金流' } })), [{ kind: 'delta', text: '金流' }])
  assert.deepEqual(parseStreamLine(line({ type: 'content_block_stop', index: 0 })), [{ kind: 'block-stop' }])
  for (const event of [
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
    { type: 'message_start' },
  ]) assert.deepEqual(parseStreamLine(line(event)), [], JSON.stringify(event))
})

test('result 成功與失敗', () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'result', result: '答', is_error: false })), [{ kind: 'result', text: '答', isError: false }])
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'result', result: '壞了', is_error: true })), [{ kind: 'result', text: '壞了', isError: true }])
})

test('result 帶出耗時、輪數、金額；錯誤 subtype 沒有 result 文字也要回傳', () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', result: '答', is_error: false, duration_ms: 5718, num_turns: 2, total_cost_usd: 0.02 })),
    [{ kind: 'result', text: '答', isError: false, stats: { durationMs: 5718, turns: 2, costUsd: 0.02 } }])
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 2, total_cost_usd: 'x' })),
    [{ kind: 'result', text: '', isError: true, subtype: 'error_max_turns', stats: { turns: 2 } }])
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false })), [])
})

test('壞 JSON、空行、user/tool_result 行、其他 system 行 → []', () => {
  for (const line of ['', '   ', '{bad', 'null', '42',
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    JSON.stringify({ type: 'system', subtype: 'hook' }),
    JSON.stringify({ type: 'assistant', message: {} })]) {
    assert.deepEqual(parseStreamLine(line), [], line)
  }
})
