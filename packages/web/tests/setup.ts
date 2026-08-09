import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Auto-cleanup only registers itself when vitest runs with `globals: true`. Without
// this, every render accumulates in document.body and later queries match elements
// left behind by earlier tests.
afterEach(cleanup)
