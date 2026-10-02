[English](../events.md) | **Русский**

[LumiCells](../../README.ru.md) › [Документация](README.md)

# События

`cells.on(type, handler)` подписывается на событие экземпляра и возвращает функцию отписки:

```ts
const off = cells.on('stats', (s) => console.log(s.fps, s.gpuMs, s.quality));
off(); // отписаться
```

| Событие | Данные |
| --- | --- |
| `ready` | Первый кадр на экране |
| `frame` | `{ time, dt }` каждый кадр (объект переиспользуется) |
| `stats` | FPS, время CPU и GPU в мс, качество, пиксели, ячейки, подъёмы, влияния (примерно 4 раза в секунду) |
| `resize` | `{ width, height, cols, rows, dpr, scale }` |
| `config` | `{ config, changed, source }`, изменения за кадр приходят одним событием |
| `quality` | `{ scale, quality, reason }`, когда адаптивное качество меняет уровень |
| `warn`, `error` | Предупреждения и ошибки, которые не останавливают работу |
| `fallback` | `{ reason: 'no-webgl2' \| 'compile' \| 'context-lost' \| 'budget' \| 'load' }`: вместо анимации показывается статичный постер (см. [Причины fallback](#причины-fallback)) |
| `renderer` | `{ renderer, previous, reason }` при смене рендерера: `'promote'`, `'demote'`, `'budget'` или `'explicit'` |
| `look` | `{ look, previous, reason, groupSize }`, когда карточка входит в общую картинку или выходит из неё (см. [Одинаковые карточки](many-instances.md#одинаковые-карточки)) |
| `contextlost`, `contextrestored`, `destroy` | Жизненный цикл |

Адаптивное качество, которое стоит за `quality`, описано в разделе
[Производительность](performance.md#разрешение-и-адаптивное-качество), рендереры за `renderer` в
разделе [Рендереры](many-instances.md#рендереры).

## Причины fallback

- `'no-webgl2'`: в браузере нет WebGL2.
- `'compile'`: движок не удалось запустить (например, не собрался шейдер).
- `'context-lost'`: WebGL-контекст потерян; длится до `contextrestored`.
- `'budget'`: видимый экземпляр с `renderer: 'own'` ждёт WebGL-контекст, потому что бюджет
  страницы занят; он начнёт рисовать, как только контекст освободится (см.
  [Много фонов на одной странице](many-instances.md#рендереры)).
- `'load'`: чанк движка не скачался, постер остаётся (у всех экземпляров, до перезагрузки
  страницы).

## В React и Web Component

В React на событие подписывает хук `useLumiCellsEvent(type, handler)`, а `onReady`, `onError` и
`onStats` передаются пропсами ([React](react.md)). Web Component пересылает большинство событий
как DOM-события с префиксом `lc-`, например `lc-ready` и `lc-fallback`; полный список в разделе
[Web Component](web-component.md#события).
