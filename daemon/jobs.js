import { randomUUID } from 'node:crypto'

const MAX_COMPLETED = 100

export function createJobStore() {
  const byId = new Map()
  const running = new Map()

  function prune() {
    const completed = [...byId.values()].filter(job => job.status !== 'running')
    for (const job of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED))) byId.delete(job.id)
  }

  function start(conversationId, runFn, { onEvent, onTerminal } = {}) {
    if (running.has(conversationId)) return null
    const subscribers = new Set()
    let handle
    const deliver = (fn, event) => { try { fn(event) } catch {} }
    const job = {
      id: randomUUID(),
      conversationId,
      status: 'running',
      history: [],
      // Resolves once onTerminal (e.g. saving the answer) has finished.
      settled: null,
      subscribe(fn) {
        for (const event of job.history) deliver(fn, event)
        if (job.status === 'running') subscribers.add(fn)
        return () => subscribers.delete(fn)
      },
      cancel() {
        if (job.status !== 'running') return
        try { handle?.cancel() } catch {}
        emit({ kind: 'error', message: '已取消' })
      },
    }

    function emit(event) {
      if (job.status !== 'running') return
      job.history.push(event)
      if (onEvent) deliver(onEvent, event)
      const terminal = event.kind === 'done' || event.kind === 'error'
      if (terminal) {
        job.status = event.kind
        running.delete(conversationId)
        let persisted
        try { persisted = onTerminal?.(job, event) } catch {}
        settle(Promise.resolve(persisted).catch(() => {}))
      }
      for (const fn of [...subscribers]) deliver(fn, event)
      if (terminal) { subscribers.clear(); prune() }
    }

    let settle
    job.settled = new Promise(resolve => { settle = resolve })
    byId.set(job.id, job)
    running.set(conversationId, job)
    void (async () => {
      try {
        handle = runFn()
        if (job.status !== 'running') { handle.cancel?.(); return }
        for await (const event of handle.events) {
          emit(event)
          if (job.status !== 'running') break
        }
        emit({ kind: 'error', message: '執行結束但沒有產生結果' })
      } catch (error) {
        emit({ kind: 'error', message: error.message || String(error) })
      }
    })()
    return job
  }

  return {
    start,
    get: id => byId.get(id) || null,
    runningFor: conversationId => running.get(conversationId) || null,
    cancelAll() { for (const job of [...running.values()]) job.cancel() },
  }
}
