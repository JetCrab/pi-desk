'use client'

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleOffIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  L2ModelOption,
  L2ModelPreset
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { L4SearchSelect } from '@client/l4_foundation/ui/l4-search-select'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L2_MODEL_PRESET_COLORS, pickL2ModelPresetColor } from '../l2-model-preset-colors'
import { Field, FixedSelect } from './l2-model-settings-form'

const THINKING_LABELS = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
} as const

interface Props {
  presets: L2ModelPreset[]
  models: L2ModelOption[]
  onChange: (presets: L2ModelPreset[]) => void
}

function modelKey(provider: string, modelId: string): string {
  return JSON.stringify([provider, modelId])
}

function presetKey(preset: L2ModelPreset, index: number): string {
  return JSON.stringify([preset.provider, preset.modelId, preset.thinkingLevel, index])
}

function modelOptions(models: L2ModelOption[]): Array<{
  value: string
  label: string
  description: string
}> {
  return models.map((model) => ({
    value: modelKey(model.provider, model.modelId),
    label: model.name || model.modelId,
    description: model.provider
  }))
}

function thinkingOptions(
  model: L2ModelOption | undefined,
  t: TFunction<'settings'>
): Array<{ value: string; label: string }> {
  return (model?.thinkingLevels ?? []).map((level) => ({
    value: level,
    label: t(THINKING_LABELS[level])
  }))
}

function SortablePreset({
  id,
  preset,
  model,
  models,
  canMoveUp,
  canMoveDown,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown
}: {
  id: string
  preset: L2ModelPreset
  model: L2ModelOption | undefined
  models: L2ModelOption[]
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (preset: L2ModelPreset) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id })
  const transformStyle = transform
    ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX ?? 1}) scaleY(${transform.scaleY ?? 1})`
    : undefined
  const colorValue = preset.color?.toLowerCase() ?? 'none'
  const knownColor = L2_MODEL_PRESET_COLORS.find((color) => color.value === colorValue)
  const colorLabel = knownColor
    ? t(knownColor.label)
    : t(preset.color ? 'presetColorCustom' : 'presetColorNone')
  const colorOptions = [
    { value: 'none', color: null, label: t('presetColorNone') },
    ...(preset.color && !knownColor
      ? [{ value: colorValue, color: preset.color, label: t('presetColorCustom') }]
      : []),
    ...L2_MODEL_PRESET_COLORS.map((color) => ({
      value: color.value,
      color: color.value,
      label: t(color.label)
    }))
  ]

  return (
    <div
      ref={setNodeRef}
      style={{ transform: transformStyle, transition }}
      className={cn(
        'grid min-w-0 items-center gap-3 border-b bg-card py-3 @[48rem]/presets:grid-cols-[auto_minmax(0,1fr)_7.5rem_4rem_auto]',
        isDragging && 'z-10 opacity-70 shadow-lg'
      )}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          ref={setActivatorNodeRef}
          type="button"
          title={t('presetDrag')}
          aria-label={t('presetDrag')}
          className="touch-none cursor-grab text-muted-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-4" />
        </Button>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t('presetMoveUp')}
            aria-label={t('presetMoveUp')}
            disabled={!canMoveUp}
            onClick={onMoveUp}
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            title={t('presetMoveDown')}
            aria-label={t('presetMoveDown')}
            disabled={!canMoveDown}
            onClick={onMoveDown}
          >
            <ChevronDownIcon className="size-4" />
          </Button>
        </div>
      </div>
      <Field label={t('modelsHeading')}>
        <L4SearchSelect
          value={modelKey(preset.provider, preset.modelId)}
          options={modelOptions(models)}
          ariaLabel={t('presetModel')}
          searchPlaceholder={t('modelSearch')}
          onChange={(value) => {
            const next = models.find((item) => modelKey(item.provider, item.modelId) === value)
            if (!next) return
            onChange({
              ...preset,
              provider: next.provider,
              modelId: next.modelId,
              thinkingLevel: next.thinkingLevels.includes(preset.thinkingLevel)
                ? preset.thinkingLevel
                : next.thinkingLevels[0]
            })
          }}
        />
      </Field>
      <Field label={t('thinkingLevel')}>
        <FixedSelect
          value={preset.thinkingLevel}
          options={thinkingOptions(model, t)}
          ariaLabel={t('presetThinking')}
          allowEmpty={false}
          onChange={(value) =>
            onChange({ ...preset, thinkingLevel: value as L2ModelPreset['thinkingLevel'] })
          }
        />
      </Field>
      <Field label={t('presetColor')}>
        <Select
          value={colorValue}
          onValueChange={(value) => {
            if (value !== null) onChange({ ...preset, color: value === 'none' ? null : value })
          }}
        >
          <SelectTrigger aria-label={t('presetColorLabel')} className="w-16">
            <SelectValue>
              {preset.color ? (
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full"
                  style={{ backgroundColor: preset.color }}
                />
              ) : (
                <CircleOffIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              )}
              <span className="sr-only">{colorLabel}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            positionerClassName="z-[120]"
            className="w-40 min-w-40"
            align="end"
            alignItemWithTrigger={false}
          >
            <SelectGroup className="grid grid-cols-4 gap-1 p-2">
              {colorOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  aria-label={option.label}
                  className="size-8 justify-center p-0 data-selected:bg-accent data-selected:ring-1 data-selected:ring-ring data-selected:ring-inset [&>span:first-child]:justify-center [&>span:last-child]:hidden"
                >
                  {option.color ? (
                    <span
                      aria-hidden="true"
                      className="size-4 shrink-0 self-center rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                  ) : (
                    <CircleOffIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={t('presetDelete')}
        aria-label={t('presetDelete')}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </div>
  )
}

export function L2ModelPresetSettings({ presets, models, onChange }: Props): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [newModelKey, setNewModelKey] = useState(() =>
    models[0] ? modelKey(models[0].provider, models[0].modelId) : ''
  )
  const selectedNewModel = models.find(
    (model) => modelKey(model.provider, model.modelId) === newModelKey
  )
  const [newThinkingLevel, setNewThinkingLevel] = useState<L2ModelPreset['thinkingLevel']>(
    selectedNewModel?.thinkingLevels[0] ?? 'off'
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const ids = useMemo(() => presets.map(presetKey), [presets])

  function addPreset(): void {
    const model = models.find((item) => modelKey(item.provider, item.modelId) === newModelKey)
    if (!model) return
    const thinkingLevel = model.thinkingLevels.includes(newThinkingLevel)
      ? newThinkingLevel
      : model.thinkingLevels[0]
    if (
      presets.some(
        (preset) =>
          preset.provider === model.provider &&
          preset.modelId === model.modelId &&
          preset.thinkingLevel === thinkingLevel
      )
    ) {
      return
    }
    onChange([
      ...presets,
      {
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel,
        color: pickL2ModelPresetColor(presets)
      }
    ])
  }

  function handleDragEnd(event: DragEndEvent): void {
    if (!event.over || event.active.id === event.over.id) return
    const from = ids.indexOf(String(event.active.id))
    const to = ids.indexOf(String(event.over.id))
    if (from >= 0 && to >= 0) onChange(arrayMove(presets, from, to))
  }

  return (
    <div className="@container/presets space-y-4 p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">{t('presetDescription')}</p>

      <div className="grid gap-3 border-b pb-4 @[32rem]/presets:grid-cols-[minmax(0,1fr)_7.5rem_auto]">
        <Field label={t('modelsHeading')}>
          <L4SearchSelect
            value={newModelKey}
            options={modelOptions(models)}
            ariaLabel={t('presetModelNew')}
            searchPlaceholder={t('modelSearch')}
            disabled={models.length === 0}
            onChange={(value) => {
              setNewModelKey(value)
              const model = models.find((item) => modelKey(item.provider, item.modelId) === value)
              if (model) setNewThinkingLevel(model.thinkingLevels[0])
            }}
          />
        </Field>
        <Field label={t('thinkingLevel')}>
          <FixedSelect
            value={newThinkingLevel}
            options={thinkingOptions(selectedNewModel, t)}
            ariaLabel={t('presetThinkingNew')}
            allowEmpty={false}
            onChange={(value) => setNewThinkingLevel(value as L2ModelPreset['thinkingLevel'])}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          className="self-end justify-self-start"
          onClick={addPreset}
          disabled={!selectedNewModel}
        >
          <PlusIcon /> {t('presetAdd')}
        </Button>
      </div>

      {presets.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('presetEmpty')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {presets.map((preset, index) => {
                const model = models.find(
                  (item) => item.provider === preset.provider && item.modelId === preset.modelId
                )
                return (
                  <SortablePreset
                    key={ids[index]}
                    id={ids[index]}
                    preset={preset}
                    model={model}
                    models={models}
                    canMoveUp={index > 0}
                    canMoveDown={index < presets.length - 1}
                    onChange={(nextPreset) =>
                      onChange(
                        presets.map((item, presetIndex) =>
                          presetIndex === index ? nextPreset : item
                        )
                      )
                    }
                    onDelete={() =>
                      onChange(presets.filter((_, presetIndex) => presetIndex !== index))
                    }
                    onMoveUp={() => onChange(arrayMove(presets, index, index - 1))}
                    onMoveDown={() => onChange(arrayMove(presets, index, index + 1))}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
