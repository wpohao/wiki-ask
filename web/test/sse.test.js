import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser } from '../sse.js'

test('切成兩段的事件會組回一個', () => {
  const got = []
  const feed = createSseParser(e => got.push(e))
  feed('data: {"kind":"te')
  feed('xt","text":"金流"}\n\n')
  assert.deepEqual(got, [{ kind: 'text', text: '金流' }])
})

test('heartbeat 與壞 JSON 被忽略', () => {
  const got = []
  const feed = createSseParser(e => got.push(e))
  feed(': heartbeat\n\ndata: {bad\n\n')
  assert.deepEqual(got, [])
})

test('一個 chunk 裡有多個事件', () => {
  const got = []
  const feed = createSseParser(e => got.push(e))
  feed('data: {"kind":"session"}\n\ndata: {"kind":"done","text":"答","sources":[]}\n\n')
  assert.deepEqual(got.map(e => e.kind), ['session', 'done'])
})

test('CRLF 分隔也能解析', () => {
  const got = []
  const feed = createSseParser(e => got.push(e))
  feed('data: {"kind":"session"}\r\n\r\n')
  assert.deepEqual(got, [{ kind: 'session' }])
})
