'use client'

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'pi-desk:power-saving'
const CHANGE_EVENT = 'pi-desk:power-saving-change'
let memoryValue: boolean | null = null

function readPowerSaving(): boolean {
  if (memoryValue !== null) return memoryValue
  try {
    memoryValue = window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    memoryValue = false
  }
  return memoryValue
}

function subscribePowerSaving(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    memoryValue = null
    listener()
  }
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}

export function useL4PowerSaving(): boolean {
  return useSyncExternalStore(subscribePowerSaving, readPowerSaving, () => false)
}

export function saveL4PowerSaving(enabled: boolean): void {
  memoryValue = enabled
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch (error) {
    console.warn('[Pi Desk][Appearance] 省电模式保存失败，仅当前页面生效', error)
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}
