import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHref, classifyImage, dirOf, findHeading, headingSlug, joinWikiPath } from '../links.js'

test('dirOf 與 joinWikiPath', () => {
  assert.equal(dirOf('a/b/c.md'), 'a/b')
  assert.equal(dirOf('c.md'), '')
  assert.equal(joinWikiPath('a/b', '../c/d.md'), 'a/c/d.md')
  assert.equal(joinWikiPath('a/b', './d.md'), 'a/b/d.md')
  assert.equal(joinWikiPath('a/b', '/x/y.md'), 'x/y.md')
  assert.equal(joinWikiPath('a', '../../x.md'), null)
  assert.equal(joinWikiPath('', '..\\x.md'), null)
})

test('classifyHref：WIKI 的 .md 連結，中文已被 marked 編碼', () => {
  assert.deepEqual(classifyHref('%E7%94%A2%E5%93%81_%E5%84%AA%E5%8C%96.md', 'Product'), { type: 'wiki', path: 'Product/產品_優化.md', anchor: null })
  assert.deepEqual(classifyHref('../Backend/index.md', 'Product'), { type: 'wiki', path: 'Backend/index.md', anchor: null })
  assert.deepEqual(classifyHref('a%20b.md#%E6%9F%A5%E8%A9%A2-abc', ''), { type: 'wiki', path: 'a b.md', anchor: '查詢-abc' })
})

test('classifyHref：資料夾、錨點、外部網址', () => {
  assert.deepEqual(classifyHref('%E5%BB%A0%E5%95%86%E8%A6%8F%E6%A0%BC/', '專案A'), { type: 'folder', path: '專案A/廠商規格/index.md' })
  assert.deepEqual(classifyHref('#%E6%9F%A5%E8%A9%A2%E4%BF%A1%E6%81%AF%E7%9B%92', 'x'), { type: 'anchor', anchor: '查詢信息盒' })
  assert.deepEqual(classifyHref('https://example.com/a#b', ''), { type: 'external', url: 'https://example.com/a#b' })
})

test('classifyHref：跟不了的一律當文字', () => {
  for (const href of [':56-61', 'mailto:a@b.c', 'C:\\x.md', 'file:///c/x.md', '_原始檔/a.html', 'x.pdf', '../../x.md', '', '#', '%E0%A4%A.md']) {
    assert.deepEqual(classifyHref(href, 'a'), { type: 'text' }, href)
  }
})

test('classifyImage：WIKI 圖片、外部圖片、其他', () => {
  assert.deepEqual(classifyImage('./images/Flow.png', 'Guide/指南'), { type: 'wiki', path: 'Guide/指南/images/Flow.png' })
  assert.deepEqual(classifyImage('https://hackmd.io/_uploads/x.png', ''), { type: 'external', url: 'https://hackmd.io/_uploads/x.png' })
  for (const src of ['data:image/png;base64,AA', './a.svg', '../../x.png', '']) assert.deepEqual(classifyImage(src, 'a'), { type: 'other' }, src)
})

test('headingSlug 與 GitHub 規則一致', () => {
  assert.equal(headingSlug('查詢新增的 UserProfileId'), '查詢新增的-userprofileid')
  assert.equal(headingSlug('二、流程（說明）'), '二流程說明')
  assert.equal(headingSlug(' A_b-c '), 'a_b-c')
})

test('findHeading：slug、重複標題、手寫標題文字', () => {
  const headings = ['查詢用', '查詢信息盒', '說明', '說明']
  assert.equal(findHeading(headings, '查詢信息盒'), 1)
  assert.equal(findHeading(headings, '說明-1'), 3)
  assert.equal(findHeading(['Step 1: Login'], 'Step 1: Login'), 0)
  assert.equal(findHeading(headings, '不存在'), -1)
  assert.equal(findHeading(headings, ''), -1)
})

test('wrapSpacedTargets：路徑有空白或括號時包成 <…>', async () => {
  const { wrapSpacedTargets } = await import('../links.js')
  assert.equal(
    wrapSpacedTargets('![清單](.attachments/簡報 (內部用)/a.png)'),
    '![清單](<.attachments/簡報 (內部用)/a.png>)',
  )
  assert.equal(wrapSpacedTargets('看 [規格](../規格 v2.md) 與 [b](b.md)'), '看 [規格](<../規格 v2.md>) 與 [b](b.md)')
  assert.equal(wrapSpacedTargets('[資料夾](廠商 規格/)'), '[資料夾](<廠商 規格/>)')
})

test('wrapSpacedTargets：其他寫法保持原樣', async () => {
  const { wrapSpacedTargets } = await import('../links.js')
  for (const line of [
    '![a](img.png "標題")',
    '[a](<已經 包好.md>)',
    '[注意](請看 下面)',
    '[a](https://x.y/a b.png)',
    '![a](data:image/png;base64...)',
    '[a](b.md) 沒有空白',
    '括號 (不是連結 a.md)',
  ]) assert.equal(wrapSpacedTargets(line), line, line)
  const code = '```\n![a](x y.png)\n```\n![a](x y.png)'
  assert.equal(wrapSpacedTargets(code), '```\n![a](x y.png)\n```\n![a](<x y.png>)')
})

test('isTruncatedDataImage 與 attachmentPath', async () => {
  const { attachmentPath, isTruncatedDataImage } = await import('../links.js')
  assert.equal(isTruncatedDataImage('data:image/png;base64...'), true)
  assert.equal(isTruncatedDataImage('data:image/png;base64,iVBORw0KGgo='), false)
  assert.equal(isTruncatedDataImage('a.png'), false)
  assert.equal(attachmentPath('raw/產品/V1.4.1 規格.md', 'image2.png'), 'raw/產品/.attachments/V1.4.1 規格/image2.png')
  assert.equal(attachmentPath('頂層.md', 'a.png'), '.attachments/頂層/a.png')
})
