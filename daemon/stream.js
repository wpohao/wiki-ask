const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

// How long the answer took, how many model turns it used, and its estimated cost at API list price.
function resultStats(event) {
  const stats = {}
  if (finite(event.duration_ms)) stats.durationMs = event.duration_ms
  if (finite(event.num_turns)) stats.turns = event.num_turns
  if (finite(event.total_cost_usd)) stats.costUsd = event.total_cost_usd
  return Object.keys(stats).length ? stats : null
}

export function parseStreamLine(line) {
  if (typeof line !== 'string' || !line.trim()) return []

  let event
  try {
    event = JSON.parse(line)
  } catch {
    return []
  }
  if (!event || typeof event !== 'object') return []

  if (event.type === 'system' && event.subtype === 'init') {
    return typeof event.session_id === 'string' ? [{ kind: 'init', sessionId: event.session_id }] : []
  }

  // With --include-partial-messages, text arrives as deltas. The `assistant` snapshot of a text block can be
  // cut short, so text is rebuilt from these events instead (see claude.js).
  if (event.type === 'stream_event') {
    const inner = event.event
    if (inner?.type === 'content_block_start' && inner.content_block?.type === 'text') return [{ kind: 'block-start' }]
    if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
      return inner.delta.text ? [{ kind: 'delta', text: inner.delta.text }] : []
    }
    if (inner?.type === 'content_block_stop') return [{ kind: 'block-stop' }]
    return []
  }

  if (event.type === 'result') {
    // An error result (e.g. error_max_turns) has no `result` text but still reports its stats.
    const errorSubtype = typeof event.subtype === 'string' && event.subtype.startsWith('error_')
    if (typeof event.result !== 'string' && !errorSubtype) return []
    const parsed = { kind: 'result', text: typeof event.result === 'string' ? event.result : '', isError: event.is_error === true || errorSubtype }
    if (errorSubtype) parsed.subtype = event.subtype
    const stats = resultStats(event)
    if (stats) parsed.stats = stats
    return [parsed]
  }

  if (event.type === 'assistant') {
    const content = event.message?.content
    if (!Array.isArray(content)) return []
    const events = []
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        events.push({ kind: 'tool', tool: block.name, input: block.input && typeof block.input === 'object' ? block.input : {} })
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'text', text: block.text })
      }
    }
    return events
  }

  return []
}
