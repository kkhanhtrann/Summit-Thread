// Remove content-bearing provider exceptions at the trace export boundary
export function sanitizeSpanErrors<T extends { events: readonly { name: string }[]; status: { code: number; message?: string } }>(span: T): T {
  // Preserve SDK methods and getters while keeping the original span unchanged
  return Object.assign(Object.create(Object.getPrototypeOf(span)), span, {
    events: span.events.filter((event) => event.name !== 'exception'),
    status: { code: span.status.code }
  });
}
