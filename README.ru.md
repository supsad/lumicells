[English](README.md) | **Русский**

<h1 align="center">LumiCells</h1>

<p align="center">
  <b>Живой фон из неоновых пикселей для веба.</b><br />
  WebGL2 · 8 смешиваемых режимов анимации · реагирует на страницу · ноль зависимостей в рантайме
</p>

<p align="center">
  <a href="https://supsad.github.io/lumicells/"><img alt="Живое демо" src="https://img.shields.io/badge/live%20demo-open%20the%20playground-e0267a?style=flat-square" /></a>
  <img alt="WebGL2" src="https://img.shields.io/badge/WebGL2-shaders-0476ff?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-typed%20API-3178c6?style=flat-square" />
  <img alt="Ноль зависимостей" src="https://img.shields.io/badge/runtime%20deps-0-19e6d0?style=flat-square" />
  <a href="LICENSE"><img alt="Лицензия MIT" src="https://img.shields.io/badge/license-MIT-8a5cf6?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://supsad.github.io/lumicells/">
    <img src="docs/media/hero.webp" width="960" alt="Демо-сцена LumiCells: сетка светящихся ячеек складывается во вращающуюся сферу за плавающими баблами, клики пускают волны, баблы улетают и возвращаются" />
  </a>
</p>

LumiCells рисует анимированный фон для сайтов шейдерами WebGL2: неоновую пиксельную сетку,
светящиеся ячейки которой складываются в кольца, сферы, волны, спирали, дождь или «жизнь» Конвея.
Фон реагирует на страницу вокруг: кнопки подсвечивают сетку своим цветом, клики пускают волны,
наведение поднимает пиксели. Подключается как React-компонент, как Web Component `<lumi-cells>`
или из чистого TypeScript.

**[Живое демо](https://supsad.github.io/lumicells/)**: стенд, где можно переключать пресеты, крутить
любой параметр на лету и экспортировать конфиг. Рядом опубликованы два примера на чистом HTML:
[Web Component](https://supsad.github.io/lumicells/examples/web-component.html) и
[ядро без фреймворков](https://supsad.github.io/lumicells/examples/core-basic.html).

## Возможности

- **8 режимов анимации**: смешиваются как слои с весами и плавно перетекают при смене, плюс
  9 пресетов для старта.
- **Аккуратное свечение в три слоя** и **всплывающие пиксели**, способные вылетать за canvas.
- **Любая палитра**: от 1 до 32 цветов, смешение в OKLab, линейно или ступенями, 5 способов
  раскладки цвета.
- **Плавные переходы**: любое изменение анимируется, включая смену пресета.
- **Привязка к странице**: влияния элементов (свет, тень, подъём, посев, отталкивание), волны,
  подъёмы пикселей и модуляции, которые ведут любой числовой параметр от ваших данных.
- **60+ FPS**: процедурная математика в разрешении сетки, адаптивное качество, бюджет пикселей.
- **Много фонов на странице**: общий бюджет WebGL-контекстов, ленивое создание и парковка.
- **Лёгкая первая загрузка**: сразу около 16 КБ gzip, движок догружается, пока виден постер.
- **Безопасен для SSR** и **TypeScript в первую очередь**: типизированный конфиг и пути параметров.
- **JSON-конфиг с JSON Schema** для подсказок в редакторе.
- **Ноль зависимостей в рантайме** (React нужен только `lumicells/react`, как необязательная
  peer-зависимость).

## Установка

> **npm-пакет скоро будет опубликован.** Пока его нет, соберите пакет из исходников:

```bash
git clone https://github.com/supsad/lumicells.git
cd lumicells
npm ci
npm run build:lib   # dist/lib (ES-модули, IIFE-бандл, schema.json) и dist/types
npm pack            # lumicells-0.1.0.tgz
```

В своём проекте: `npm install ../lumicells/lumicells-0.1.0.tgz`, после этого импорты ниже
работают как написано. Для страницы без сборщика подключите `dist/lib/lumicells-element.iife.js`
через `<script src>`. Подробнее в разделе [Установка](docs/ru/installation.md).

## Быстрый старт

### React

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

Файл `lumicells.config.json` экспортирует стенд ([Конфигурационный файл](docs/ru/config.md)).
Пропсы, хуки, рендеринг на сервере и fallback: [React](docs/ru/react.md).

### Web Component

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

Атрибуты, привязка через `data-lc-*` и DOM-события: [Web Component](docs/ru/web-component.md).

### TypeScript без фреймворков

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

Опции и методы: [TypeScript без фреймворков](docs/ru/vanilla.md).

## Документация

[Оглавление документации](docs/ru/README.md) со списком всех страниц:

- [Установка](docs/ru/installation.md): сборка до публикации в npm, точки входа.
- [React](docs/ru/react.md): компонент, пропсы, хуки, SSR.
- [Web Component](docs/ru/web-component.md): тег `<lumi-cells>` и привязка через `data-lc-*`.
- [TypeScript без фреймворков](docs/ru/vanilla.md): класс `LumiCells`, его опции и методы.
- [Конфигурационный файл](docs/ru/config.md): `lumicells.config.json`, JSON Schema, валидация.
- [Пресеты и режимы анимации](docs/ru/presets-and-modes.md): пресеты, режимы, свечение, палитра.
- [Привязка к окружению](docs/ru/binding.md): влияния, волны, подъёмы, модуляции.
- [События](docs/ru/events.md): события экземпляра и их данные.
- [Стенд](docs/ru/playground.md): панель настроек, горячие клавиши, примеры.
- [Производительность](docs/ru/performance.md): цена кадра, запуск, адаптивное качество, бандл.
- [Много фонов на одной странице](docs/ru/many-instances.md): рендереры, бюджет контекстов,
  снижение стоимости.
- [Поддержка браузеров](docs/ru/browser-support.md): что где проверено, чем браузеры отличаются.
- [Как устроено](docs/ru/architecture.md): структура исходников, как добавить параметр или режим.
- [Разработка](docs/ru/development.md): скрипты, сквозные тесты, страницы для разработки.

## Поддержка браузеров

Нужен WebGL2: актуальные Chrome, Edge и Firefox, а также Safari 15 и новее. Без WebGL2
показывается статичный CSS-постер в цветах конфига. Тесты идут в сборках Chromium, Firefox и
WebKit из Playwright; на Safari, iOS и Android пока ничего не замерялось. Подробнее в разделе
[Поддержка браузеров](docs/ru/browser-support.md).

## Планы

- [ ] Опубликовать `lumicells` в npm.
- [ ] Замерить производительность на реальных мобильных GPU и опубликовать цифры.

## Лицензия

[MIT](LICENSE).
