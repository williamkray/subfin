// Only instrument if Datadog env vars are present
if (process.env.DD_SERVICE) {
  const { default: tracer } = await import('dd-trace');

  tracer.init({ logInjection: true });

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function ddCtx() {
    const span = tracer.scope().active();
    if (!span) return {};
    const ctx = span.context();
    return {
      'dd.trace_id': ctx.toTraceId(),
      'dd.span_id': ctx.toSpanId(),
      'dd.env': process.env.DD_ENV ?? '',
      'dd.service': process.env.DD_SERVICE ?? '',
      'dd.version': process.env.DD_VERSION ?? '',
    };
  }

  console.log = (...args: unknown[]) =>
    orig.log(JSON.stringify({ level: 'info', message: args.join(' '), ...ddCtx() }));
  console.warn = (...args: unknown[]) =>
    orig.warn(JSON.stringify({ level: 'warn', message: args.join(' '), ...ddCtx() }));
  console.error = (...args: unknown[]) =>
    orig.error(JSON.stringify({ level: 'error', message: args.join(' '), ...ddCtx() }));
}
