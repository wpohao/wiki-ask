import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFrontMatter } from '../frontmatter.js'

test('抽出開頭的 YAML front matter', () => {
  assert.deepEqual(splitFrontMatter('---\ntitle: 金流\ntags: [a]\n---\n\n# 內文\n'), { frontMatter: 'title: 金流\ntags: [a]', body: '\n# 內文\n' })
})

test('CRLF 換行也能辨識', () => {
  assert.deepEqual(splitFrontMatter('---\r\ntitle: x\r\n---\r\n本文'), { frontMatter: 'title: x', body: '本文' })
})

test('沒有 front matter、或只是中間的分隔線時原文不變', () => {
  assert.deepEqual(splitFrontMatter('# 標題\n\n---\n\n段落'), { frontMatter: null, body: '# 標題\n\n---\n\n段落' })
  assert.deepEqual(splitFrontMatter('---\n沒有結尾'), { frontMatter: null, body: '---\n沒有結尾' })
})
