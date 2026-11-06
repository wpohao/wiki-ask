import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodePickerOutput } from '../oshelpers.js'

test('decodePickerOutput 還原中文路徑', () => {
  const p = 'C:\\Users\\x\\Desktop\\WIKI 知識庫'
  assert.equal(decodePickerOutput(Buffer.from(p, 'utf8').toString('base64') + '\r\n'), p)
})

test('decodePickerOutput 空輸出回 null', () => {
  assert.equal(decodePickerOutput('  \r\n'), null)
  assert.equal(decodePickerOutput(''), null)
})

test('explorerArgs 一律加引號，含逗號的檔名不會被拆開', async () => {
  const { explorerArgs } = await import('../oshelpers.js')
  assert.deepEqual(explorerArgs('C:\\WIKI 知識庫\\a,b.md'), ['"C:\\WIKI 知識庫\\a,b.md"'])
})
