import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  recordIncomingRequestAttributes,
  redactSensitiveQuery,
} from '../../../src/telemetry/otel'

describe('OpenTelemetry URL redaction', () => {
  it('removes sensitive query values and preserves unrelated parameters', () => {
    expect(redactSensitiveQuery('/email/verify?token=abc&page=1&CODE=x')).toBe(
      '/email/verify?token=[REDACTED]&page=1&CODE=[REDACTED]'
    )
  })

  it('exports request span attributes without verification tokens', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const span = provider.getTracer('test').startSpan('GET /email/verify')
    recordIncomingRequestAttributes(span, {
      url: '/email/verify?token=abc&page=1',
      headers: { host: 'localhost:3000' },
    } as any)
    span.end()

    const attributes = exporter.getFinishedSpans()[0].attributes
    expect(JSON.stringify(attributes)).not.toContain('abc')
    expect(attributes['url.full']).toBe(
      'http://localhost:3000/email/verify?token=[REDACTED]&page=1'
    )
    await provider.shutdown()
  })
})
