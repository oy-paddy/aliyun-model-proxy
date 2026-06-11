import type { AppConfig } from './config.js'
import type { ModelPool } from './model-pool.js'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface FreeTierExhaustion {
  request_id?: string
  code?: string
  message?: string
}

interface FreeTierExhaustionCheck {
  exhaustion: FreeTierExhaustion | null
  parseMode: 'empty' | 'json' | 'sse' | 'text' | 'unreadable'
  rawText: string
}

export interface ProxyRequestInput {
  request: Request
  body: Record<string, unknown>
  pathWithSearch: string
  config: AppConfig
  modelPool: ModelPool
}

export async function proxyAnthropicRequest(input: ProxyRequestInput): Promise<Response> {
  return proxyModelPoolRequest({
    ...input,
    upstreamBaseUrl: input.config.upstreamBaseUrl,
  })
}

export async function proxyOpenAIRequest(input: ProxyRequestInput): Promise<Response> {
  return proxyModelPoolRequest({
    ...input,
    upstreamBaseUrl: input.config.openAIUpstreamBaseUrl,
    blockedRequestHeaders: ['anthropic-beta', 'anthropic-version'],
  })
}

interface ModelPoolProxyInput extends ProxyRequestInput {
  upstreamBaseUrl: string
  blockedRequestHeaders?: string[]
}

async function proxyModelPoolRequest(input: ModelPoolProxyInput): Promise<Response> {
  const candidates = input.modelPool.getAttemptModels()

  if (candidates.length === 0) {
    return jsonResponse(503, {
      error: {
        type: 'all_models_in_cooldown',
        message: 'All configured models are currently cooling down.',
      },
      models: input.modelPool.snapshot(),
    })
  }

  const attempts: Array<{ keyHash: string, model: string }> = []
  let lastExhaustion: FreeTierExhaustion | null = null

  for (const candidate of candidates) {
    attempts.push({
      keyHash: candidate.keyLabel,
      model: candidate.modelId,
    })

    const upstreamResponse = await fetch(buildUpstreamUrl(input.upstreamBaseUrl, input.pathWithSearch), {
      method: input.request.method,
      headers: buildUpstreamHeaders(
        input.request.headers,
        input.config,
        candidate.apiKey,
        input.blockedRequestHeaders,
      ),
      body: JSON.stringify({
        ...input.body,
        model: candidate.modelId,
      }),
    })

    const exhaustionCheck = await readFreeTierExhaustion(upstreamResponse.clone())
    logUpstreamRetryDecision(input.pathWithSearch, candidate, upstreamResponse, exhaustionCheck)

    if (exhaustionCheck.exhaustion) {
      lastExhaustion = exhaustionCheck.exhaustion
      input.modelPool.markFreeTierExhausted(
        candidate,
        exhaustionCheck.exhaustion.message || 'DashScope free tier exhausted',
      )
      console.warn(
        [
          '[proxy] free-tier exhausted; trying next model',
          `path=${input.pathWithSearch}`,
          `key=${candidate.keyLabel}`,
          `model=${candidate.modelId}`,
          `attempt=${attempts.length}/${candidates.length}`,
        ].join(' '),
      )
      continue
    }

    input.modelPool.markSuccess(candidate)

    if (attempts.length > 1) {
      console.log(
        [
          '[proxy] upstream accepted after retry',
          `path=${input.pathWithSearch}`,
          `key=${candidate.keyLabel}`,
          `model=${candidate.modelId}`,
          `attempts=${attempts.length}`,
        ].join(' '),
      )
    }

    const headers = filterResponseHeaders(upstreamResponse.headers)
    headers.set('x-proxy-key-hash', candidate.keyLabel)
    headers.set('x-proxy-model', candidate.modelId)
    headers.set('x-proxy-attempts', String(attempts.length))

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    })
  }

  return jsonResponse(503, {
    error: {
      type: 'all_models_exhausted',
      message: 'Every available model returned DashScope free-tier exhaustion.',
      lastUpstreamError: lastExhaustion,
    },
    attempts,
    models: input.modelPool.snapshot(),
  })
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function buildUpstreamUrl(baseUrl: string, pathWithSearch: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${normalizedBaseUrl}${pathWithSearch.startsWith('/') ? '' : '/'}${pathWithSearch}`
}

function buildUpstreamHeaders(
  source: Headers,
  config: AppConfig,
  apiKey: string,
  blockedRequestHeaders: string[] = [],
): Headers {
  const headers = new Headers()
  const blockedHeaderNames = new Set(blockedRequestHeaders.map((header) => header.toLowerCase()))

  for (const [name, value] of source.entries()) {
    const lowerName = name.toLowerCase()

    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      blockedHeaderNames.has(lowerName) ||
      lowerName === 'authorization' ||
      lowerName === 'x-api-key'
    ) {
      continue
    }

    headers.set(name, value)
  }

  headers.set('content-type', 'application/json')

  if (config.upstreamAuthMode === 'authorization' || config.upstreamAuthMode === 'both') {
    headers.set('authorization', `Bearer ${apiKey}`)
  }

  if (config.upstreamAuthMode === 'x-api-key' || config.upstreamAuthMode === 'both') {
    headers.set('x-api-key', apiKey)
  }

  return headers
}

function filterResponseHeaders(source: Headers): Headers {
  const headers = new Headers()

  for (const [name, value] of source.entries()) {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'content-encoding') continue
    headers.set(name, value)
  }

  return headers
}

async function readFreeTierExhaustion(response: Response): Promise<FreeTierExhaustionCheck> {
  if (response.status !== 403) {
    return {
      exhaustion: null,
      parseMode: 'empty',
      rawText: '',
    }
  }

  const payload = await readErrorPayload(response)
  if (!payload.payload) {
    return {
      exhaustion: null,
      parseMode: payload.parseMode,
      rawText: payload.rawText,
    }
  }

  return {
    exhaustion: extractFreeTierExhaustion(payload.payload),
    parseMode: payload.parseMode,
    rawText: payload.rawText,
  }
}

async function readErrorPayload(response: Response): Promise<{
  payload: unknown | null
  parseMode: FreeTierExhaustionCheck['parseMode']
  rawText: string
}> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return {
      payload: null,
      parseMode: 'unreadable',
      rawText: '',
    }
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return {
      payload: null,
      parseMode: 'empty',
      rawText: '',
    }
  }

  if (trimmed.startsWith('{')) {
    try {
      return {
        payload: JSON.parse(trimmed) as unknown,
        parseMode: 'json',
        rawText: trimmed,
      }
    } catch {
      return {
        payload: null,
        parseMode: 'text',
        rawText: trimmed,
      }
    }
  }

  // DashScope can return streaming errors as:
  // event:error
  // data:{"code":"AccessDenied",...}
  for (const line of trimmed.split(/\r?\n/)) {
    const currentLine = line.trim()
    if (!currentLine.startsWith('data:')) continue

    const rawData = currentLine.slice('data:'.length).trim()
    if (!rawData || rawData === '[DONE]') continue

    try {
      return {
        payload: JSON.parse(rawData) as unknown,
        parseMode: 'sse',
        rawText: trimmed,
      }
    } catch {
      return {
        payload: null,
        parseMode: 'text',
        rawText: trimmed,
      }
    }
  }

  return {
    payload: null,
    parseMode: 'text',
    rawText: trimmed,
  }
}

function extractFreeTierExhaustion(payload: unknown): FreeTierExhaustion | null {
  if (!isRecord(payload)) return null

  const error = isRecord(payload.error) ? payload.error : null
  const code = getString(payload.code) || getString(error?.code)
  const type = getString(payload.type) || getString(error?.type)
  const message = getString(payload.message) || getString(error?.message) || ''
  const requestId =
    getString(payload.request_id) ||
    getString(payload.requestId) ||
    getString(error?.request_id) ||
    getString(error?.requestId)
  const exhausted = /free\s+tier/i.test(message) && /exhausted/i.test(message)
  const freeTierOnly = code === 'AllocationQuota.FreeTierOnly' || type === 'AllocationQuota.FreeTierOnly'

  if ((code === 'AccessDenied' && exhausted) || freeTierOnly) {
    return {
      code,
      message,
      request_id: requestId,
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function logUpstreamRetryDecision(
  pathWithSearch: string,
  candidate: { keyLabel: string, modelId: string },
  response: Response,
  check: FreeTierExhaustionCheck,
): void {
  if (response.status < 400) return

  const contentType = response.headers.get('content-type') || '-'
  const rawText = check.rawText ? previewText(check.rawText, 500) : '-'

  console.warn(
    [
      '[proxy] upstream non-2xx',
      `path=${pathWithSearch}`,
      `status=${response.status}`,
      `key=${candidate.keyLabel}`,
      `model=${candidate.modelId}`,
      `contentType=${JSON.stringify(contentType)}`,
      `parse=${check.parseMode}`,
      `freeTierExhausted=${check.exhaustion ? 'yes' : 'no'}`,
      `body=${JSON.stringify(rawText)}`,
    ].join(' '),
  )
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}...`
}
