import { describe, it, expect } from 'vitest'
import { ENGINE_VERSION } from '../src/index.js'

describe('engine package', () => {
  it('exports a version marker', () => {
    expect(ENGINE_VERSION).toBe(1)
  })
})
