[English](../web-component.md) | **Русский**

[LumiCells](../../README.ru.md) › [Документация](README.md)

# Web Component

Тег `<lumi-cells>` работает с любым стеком, в том числе с чистым HTML. До публикации в npm
установите пакет, как описано в разделе [Установка](installation.md).

## Пример

```html
<script type="module">
  import 'lumicells/element/define';
</script>

<lumi-cells id="bg" preset="reference" interactive style="height: 100vh">
  <button data-lc-influence data-lc-color="#0481f5" data-lc-pulse="click" data-lc-lift="hover">
    Наука
  </button>
</lumi-cells>

<script type="module">
  // Конфиг задаётся свойством или загружается из файла через атрибут src.
  document.getElementById('bg').config = { modes: { sphere: { radius: 0.7 } } };
</script>
```

Без сборщика подключается одним файлом `dist/lib/lumicells-element.iife.js` через обычный
`<script>`: он регистрирует тег и кладёт API в глобальный `LumiCells`.

`lumicells/element/define` регистрирует тег. `lumicells/element` экспортирует класс элемента без
регистрации (см. [Точки входа](installation.md#точки-входа)).

## Атрибуты и свойства

Атрибуты: `preset`, `src` (URL файла конфига), `interactive`, `overflow`, `paused`, `transition`,
`priority`, `renderer`, `look`, `look-offset`. Свойства: `config`, `preset`, `src`, `paused`,
`interactive`, `overflow`, `transition`, `priority`, `renderer`, `look`, `lookOffset` и
`instance` (только чтение).

Файл конфига, на который указывает `src`, описан в разделе [Конфигурационный файл](config.md). Про
`renderer`, `priority`, `look` и `look-offset` см. [Много фонов на одной странице](many-instances.md).
Без атрибута `renderer` действует значение для всей страницы; `priority` по умолчанию `normal`,
`look` по умолчанию `own`, `look-offset` по умолчанию 0.

## Декларативная привязка дочерних элементов

| Атрибут | Значение |
| --- | --- |
| `data-lc-influence` | Элемент влияет на фон. Значение (или `data-lc-type`) задаёт тип: `light` (по умолчанию), `shadow`, `lift`, `seed`, `repel` |
| `data-lc-color`, `data-lc-color-mix` | Цвет подсветки и доля его смешения с палитрой |
| `data-lc-strength`, `data-lc-falloff`, `data-lc-padding`, `data-lc-priority` | Сила, мягкость края в клетках, отступ в px, приоритет |
| `data-lc-track` | `auto` или `frame`: как часто перечитывать положение |
| `data-lc-pulse` | `click` или `hover`: волна от элемента |
| `data-lc-lift` | `hover` или `click`: подъём пикселей у элемента |
| `data-lc-for="bg"` | Привязать элемент вне тега (например, из портала) к `<lumi-cells id="bg">` |

Эти атрибуты соответствуют влияниям, волнам и подъёмам из раздела
[Привязка к окружению](binding.md).

## События

Элемент пересылает события экземпляра как DOM-события: `lc-ready`, `lc-config`, `lc-stats`,
`lc-error`, `lc-fallback`, `lc-contextlost`, `lc-contextrestored` (конец fallback с причиной
`context-lost`: анимация вернулась), `lc-renderer` (смена рендерера) и `lc-look`. Их данные
описаны в разделе [События](events.md).
