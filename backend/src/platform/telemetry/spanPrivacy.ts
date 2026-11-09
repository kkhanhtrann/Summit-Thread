// Remove content-bearing provider exceptions at the trace export boundary
export function sanitizeSpanErrors<T extends { events: readonly { name: string }[]; status: { code: number; message?: string } }>(span: T): T {
  return { ...span, events: span.events.filter((event) => event.name !== 'exception'), status: { code: span.status.code } };
}
