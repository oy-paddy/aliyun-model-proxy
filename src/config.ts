import 'dotenv/config'

export type UpstreamAuthMode = 'authorization' | 'x-api-key' | 'both'

export interface AppConfig {
  port: number
  proxyApiKey: string
  dashscopeApiKeys: string[]
  upstreamBaseUrl: string
  openAIUpstreamBaseUrl: string
  modelIds: string[]
  cooldownMs: number
  upstreamAuthMode: UpstreamAuthMode
  corsOrigin: string | false
  statePath: string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function parsePositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`)
  }
  return value
}

function parseModelIds(): string[] {
  const models = requireEnv('MODEL_IDS')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)

  if (models.length === 0) {
    throw new Error('MODEL_IDS must contain at least one model id')
  }

  return [...new Set(models)]
}

function parseDashscopeApiKeys(): string[] {
  const raw = requireEnv('DASHSCOPE_API_KEYS')
  const keys = raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)

  if (keys.length === 0) {
    throw new Error('DASHSCOPE_API_KEYS must contain at least one key')
  }

  return [...new Set(keys)]
}

function parseUpstreamAuthMode(): UpstreamAuthMode {
  const value = process.env.UPSTREAM_AUTH_MODE?.trim() || 'authorization'

  if (value === 'authorization' || value === 'x-api-key' || value === 'both') {
    return value
  }

  throw new Error('UPSTREAM_AUTH_MODE must be authorization, x-api-key, or both')
}

function parseCorsOrigin(): string | false {
  const value = process.env.CORS_ORIGIN?.trim()
  if (!value) return '*'
  if (value.toLowerCase() === 'false') return false
  return value
}

export function loadConfig(): AppConfig {
  return {
    port: parsePositiveNumber('PORT', 3000),
    proxyApiKey: requireEnv('PROXY_API_KEY'),
    dashscopeApiKeys: parseDashscopeApiKeys(),
    upstreamBaseUrl:
      process.env.UPSTREAM_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/apps/anthropic',
    openAIUpstreamBaseUrl:
      process.env.OPENAI_UPSTREAM_BASE_URL?.trim() ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelIds: parseModelIds(),
    cooldownMs: parsePositiveNumber('MODEL_COOLDOWN_SECONDS', 2592000) * 1000,
    upstreamAuthMode: parseUpstreamAuthMode(),
    corsOrigin: parseCorsOrigin(),
    statePath: process.env.STATE_PATH?.trim() || './data/proxy-state.json',
  }
}
