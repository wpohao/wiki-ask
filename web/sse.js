// Parses a text/event-stream body read through fetch (EventSource cannot send the token header).
export function createSseParser(onEvent) {
  let buffer = ''
  return chunk => {
    buffer += chunk.replace(/\r\n/g, '\n')
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (!data) continue
      let event
      try { event = JSON.parse(data) } catch { continue }
      onEvent(event)
    }
  }
}
