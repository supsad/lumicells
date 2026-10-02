[English](../vanilla.md) | **Русский**

[LumiCells](../../README.ru.md) › [Документация](README.md)

# TypeScript без фреймворков

Основной пакет `lumicells` экспортирует класс `LumiCells`. Фреймворк ему не нужен: на нём
построены [React-компонент](react.md) и [Web Component](web-component.md). До публикации в npm
установите пакет, как описано в разделе [Установка](installation.md).

## Пример

```ts
import { LumiCells } from 'lumicells';

const cells = new LumiCells(document.querySelector<HTMLElement>('#hero')!, { preset: 'reference' });

const bubble = document.querySelector('#bubble')!;
cells.bindElement(bubble, { type: 'light', color: '#ee2848', colorMix: 0.6 });
bubble.addEventListener('click', (e) => {
  const { clientX, clientY } = e as MouseEvent;
  cells.pulse({ x: clientX, y: clientY, space: 'client' });
});

// Плавно поменять параметр за 800 мс.
cells.set('modes.sphere.radius', 0.5, { transition: 800 });

// Освободить WebGL-контекст.
cells.destroy();
```

## Опции конструктора

`new LumiCells(host, options)` рисует фон в элементе `host`.

| Опция | Смысл |
| --- | --- |
| `preset` | Именованный пресет, основа под `config` (см. [Пресеты](presets-and-modes.md#пресеты)) |
| `config` | Частичный конфиг поверх пресета (или дефолтов) |
| `interactive` | Короткая запись для `interaction.pointer` + `interaction.click` |
| `autoStart` | Запустить сразу (по умолчанию `true`). Сам WebGL-контекст создаётся лениво (см. [Ленивое создание и парковка](many-instances.md#ленивое-создание-и-парковка)) |
| `priority` | Приоритет в бюджете контекстов страницы: `'high'`, `'normal'` (по умолчанию) или `'low'` |
| `renderer` | `'auto'`, `'own'` или `'shared'`; без опции действует значение для всей страницы (`'auto'`, если его не изменили через [`LumiCells.configure()`](many-instances.md#настройки-на-всю-страницу)), см. [Рендереры](many-instances.md#рендереры) |
| `look`, `lookOffset` | Одна картинка на карточки, которые рисуют одно и то же (см. [Одинаковые карточки](many-instances.md#одинаковые-карточки)) |

## Изменение конфига

Любое изменение анимируется плавно, включая смену пресета. Конфиг типизирован, как и пути
параметров у `set()` и `modulate()`.

| Метод | Что делает |
| --- | --- |
| `set(path, value, opts)` | Меняет один параметр по пути через точку, например `'modes.sphere.radius'` |
| `setConfig(patch, opts)` | Сливает частичный конфиг с текущим |
| `replaceConfig(config, opts)` | Заменяет весь конфиг; недостающие ключи берутся из дефолтов или `extends` |
| `get(path)`, `getConfig()` | Текущее значение пути в конфиге или весь конфиг |
| `getEffective(path)` | Текущее значение числового параметра с учётом переходов и модуляций |
| `exportConfig({ mode, base })` | Конфиг в виде объекта конфигурационного файла: `mode` равен `'full'` или `'diff'`, `base` равен `'defaults'` или пресету |

`opts.transition` задаёт длительность перехода в мс; по умолчанию берётся `config.transition`, а
`0` применяет изменение сразу. Формат файла описан в разделе [Конфигурационный файл](config.md).

## Другие методы

| Метод | Что делает | Подробнее |
| --- | --- | --- |
| `bindElement(el, opts)`, `addInfluence(opts)` | Области света, тени, подъёма, посева или отталкивания | [Привязка к окружению](binding.md#влияния) |
| `pulse(opts)`, `lift(opts)` | Разовая волна, подъём пикселей | [Привязка к окружению](binding.md#волны-и-подъёмы) |
| `modulate(path, source, opts)`, `setEnergy(value)` | Ведут числовой параметр от ваших данных | [Привязка к окружению](binding.md#модуляции) |
| `on(type, handler)` | Подписка на событие, возвращает функцию отписки | [События](events.md) |
| `getStats()` | Статистика кадра, рендерер, состояние, снижение стоимости | [События](events.md), [Много фонов на одной странице](many-instances.md) |
| `setRenderer(mode)`, `setPriority(priority)`, `setLook(look, offset)` | Переключают работающий экземпляр | [Много фонов на одной странице](many-instances.md) |
| `setDebugView(view)` | Показывает отладочный слой: `'field'`, `'halo'`, `'bloom'`, `'haze'` или `'cells'`; `'final'` возвращает обычную картинку | |
| `start()`, `stop()` | Запускают или останавливают отрисовку; после `stop()` остаётся последний кадр | |
| `destroy()` | Освобождает WebGL-контекст | |
| `loseContextForTesting()` | Имитирует потерю контекста и его восстановление браузером примерно через 0.5 с, чтобы проверить восстановление. У общего экземпляра теряется общий контекст, поэтому это задевает все общие экземпляры | |

Свойства только для чтения: `host`, `canvas`, `supported`, `destroyed`, `renderer`,
`rendererMode`, `priority`, `look`, `lookOffset`.

Статические члены:

- `LumiCells.configure(options)`: настройки на всю страницу (см.
  [Настройки на всю страницу](many-instances.md#настройки-на-всю-страницу)).
- `LumiCells.preload()`: заранее начинает загрузку чанка движка (см.
  [Размер бандла](performance.md#размер-бандла)).
- `LumiCells.isSupported()`: есть ли WebGL2.

`onBeforeFrame(callback)` из `lumicells` вызывает функцию в начале каждого кадра, до того как
экземпляры читают DOM: там стоит анимировать элементы, привязанные к фону (см.
[Режимы слежения](binding.md#режимы-слежения)).
