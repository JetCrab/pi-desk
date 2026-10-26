'use client'

import { createContext, useContext } from 'react'

export const L4ClientIdContext = createContext<string | null>(null)

export function useL4ClientId(): string {
  const clientId = useContext(L4ClientIdContext)
  if (clientId === null) throw new Error('缺少页面 clientId Provider')
  return clientId
}
