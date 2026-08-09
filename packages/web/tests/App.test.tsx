import { describe, it, expect } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { App } from '../src/App.js'
import { readToken } from '../src/useDraft.js'
import { makeFakeClient } from './helpers/fakeClient.js'

describe('readToken', () => {
  it('reads the capability token from the URL fragment', () => {
    window.location.hash = '#abc123'
    expect(readToken()).toBe('abc123')
    window.location.hash = ''
    expect(readToken()).toBeNull()
  })
})

describe('App', () => {
  it('explains an invalid link instead of hanging', () => {
    const { client } = makeFakeClient({ status: 'rejected', state: null })
    render(<App client={client} />)
    expect(screen.getByText(/link/i)).toBeTruthy()
  })

  it('keeps the last screen visible while reconnecting', () => {
    const { client, push } = makeFakeClient({ state: { phase: { type: 'lobby' } } as any })
    render(<App client={client} />)
    act(() => push({ status: 'reconnecting' }))
    expect(screen.getByText(/reconnecting/i)).toBeTruthy()
    // the draft screen is still mounted underneath, not replaced by a spinner
    expect(screen.queryByText(/joining the draft room/i)).toBeNull()
  })
})
