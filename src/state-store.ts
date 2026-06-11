import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  fsyncSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'

interface RuntimeStateEntry {
  value: string
  updatedAt: number
}

interface StateFile {
  version: 1
  modelState: Record<string, PersistedModelState>
  runtimeState: Record<string, RuntimeStateEntry>
}

export interface PersistedModelState {
  keyHash: string
  modelId: string
  cooldownUntil: number
  failureCount: number
  lastError: string | null
  lastUsedAt: number | null
  updatedAt: number
}

export class StateStore {
  private readonly statePath: string
  private state: StateFile

  constructor(statePath: string) {
    this.statePath = resolve(statePath)
    mkdirSync(dirname(this.statePath), { recursive: true })
    this.state = this.load()
  }

  ensureModelStates(keyHashes: string[], modelIds: string[], now = Date.now()): void {
    let changed = false

    for (const keyHash of keyHashes) {
      for (const modelId of modelIds) {
        if (this.ensureModelStateEntry(keyHash, modelId, now)) {
          changed = true
        }
      }
    }

    if (changed) this.persist()
  }

  getModelState(keyHash: string, modelId: string): PersistedModelState {
    const entry = this.ensureModelStateEntry(keyHash, modelId, Date.now())

    if (entry) {
      this.persist()
      return { ...entry }
    }

    return { ...this.state.modelState[modelStateKey(keyHash, modelId)] }
  }

  markSuccess(keyHash: string, modelId: string, now = Date.now()): void {
    const entry = this.getOrCreateModelStateEntry(keyHash, modelId, now)

    entry.lastError = null
    entry.lastUsedAt = now
    entry.updatedAt = now

    this.persist()
  }

  markFreeTierExhausted(
    keyHash: string,
    modelId: string,
    cooldownUntil: number,
    reason: string,
    now = Date.now(),
  ): void {
    const entry = this.getOrCreateModelStateEntry(keyHash, modelId, now)

    entry.cooldownUntil = cooldownUntil
    entry.failureCount += 1
    entry.lastError = reason
    entry.updatedAt = now

    this.persist()
  }

  getRuntimeNumber(name: string, fallback: number): number {
    const entry = this.state.runtimeState[name]
    if (!entry) return fallback

    const value = Number(entry.value)
    return Number.isInteger(value) && value >= 0 ? value : fallback
  }

  setRuntimeNumber(name: string, value: number, now = Date.now()): void {
    this.state.runtimeState[name] = {
      value: String(value),
      updatedAt: now,
    }

    this.persist()
  }

  close(): void {
    // State changes are persisted synchronously when they happen.
  }

  private load(): StateFile {
    if (!existsSync(this.statePath)) return emptyStateFile()

    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
      return parseStateFile(parsed)
    } catch (error) {
      this.backupCorruptStateFile(error)
      return emptyStateFile()
    }
  }

  private persist(): void {
    const content = `${JSON.stringify(this.state, null, 2)}\n`
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(tempPath, 'w')

    try {
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    renameSync(tempPath, this.statePath)
  }

  private ensureModelStateEntry(
    keyHash: string,
    modelId: string,
    now: number,
  ): PersistedModelState | null {
    const key = modelStateKey(keyHash, modelId)
    const existing = this.state.modelState[key]

    if (existing) return null

    const entry = createModelState(keyHash, modelId, now)
    this.state.modelState[key] = entry
    return entry
  }

  private getOrCreateModelStateEntry(
    keyHash: string,
    modelId: string,
    now: number,
  ): PersistedModelState {
    const key = modelStateKey(keyHash, modelId)
    const existing = this.state.modelState[key]

    if (existing) return existing

    const entry = createModelState(keyHash, modelId, now)
    this.state.modelState[key] = entry
    return entry
  }

  private backupCorruptStateFile(error: unknown): void {
    const backupPath = `${this.statePath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`

    try {
      renameSync(this.statePath, backupPath)
      console.warn(
        `[state] invalid state file moved to ${backupPath}: ${formatErrorMessage(error)}`,
      )
    } catch (backupError) {
      console.warn(
        `[state] invalid state file could not be backed up: ${formatErrorMessage(backupError)}`,
      )
    }
  }
}

function emptyStateFile(): StateFile {
  return {
    version: 1,
    modelState: {},
    runtimeState: {},
  }
}

function createModelState(keyHash: string, modelId: string, now: number): PersistedModelState {
  return {
    keyHash,
    modelId,
    cooldownUntil: 0,
    failureCount: 0,
    lastError: null,
    lastUsedAt: null,
    updatedAt: now,
  }
}

function parseStateFile(value: unknown): StateFile {
  if (!isRecord(value)) {
    throw new Error('state file must be a JSON object')
  }

  if (value.version !== 1) {
    throw new Error('unsupported state file version')
  }

  if (!isRecord(value.modelState)) {
    throw new Error('state file modelState must be an object')
  }

  if (!isRecord(value.runtimeState)) {
    throw new Error('state file runtimeState must be an object')
  }

  const modelState: Record<string, PersistedModelState> = {}
  for (const entry of Object.values(value.modelState)) {
    const parsedEntry = parseModelStateEntry(entry)
    modelState[modelStateKey(parsedEntry.keyHash, parsedEntry.modelId)] = parsedEntry
  }

  const runtimeState: Record<string, RuntimeStateEntry> = {}
  for (const [name, entry] of Object.entries(value.runtimeState)) {
    runtimeState[name] = parseRuntimeStateEntry(entry)
  }

  return {
    version: 1,
    modelState,
    runtimeState,
  }
}

function parseModelStateEntry(value: unknown): PersistedModelState {
  if (!isRecord(value)) {
    throw new Error('modelState entries must be objects')
  }

  if (!isNonEmptyString(value.keyHash)) {
    throw new Error('modelState entry keyHash must be a non-empty string')
  }

  if (!isNonEmptyString(value.modelId)) {
    throw new Error('modelState entry modelId must be a non-empty string')
  }

  if (!isNonNegativeInteger(value.cooldownUntil)) {
    throw new Error('modelState entry cooldownUntil must be a non-negative integer')
  }

  if (!isNonNegativeInteger(value.failureCount)) {
    throw new Error('modelState entry failureCount must be a non-negative integer')
  }

  if (value.lastError !== null && typeof value.lastError !== 'string') {
    throw new Error('modelState entry lastError must be a string or null')
  }

  if (value.lastUsedAt !== null && !isNonNegativeInteger(value.lastUsedAt)) {
    throw new Error('modelState entry lastUsedAt must be a non-negative integer or null')
  }

  if (!isNonNegativeInteger(value.updatedAt)) {
    throw new Error('modelState entry updatedAt must be a non-negative integer')
  }

  return {
    keyHash: value.keyHash,
    modelId: value.modelId,
    cooldownUntil: value.cooldownUntil,
    failureCount: value.failureCount,
    lastError: value.lastError,
    lastUsedAt: value.lastUsedAt,
    updatedAt: value.updatedAt,
  }
}

function parseRuntimeStateEntry(value: unknown): RuntimeStateEntry {
  if (!isRecord(value)) {
    throw new Error('runtimeState entries must be objects')
  }

  if (typeof value.value !== 'string') {
    throw new Error('runtimeState entry value must be a string')
  }

  if (!isNonNegativeInteger(value.updatedAt)) {
    throw new Error('runtimeState entry updatedAt must be a non-negative integer')
  }

  return {
    value: value.value,
    updatedAt: value.updatedAt,
  }
}

function modelStateKey(keyHash: string, modelId: string): string {
  return `${keyHash}:${modelId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
