import { createHash } from 'node:crypto'
import type { StateStore } from './state-store.js'

export interface ModelCandidate {
  apiKey: string
  keyHash: string
  keyLabel: string
  keyIndex: number
  modelId: string
  modelIndex: number
}

export interface ModelSnapshot {
  keyHash: string
  keyIndex: number
  currentKey: boolean
  currentModel: boolean
  id: string
  available: boolean
  cooldownUntil: string | null
  failureCount: number
  lastError: string | null
  lastUsedAt: string | null
}

interface ApiKeySlot {
  value: string
  hash: string
  label: string
  index: number
}

const KEY_CURSOR_NAME = 'key_cursor'

export class ModelPool {
  private readonly apiKeys: ApiKeySlot[]

  constructor(
    apiKeys: string[],
    private readonly modelIds: string[],
    private readonly cooldownMs: number,
    private readonly stateStore: StateStore,
  ) {
    this.apiKeys = apiKeys.map((value, index) => {
      const hash = hashApiKey(value)
      return {
        value,
        hash,
        label: hash.slice(0, 12),
        index,
      }
    })

    this.stateStore.ensureModelStates(
      this.apiKeys.map((key) => key.hash),
      this.modelIds,
    )
  }

  getAttemptModels(now = Date.now()): ModelCandidate[] {
    const result: ModelCandidate[] = []
    const currentKeyIndex = this.normalizeKeyIndex(this.getKeyCursor())
    let firstAvailableKeyIndex: number | null = null

    for (let keyOffset = 0; keyOffset < this.apiKeys.length; keyOffset += 1) {
      const keyIndex = (currentKeyIndex + keyOffset) % this.apiKeys.length
      const key = this.apiKeys[keyIndex]
      if (!key) continue

      const candidates = this.getAvailableModelsForKey(key, now)
      if (candidates.length === 0) continue

      if (firstAvailableKeyIndex === null) {
        firstAvailableKeyIndex = keyIndex
      }

      result.push(...candidates)
    }

    if (firstAvailableKeyIndex !== null && firstAvailableKeyIndex !== currentKeyIndex) {
      this.setKeyCursor(firstAvailableKeyIndex, now)
    }

    return result
  }

  markSuccess(candidate: ModelCandidate, now = Date.now()): void {
    this.stateStore.markSuccess(candidate.keyHash, candidate.modelId, now)
    this.setKeyCursor(candidate.keyIndex, now)
    this.setModelCursor(candidate.keyHash, candidate.modelIndex, now)
  }

  markFreeTierExhausted(candidate: ModelCandidate, reason: string, now = Date.now()): void {
    this.stateStore.markFreeTierExhausted(
      candidate.keyHash,
      candidate.modelId,
      now + this.cooldownMs,
      reason,
      now,
    )

    const nextModelIndex = this.findNextAvailableModelIndex(candidate.keyHash, candidate.modelIndex, now)
    if (nextModelIndex !== null) {
      this.setModelCursor(candidate.keyHash, nextModelIndex, now)
      return
    }

    const nextKeyIndex = this.findNextAvailableKeyIndex(candidate.keyIndex, now)
    if (nextKeyIndex !== null) {
      this.setKeyCursor(nextKeyIndex, now)
    }
  }

  availableCount(now = Date.now()): number {
    let count = 0

    for (const key of this.apiKeys) {
      for (const modelId of this.modelIds) {
        const state = this.stateStore.getModelState(key.hash, modelId)
        if (state.cooldownUntil <= now) count += 1
      }
    }

    return count
  }

  totalKeys(): number {
    return this.apiKeys.length
  }

  totalModelsPerKey(): number {
    return this.modelIds.length
  }

  totalSlots(): number {
    return this.apiKeys.length * this.modelIds.length
  }

  snapshot(now = Date.now()): ModelSnapshot[] {
    const currentKeyIndex = this.normalizeKeyIndex(this.getKeyCursor())

    return this.apiKeys.flatMap((key) => {
      const currentModelIndex = this.normalizeModelIndex(this.getModelCursor(key.hash))

      return this.modelIds.map((modelId, modelIndex) => {
        const state = this.stateStore.getModelState(key.hash, modelId)

        return {
          keyHash: key.label,
          keyIndex: key.index,
          currentKey: key.index === currentKeyIndex,
          currentModel: key.index === currentKeyIndex && modelIndex === currentModelIndex,
          id: modelId,
          available: state.cooldownUntil <= now,
          cooldownUntil:
            state.cooldownUntil > now ? new Date(state.cooldownUntil).toISOString() : null,
          failureCount: state.failureCount,
          lastError: state.lastError,
          lastUsedAt: state.lastUsedAt ? new Date(state.lastUsedAt).toISOString() : null,
        }
      })
    })
  }

  private getAvailableModelsForKey(key: ApiKeySlot, now: number): ModelCandidate[] {
    const result: ModelCandidate[] = []
    const currentModelIndex = this.normalizeModelIndex(this.getModelCursor(key.hash))

    for (let modelOffset = 0; modelOffset < this.modelIds.length; modelOffset += 1) {
      const modelIndex = (currentModelIndex + modelOffset) % this.modelIds.length
      const modelId = this.modelIds[modelIndex]
      if (!modelId) continue

      const state = this.stateStore.getModelState(key.hash, modelId)
      if (state.cooldownUntil > now) continue

      result.push({
        apiKey: key.value,
        keyHash: key.hash,
        keyLabel: key.label,
        keyIndex: key.index,
        modelId,
        modelIndex,
      })
    }

    return result
  }

  private findNextAvailableModelIndex(
    keyHash: string,
    afterModelIndex: number,
    now: number,
  ): number | null {
    for (let offset = 1; offset <= this.modelIds.length; offset += 1) {
      const modelIndex = (afterModelIndex + offset) % this.modelIds.length
      const modelId = this.modelIds[modelIndex]
      if (!modelId) continue

      const state = this.stateStore.getModelState(keyHash, modelId)
      if (state.cooldownUntil <= now) return modelIndex
    }

    return null
  }

  private findNextAvailableKeyIndex(afterKeyIndex: number, now: number): number | null {
    for (let offset = 1; offset <= this.apiKeys.length; offset += 1) {
      const keyIndex = (afterKeyIndex + offset) % this.apiKeys.length
      const key = this.apiKeys[keyIndex]
      if (!key) continue

      if (this.getAvailableModelsForKey(key, now).length > 0) return keyIndex
    }

    return null
  }

  private getKeyCursor(): number {
    return this.stateStore.getRuntimeNumber(KEY_CURSOR_NAME, 0)
  }

  private setKeyCursor(keyIndex: number, now: number): void {
    this.stateStore.setRuntimeNumber(KEY_CURSOR_NAME, this.normalizeKeyIndex(keyIndex), now)
  }

  private getModelCursor(keyHash: string): number {
    return this.stateStore.getRuntimeNumber(modelCursorName(keyHash), 0)
  }

  private setModelCursor(keyHash: string, modelIndex: number, now: number): void {
    this.stateStore.setRuntimeNumber(
      modelCursorName(keyHash),
      this.normalizeModelIndex(modelIndex),
      now,
    )
  }

  private normalizeKeyIndex(index: number): number {
    if (this.apiKeys.length === 0) return 0
    return index % this.apiKeys.length
  }

  private normalizeModelIndex(index: number): number {
    if (this.modelIds.length === 0) return 0
    return index % this.modelIds.length
  }
}

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

function modelCursorName(keyHash: string): string {
  return `model_cursor:${keyHash}`
}
