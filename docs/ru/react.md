[English](../react.md) | **Русский**

[LumiCells](../../README.ru.md) › [Документация](README.md)

# React

`lumicells/react` оборачивает ядро в компонент `<LumiCells>` и несколько хуков. Требуется
React 19 (`ref` передаётся обычным пропом). До публикации в npm установите пакет, как описано в
разделе [Установка](installation.md).

## Пример

```tsx
import type { LumiCellsConfigInput } from 'lumicells';
import { LumiCells, useInfluence } from 'lumicells/react';
import { type ReactNode, useRef } from 'react';
import rawConfig from './lumicells.config.json';

const config = rawConfig as LumiCellsConfigInput;

export function Hero() {
  return (
    <LumiCells config={config} interactive style={{ height: '100vh' }}>
      <Bubble color="#ee2848">Путешествия</Bubble>
    </LumiCells>
  );
}

function Bubble({ color, children }: { color: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  // Бабл подсвечивает пиксели под собой своим цветом и следует за своим положением.
  useInfluence(ref, { type: 'light', color, colorMix: 0.6, strength: 0.8 });
  return <button ref={ref}>{children}</button>;
}
```

Файл `lumicells.config.json` экспортирует стенд, см. [Конфигурационный файл](config.md).

## Пропсы

Кроме пропсов ниже компонент принимает обычные атрибуты `div`. Порядок слияния: дефолты, затем
`preset`, затем `config`. Объект `config` можно создавать на каждом рендере: компонент сравнивает
содержимое, а не ссылку.

| Проп | Смысл |
| --- | --- |
| `preset` | Именованный пресет, основа под `config` (см. [Пресеты](presets-and-modes.md#пресеты)) |
| `config` | Частичный конфиг поверх пресета |
| `transition` | Длительность перехода в мс при изменении конфига; по умолчанию `config.transition` |
| `paused` | Останавливает отрисовку, пока равен `true` |
| `interactive` | Короткая запись для `interaction.pointer` + `interaction.click` |
| `overflow` | Разрешает canvas выходить за границы блока: `true` значит 64 px, число задаёт запас в px, `false` без запаса |
| `priority` | Приоритет в бюджете WebGL-контекстов страницы: `'high'`, `'normal'` (по умолчанию) или `'low'` |
| `renderer` | `'auto'`, `'own'` или `'shared'`; без пропа действует значение для всей страницы (см. [Рендереры](many-instances.md#рендереры)) |
| `look`, `lookOffset` | Одна картинка на карточки, которые рисуют одно и то же (см. [Одинаковые карточки](many-instances.md#одинаковые-карточки)) |
| `fallback` | Показывается поверх статичного постера, когда анимации нет (см. [Проп fallback](#проп-fallback)) |
| `onReady` | Вызывается с экземпляром, когда первый кадр на экране |
| `onError` | Вызывается с ошибкой |
| `onStats` | Вызывается со статистикой кадра примерно 4 раза в секунду |
| `ref` | Экземпляр `LumiCells` (`null` до монтирования) |
| `children` | Рендерятся поверх canvas |

## Хуки

| Хук | Зачем |
| --- | --- |
| `useLumiCells()` | Экземпляр `LumiCells` из ближайшего компонента. `null` только на сервере, до монтирования и после размонтирования. Без WebGL2 экземпляр всё равно отдаётся: проверяйте `instance.supported` или используйте проп `fallback` |
| `useInfluence(ref, opts)` | Превращает элемент в источник света, тени или подъёма пикселей, возвращает ref на его хэндл |
| `useModulator(path, source, opts)` | Ведёт числовой параметр от значения, функции или объекта с `get()` |
| `usePulse()` | Стабильная функция для запуска волны |
| `useLumiCellsStats()` | Статистика кадра, обновляется примерно 4 раза в секунду |
| `useLumiCellsEvent(type, handler)` | Подписка на событие экземпляра |

Что делают влияния, волны и модуляции, описано в разделе [Привязка к окружению](binding.md), типы
событий в разделе [События](events.md).

## Рендеринг на сервере

Компонент рендерится на сервере (SSR) статичным постером, WebGL создаётся только в браузере.
Точка входа `lumicells/react` помечена `'use client'`.

## Проп fallback

Проп `fallback` показывается при причинах fallback `no-webgl2`, `compile` и `load` (не загрузился
чанк движка). При временной потере контекста он тоже показывается и исчезает сразу после
восстановления. Ожидание контекста из бюджета страницы (причина `budget`) его не показывает:
хватает постера. Причины перечислены в разделе [События](events.md).
