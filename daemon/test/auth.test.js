import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateToken, tokenMatches, loadOrCreateToken } from '../auth.js'

test('generateToken 產生 64 字元 hex', () => {
  const token = generateToken()
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]{64}$/)
})

test('generateToken 每次都不同', () => {
  assert.notEqual(generateToken(), generateToken())
})

test('tokenMatches 對相同 token 回傳 true', () => {
  const token = generateToken()
  assert.equal(tokenMatches(token, token), true)
})

test('tokenMatches 對不同 token 回傳 false', () => {
  assert.equal(tokenMatches(generateToken(), generateToken()), false)
})

test('tokenMatches 對非字串輸入回傳 false 而不是拋錯', () => {
  const token = generateToken()
  assert.equal(tokenMatches(token, undefined), false)
  assert.equal(tokenMatches(token, null), false)
  assert.equal(tokenMatches(token, 12345), false)
  assert.equal(tokenMatches(token, ['x']), false)
})

test('tokenMatches 對長度不同的字串回傳 false 而不是拋錯', () => {
  assert.equal(tokenMatches(generateToken(), 'abc'), false)
})

test('loadOrCreateToken 第一次呼叫會建立檔案', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wikichat-'))
  const token = await loadOrCreateToken(dir)
  assert.match(token, /^[0-9a-f]{64}$/)
  const onDisk = await readFile(join(dir, 'token'), 'utf8')
  assert.equal(onDisk.trim(), token)
})

test('loadOrCreateToken 第二次呼叫回傳同一個 token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wikichat-'))
  const first = await loadOrCreateToken(dir)
  const second = await loadOrCreateToken(dir)
  assert.equal(first, second)
})

test('loadOrCreateToken 併發建立時所有呼叫取得同一個 token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wikichat-auth-race-'))
  try {
    const tokens = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateToken(dir)))
    assert.equal(new Set(tokens).size, 1)
    assert.equal((await readFile(join(dir, 'token'), 'utf8')).trim(), tokens[0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
