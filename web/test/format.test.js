import { test } from 'node:test'
import assert from 'node:assert/strict'
import { elapsedText, shortPath, visibleAnswer } from '../format.js'

test('visibleAnswer 去掉 <sources> 區塊與之後的內容', () => {
  assert.equal(visibleAnswer('答案\n<sources>\na/b.md\n</sources>'), '答案\n')
  assert.equal(visibleAnswer('答案\n<sources>\na/b'), '答案\n')
})

test('visibleAnswer 去掉結尾寫到一半的 <sources> 標籤', () => {
  assert.equal(visibleAnswer('答案\n<sour'), '答案\n')
  assert.equal(visibleAnswer('答案\n<'), '答案\n')
  assert.equal(visibleAnswer('a < b 成立'), 'a < b 成立')
})

test('visibleAnswer 處理空值', () => {
  assert.equal(visibleAnswer(''), '')
  assert.equal(visibleAnswer(undefined), '')
})

test('shortPath 帶上一層資料夾', () => {
  assert.equal(shortPath('專案/功能/index.md'), '功能/index.md')
  assert.equal(shortPath('index.md'), 'index.md')
  assert.equal(shortPath('a\\b\\c.md'), 'b/c.md')
})

test('elapsedText 秒與分', () => {
  assert.equal(elapsedText(0), '0 秒')
  assert.equal(elapsedText(59_900), '59 秒')
  assert.equal(elapsedText(65_000), '1 分 05 秒')
})

test('statsText 組出耗時、輪數、金額，缺的略過', async () => {
  const { statsText } = await import('../format.js')
  assert.equal(statsText({ durationMs: 65_000, turns: 12, costUsd: 0.214 }), '耗時 1 分 05 秒 · 12 輪 · 約 US$0.21')
  assert.equal(statsText({ costUsd: 0.004 }), '約 < US$0.01')
  assert.equal(statsText({ turns: 3 }), '3 輪')
  assert.equal(statsText(null), '')
  assert.equal(statsText(undefined), '')
})
