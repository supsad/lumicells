[English](../installation.md) | **Русский**

[LumiCells](../../README.ru.md) › [Документация](README.md)

# Установка

> **npm-пакет скоро будет опубликован.** Пока его нет, соберите пакет из исходников, как показано
> ниже. Пути импорта в этой документации совпадают с будущим пакетом.

## До публикации в npm

```bash
git clone https://github.com/supsad/lumicells.git
cd lumicells
npm ci
npm run build:lib   # dist/lib (ES-модули, IIFE-бандл, schema.json) и dist/types
npm pack            # lumicells-0.1.0.tgz
```

В своём проекте: `npm install ../lumicells/lumicells-0.1.0.tgz`, после этого все импорты в этой
документации работают как написано.

## Страница без сборщика

Скопируйте `dist/lib/lumicells-element.iife.js` рядом со страницей и подключите его обычным
`<script src>`. Этот один файл регистрирует тег `<lumi-cells>` и кладёт API в глобальный
`LumiCells`. Сам тег описан в разделе [Web Component](web-component.md).

## Точки входа

У LumiCells одно ядро и три способа его подключить: из React, как Web Component или из чистого
TypeScript.

| Импорт | Что даёт |
| --- | --- |
| `lumicells` | Ядро: класс `LumiCells`, `onBeforeFrame`, функции для конфига, например `normalizeConfig` и `validateConfig`, и типы ([TypeScript без фреймворков](vanilla.md)) |
| `lumicells/react` | Компонент `<LumiCells>` и хуки ([React](react.md)) |
| `lumicells/element/define` | Регистрирует тег `<lumi-cells>` ([Web Component](web-component.md)) |
| `lumicells/element` | Класс элемента (`LumiCellsElement`) и вспомогательные функции. Импорт не регистрирует тег, поэтому приложение может зарегистрировать его под другим именем через `defineLumiCellsElement(tag)` |
| `lumicells/schema` | Только слой конфига (без DOM и GL): типы, дефолты, пресеты, нормализация |
| `lumicells/schema.json` | JSON Schema конфигурационного файла ([Конфигурационный файл](config.md)) |
| `dist/lib/lumicells-element.iife.js` | Один файл для обычного `<script>` (см. выше) |

## Требования

- **WebGL2** в браузере. Без него показывается статичный CSS-постер в цветах конфига, см.
  [Поддержка браузеров](browser-support.md).
- **Ноль зависимостей в рантайме.** React нужен только `lumicells/react`, как необязательная
  peer-зависимость; ядру и Web Component он не нужен.
- **React 19** для `lumicells/react` (`ref` передаётся обычным пропом).
- **Безопасно для SSR**: импорт не трогает `window`, до создания экземпляра ничего не происходит,
  а React-компонент на сервере рендерится статичным постером.
