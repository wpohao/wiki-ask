import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSources, pickSources } from '../sources.js'

test('extractSources 移除區塊並正規化路徑', () => {
  const r = extractSources('答案。\n\n<sources>\n- 金流\\串接設計.md\n./index.md\n../etc.md\n金流/串接設計.md\n</sources>\n')
  assert.equal(r.body, '答案。')
  assert.deepEqual(r.sources, ['金流/串接設計.md', 'index.md'])
})

test('extractSources 有多個區塊時取最後一個，其他區塊保留在 body', () => {
  const r = extractSources('範例 <sources>a.md</sources> 說明\n<sources>\nb.md\n</sources>')
  assert.equal(r.body, '範例 <sources>a.md</sources> 說明')
  assert.deepEqual(r.sources, ['b.md'])
})

test('extractSources 沒有區塊時 body 原文不變', () => {
  assert.deepEqual(extractSources('WIKI 沒有這份資料'), { body: 'WIKI 沒有這份資料', sources: [] })
})

test('extractSources 空區塊回 []', () => {
  assert.deepEqual(extractSources('答\n<sources>\n</sources>'), { body: '答', sources: [] })
})

test('pickSources 有宣告就用宣告，否則用讀過的 .md', () => {
  assert.deepEqual(pickSources(['a.md'], ['b.md']), ['a.md'])
  assert.deepEqual(pickSources([], ['b.md', 'b.md', 'c.txt']), ['b.md'])
})
