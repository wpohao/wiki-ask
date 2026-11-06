import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobStore } from '../jobs.js'

// A controllable run handle: push() events from the test, end() to finish the stream.
function controllable() {
  const queue = []
  let wake
  let ended = false
  let cancelled = 0
  const handle = {
    events: (async function* () {
      while (true) {
        if (queue.length) { yield queue.shift(); continue }
        if (ended) return
        await new Promise(resolve => { wake = resolve })
      }
    })(),
    cancel() { cancelled += 1; ended = true; wake?.() },
  }
  return {
    handle,
    push(event) { queue.push(event); wake?.() },
    end() { ended = true; wake?.() },
    get cancelled() { return cancelled },
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function waitTerminal(job) {
  return new Promise(resolve => job.subscribe(event => { if (event.kind === 'done' || event.kind === 'error') resolve(event) }))
}

test('同一對話執行中再 start 回 null；不同對話可以並行', () => {
  const store = createJobStore()
  const a = store.start('c1', () => controllable().handle)
  assert.ok(a)
  assert.equal(store.start('c1', () => controllable().handle), null)
  assert.ok(store.start('c2', () => controllable().handle))
  assert.equal(store.runningFor('c1'), a)
  assert.equal(store.get(a.id), a)
  assert.equal(a.conversationId, 'c1')
})

test('subscribe 會回放歷史事件，完成後 runningFor 回 null、可以再 start', async () => {
  const store = createJobStore()
  const run = controllable()
  const job = store.start('c1', () => run.handle)
  run.push({ kind: 'tool', tool: 'Read', detail: 'a.md' })
  await tick()
  const seen = []
  const done = waitTerminal(job)
  job.subscribe(event => seen.push(event.kind))
  run.push({ kind: 'done', text: '答', sources: [] })
  await done
  assert.deepEqual(seen, ['tool', 'done'])
  assert.equal(job.status, 'done')
  assert.equal(store.runningFor('c1'), null)
  assert.ok(store.start('c1', () => controllable().handle))
})

test('onEvent 收到每個事件，onTerminal 只呼叫一次', async () => {
  const store = createJobStore()
  const run = controllable()
  const events = []
  let terminal = 0
  const job = store.start('c1', () => run.handle, { onEvent: e => events.push(e.kind), onTerminal: () => { terminal += 1 } })
  const done = waitTerminal(job)
  run.push({ kind: 'session' })
  run.push({ kind: 'done', text: '答', sources: [] })
  run.push({ kind: 'error', message: '多餘' })
  await done
  await tick()
  assert.deepEqual(events, ['session', 'done'])
  assert.equal(terminal, 1)
})

test('settled 等到 onTerminal 的 promise 完成才 resolve', async () => {
  const store = createJobStore()
  const run = controllable()
  let persisted = false
  let release
  const job = store.start('c1', () => run.handle, {
    onTerminal: () => new Promise(resolve => { release = () => { persisted = true; resolve() } }),
  })
  run.push({ kind: 'done', text: '答', sources: [] })
  await tick()
  let settled = false
  job.settled.then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  release()
  await job.settled
  assert.equal(persisted, true)
})

test('cancel 會呼叫 handle.cancel，並發出 error「已取消」', async () => {
  const store = createJobStore()
  const run = controllable()
  const job = store.start('c1', () => run.handle)
  const terminal = waitTerminal(job)
  await tick()
  job.cancel()
  assert.deepEqual(await terminal, { kind: 'error', message: '已取消' })
  assert.equal(run.cancelled, 1)
  assert.equal(store.runningFor('c1'), null)
})

test('events 結束卻沒有 done/error → error「執行結束但沒有產生結果」', async () => {
  const store = createJobStore()
  const run = controllable()
  const job = store.start('c1', () => run.handle)
  const terminal = waitTerminal(job)
  run.end()
  assert.deepEqual(await terminal, { kind: 'error', message: '執行結束但沒有產生結果' })
})

test('cancelAll 取消所有執行中的 job', async () => {
  const store = createJobStore()
  const runs = [controllable(), controllable()]
  store.start('c1', () => runs[0].handle)
  store.start('c2', () => runs[1].handle)
  store.cancelAll()
  assert.deepEqual(runs.map(r => r.cancelled), [1, 1])
})
