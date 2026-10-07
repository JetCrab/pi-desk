import { useEffect, useRef, useState } from 'react'
import type {
  L2ModelConfig,
  L2ModelProviderConfig
} from '@common/l2_biz/model-settings/l2-model-settings-contract'

export interface ModelInputState {
  dirty: boolean
  invalid: boolean
}
interface ModelSelection {
  providerIndex: number
  modelIndex: number
}

export function emptyL2ModelProvider(): L2ModelProviderConfig {
  return {
    provider: '',
    name: null,
    baseUrl: null,
    api: 'openai-responses',
    apiKey: null,
    authHeader: null,
    headers: {},
    models: []
  }
}

function emptyModel(): L2ModelConfig {
  return {
    modelId: '',
    name: '',
    api: null,
    baseUrl: null,
    reasoning: false,
    thinkingLevels: [{ level: 'off', providerValue: null }],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: null,
    headers: {},
    compat: null
  }
}

export function useL2ModelProviderSettings(
  providers: L2ModelProviderConfig[],
  onChange: (providers: L2ModelProviderConfig[]) => void,
  onInputState: (state: ModelInputState) => void,
  resetVersion: number
): {
  selection: ModelSelection | null
  mobileDetail: boolean
  query: string
  setQuery: (query: string) => void
  modelKeys: string[][]
  serviceIndex: number | null
  newService: boolean
  openService: (index: number | null) => void
  closeService: () => void
  applyService: (provider: L2ModelProviderConfig) => void
  deleteService: () => void
  addModel: (providerIndex: number) => void
  selectModel: (providerIndex: number, modelIndex: number) => void
  backToList: () => void
  updateModel: (providerIndex: number, modelIndex: number, model: L2ModelConfig) => void
  deleteModel: (providerIndex: number, modelIndex: number) => void
  updateInputState: (key: string, state: ModelInputState) => void
} {
  const [selection, setSelection] = useState<ModelSelection | null>(() => {
    const providerIndex = providers.findIndex((provider) => provider.models.length > 0)
    return providerIndex < 0 ? null : { providerIndex, modelIndex: 0 }
  })
  const [mobileDetail, setMobileDetail] = useState(false)
  const [query, setQuery] = useState('')
  const [modelKeys, setModelKeys] = useState(() =>
    providers.map((provider, providerIndex) =>
      provider.models.map((_, modelIndex) => `${providerIndex}:${modelIndex}`)
    )
  )
  const nextKey = useRef(0)
  const [inputStates, setInputStates] = useState<Record<string, ModelInputState>>({})
  const [serviceIndex, setServiceIndex] = useState<number | null>(null)
  const [newService, setNewService] = useState(false)
  const latestProviders = useRef(providers)

  useEffect(() => {
    latestProviders.current = providers
  }, [providers])

  useEffect(() => {
    queueMicrotask(() => {
      const current = latestProviders.current
      setInputStates({})
      setModelKeys(
        current.map((provider, providerIndex) =>
          provider.models.map((_, modelIndex) => `${providerIndex}:${modelIndex}`)
        )
      )
      setSelection((selection) => {
        if (selection && current[selection.providerIndex]?.models[selection.modelIndex])
          return selection
        const providerIndex = current.findIndex((provider) => provider.models.length)
        return providerIndex < 0 ? null : { providerIndex, modelIndex: 0 }
      })
    })
  }, [resetVersion])

  useEffect(() => {
    const states = Object.values(inputStates)
    onInputState({
      dirty: states.some((state) => state.dirty),
      invalid: states.some((state) => state.invalid)
    })
  }, [inputStates, onInputState])

  function removeInputKeys(keys: string[]): void {
    setInputStates((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key)))
    )
  }

  function updateModel(providerIndex: number, modelIndex: number, model: L2ModelConfig): void {
    onChange(
      providers.map((provider, index) =>
        index === providerIndex
          ? {
              ...provider,
              models: provider.models.map((current, index) =>
                index === modelIndex ? model : current
              )
            }
          : provider
      )
    )
  }

  function closeService(): void {
    setServiceIndex(null)
    setNewService(false)
  }

  return {
    selection,
    mobileDetail,
    query,
    setQuery,
    modelKeys,
    serviceIndex,
    newService,
    openService: (index) => {
      setServiceIndex(index)
      setNewService(index === null)
    },
    closeService,
    applyService: (provider) => {
      if (newService) {
        onChange([...providers, provider])
        setModelKeys((keys) => [...keys, []])
      } else {
        onChange(providers.map((current, index) => (index === serviceIndex ? provider : current)))
      }
      closeService()
    },
    deleteService: () => {
      if (serviceIndex === null) return
      removeInputKeys(modelKeys[serviceIndex])
      const nextProviders = providers.filter((_, index) => index !== serviceIndex)
      onChange(nextProviders)
      setModelKeys((keys) => keys.filter((_, index) => index !== serviceIndex))
      setSelection((current) => {
        if (!current || current.providerIndex === serviceIndex) {
          const providerIndex = nextProviders.findIndex((provider) => provider.models.length)
          return providerIndex < 0 ? null : { providerIndex, modelIndex: 0 }
        }
        return current.providerIndex > serviceIndex
          ? { ...current, providerIndex: current.providerIndex - 1 }
          : current
      })
      setMobileDetail(false)
      closeService()
    },
    addModel: (providerIndex) => {
      const provider = providers[providerIndex]
      onChange(
        providers.map((current, index) =>
          index === providerIndex
            ? { ...current, models: [...current.models, emptyModel()] }
            : current
        )
      )
      const key = `new-${++nextKey.current}`
      setModelKeys((keys) =>
        keys.map((current, index) => (index === providerIndex ? [...current, key] : current))
      )
      setSelection({ providerIndex, modelIndex: provider.models.length })
      setQuery('')
      setMobileDetail(true)
    },
    selectModel: (providerIndex, modelIndex) => {
      setSelection({ providerIndex, modelIndex })
      setMobileDetail(true)
    },
    backToList: () => {
      setMobileDetail(false)
      setQuery('')
    },
    updateModel,
    deleteModel: (providerIndex, modelIndex) => {
      removeInputKeys([modelKeys[providerIndex][modelIndex]])
      const nextProviders = providers.map((provider, index) =>
        index === providerIndex
          ? { ...provider, models: provider.models.filter((_, index) => index !== modelIndex) }
          : provider
      )
      onChange(nextProviders)
      setModelKeys((keys) =>
        keys.map((current, index) =>
          index === providerIndex ? current.filter((_, index) => index !== modelIndex) : current
        )
      )
      setSelection((current) => {
        if (!current || current.providerIndex !== providerIndex) return current
        if (current.modelIndex === modelIndex) {
          if (nextProviders[providerIndex].models.length)
            return {
              providerIndex,
              modelIndex: Math.min(modelIndex, nextProviders[providerIndex].models.length - 1)
            }
          const nextProviderIndex = nextProviders.findIndex((provider) => provider.models.length)
          return nextProviderIndex < 0 ? null : { providerIndex: nextProviderIndex, modelIndex: 0 }
        }
        return current.modelIndex > modelIndex
          ? { ...current, modelIndex: current.modelIndex - 1 }
          : current
      })
      setMobileDetail(false)
    },
    updateInputState: (key, state) => setInputStates((current) => ({ ...current, [key]: state }))
  }
}
