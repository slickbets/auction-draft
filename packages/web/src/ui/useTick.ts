import { useEffect, useRef, useState } from 'react'

export interface TickResult {
  /** The change since the last distinct value; clears back to null 900ms after
   *  the change, matching the `delta-rise` keyframe's duration. */
  delta: number | null
  /** Changes on every distinct value the number takes on, so the caller can key
   *  the price readout by it and force a remount that replays `tick-roll`. */
  key: number
}

/** Tracks the change in `value` since the last distinct value seen. Used by the
 *  block card's price readout: the delta drives the rising "+$N" and the key
 *  drives the number's roll animation. */
export function useTick(value: number): TickResult {
  const prev = useRef(value)
  const [delta, setDelta] = useState<number | null>(null)
  const [key, setKey] = useState(0)

  useEffect(() => {
    if (value === prev.current) return
    const change = value - prev.current
    prev.current = value
    setDelta(change)
    setKey(k => k + 1)
    const timer = setTimeout(() => setDelta(null), 900)
    return () => clearTimeout(timer)
  }, [value])

  return { delta, key }
}
