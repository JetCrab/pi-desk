'use client'

import { createContext, useContext } from 'react'
import type { L4AppSocketClient } from './l4-app-socket'

export interface L4AppSocketContextValue {
  clientId: string
  appSocket: L4AppSocketClient
}

export const L4AppSocketContext = createContext<L4AppSocketContextValue | null>(null)

export function useL4AppSocket(): L4AppSocketContextValue {
  const value = useContext(L4AppSocketContext)
  if (!value) throw new Error('AppSocket Provider is missing')
  return value
}
