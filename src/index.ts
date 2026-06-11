import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { loadConfig } from './config.js'
import { ModelPool } from './model-pool.js'
import { StateStore } from './state-store.js'
import { jsonResponse, proxyAnthropicRequest, proxyOpenAIRequest } from './upstream.js'

const config = loadConfig()
const stateStore = new StateStore(config.statePath)
const modelPool = new ModelPool(
  config.dashscopeApiKeys,
  config.modelIds,
  config.cooldownMs,
  stateStore,
)
const app = new Hono()

if (config.corsOrigin !== false) {
  app.use(
    '*',
    cors({
      origin: config.corsOrigin,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: [
        'authorization',
        'content-type',
        'x-api-key',
        'openai-organization',
        'openai-project',
        'anthropic-version',
        'anthropic-beta',
      ],
      exposeHeaders: ['x-proxy-key-hash', 'x-proxy-model', 'x-proxy-attempts'],
    }),
  )
}

app.use('*', requestLogger)

app.get('/', (c) => {
  return c.json({
    name: 'dashscope-model-proxy',
    endpoints: ['/health', '/models/status', '/v1/models', '/v1/messages', '/v1/chat/completions'],
  })
})

app.get('/health', (c) => {
  return c.json({
    ok: true,
    totalKeys: modelPool.totalKeys(),
    modelsPerKey: modelPool.totalModelsPerKey(),
    totalSlots: modelPool.totalSlots(),
    availableSlots: modelPool.availableCount(),
  })
})

app.use('/models/status', requireProxyKey)
app.get('/models/status', (c) => {
  return c.json({
    totalKeys: modelPool.totalKeys(),
    modelsPerKey: modelPool.totalModelsPerKey(),
    totalSlots: modelPool.totalSlots(),
    availableSlots: modelPool.availableCount(),
    models: modelPool.snapshot(),
  })
})

app.use('/v1/*', requireProxyKey)
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: config.modelIds.map((modelId) => ({
      id: modelId,
      object: 'model',
      created: 0,
      owned_by: 'dashscope-model-proxy',
    })),
  })
})

app.post('/v1/chat/completions', async (c) => {
  let body: unknown

  try {
    body = await c.req.json()
  } catch {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: 'Request body must be valid JSON.',
        },
      },
      400,
    )
  }

  if (!isPlainObject(body)) {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: 'Request body must be a JSON object.',
        },
      },
      400,
    )
  }

  const url = new URL(c.req.url)
  const upstreamPath = url.pathname.replace(/^\/v1/, '') || url.pathname

  try {
    return await proxyOpenAIRequest({
      request: c.req.raw,
      body,
      pathWithSearch: `${upstreamPath}${url.search}`,
      config,
      modelPool,
    })
  } catch (error) {
    console.error('[proxy] upstream request failed:', error)
    return jsonResponse(502, {
      error: {
        type: 'upstream_error',
        message: error instanceof Error ? error.message : 'Upstream request failed.',
      },
    })
  }
})

app.post('/v1/*', async (c) => {
  let body: unknown

  try {
    body = await c.req.json()
  } catch {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: 'Request body must be valid JSON.',
        },
      },
      400,
    )
  }

  if (!isPlainObject(body)) {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: 'Request body must be a JSON object.',
        },
      },
      400,
    )
  }

  const url = new URL(c.req.url)

  try {
    return await proxyAnthropicRequest({
      request: c.req.raw,
      body,
      pathWithSearch: `${url.pathname}${url.search}`,
      config,
      modelPool,
    })
  } catch (error) {
    console.error('[proxy] upstream request failed:', error)
    return jsonResponse(502, {
      error: {
        type: 'upstream_error',
        message: error instanceof Error ? error.message : 'Upstream request failed.',
      },
    })
  }
})

app.all('/v1/*', (c) => {
  return c.json(
    {
      error: {
        type: 'method_not_allowed',
        message: 'Only POST requests are proxied under /v1/*.',
      },
    },
    405,
  )
})

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`[proxy] listening on http://localhost:${info.port}`)
    console.log(`[proxy] upstream base: ${config.upstreamBaseUrl}`)
    console.log(`[proxy] openai upstream base: ${config.openAIUpstreamBaseUrl}`)
    console.log(`[proxy] api keys loaded: ${config.dashscopeApiKeys.length}`)
    console.log(`[proxy] models per key: ${config.modelIds.length}`)
    console.log('[proxy] applied model ids:')
    for (const modelId of config.modelIds) {
      console.log(`[proxy]   - ${modelId}`)
    }
    console.log('[proxy] reminder: 请在 DashScope/百炼控制台为以上模型开启“模型用完即停”。')
    console.log(`[proxy] state file: ${config.statePath}`)
  },
)

async function requireProxyKey(c: Context, next: Next): Promise<Response | void> {
  if (!isAuthorized(c.req.raw.headers, config.proxyApiKey)) {
    return c.json(
      {
        error: {
          type: 'authentication_error',
          message: 'Invalid proxy API key.',
        },
      },
      401,
    )
  }

  await next()
}

async function requestLogger(c: Context, next: Next): Promise<void> {
  const startedAt = Date.now()
  const url = new URL(c.req.url)
  const contentLength = c.req.raw.headers.get('content-length') || '-'
  const userAgent = c.req.raw.headers.get('user-agent') || '-'

  await next()

  const durationMs = Date.now() - startedAt
  const status = c.res.status
  const proxyKeyHash = c.res.headers.get('x-proxy-key-hash') || '-'
  const proxyModel = c.res.headers.get('x-proxy-model') || '-'
  const proxyAttempts = c.res.headers.get('x-proxy-attempts') || '-'

  console.log(
    [
      '[request]',
      `${c.req.method} ${url.pathname}${url.search}`,
      `status=${status}`,
      `duration=${durationMs}ms`,
      `bytes=${contentLength}`,
      `proxyKey=${proxyKeyHash}`,
      `model=${proxyModel}`,
      `attempts=${proxyAttempts}`,
      `ua=${JSON.stringify(userAgent)}`,
    ].join(' '),
  )
}

function isAuthorized(headers: Headers, expectedKey: string): boolean {
  const xApiKey = headers.get('x-api-key')?.trim()
  if (xApiKey === expectedKey) return true

  const authorization = headers.get('authorization')?.trim()
  if (!authorization) return false

  const bearerPrefix = 'Bearer '
  if (authorization.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim() === expectedKey
  }

  return authorization === expectedKey
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
