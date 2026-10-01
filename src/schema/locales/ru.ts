/**
 * Russian texts of the config schema. English is the primary language and lives in the UI
 * metadata table (meta.ts); this table mirrors it by dotted path and is kept complete and free of
 * stale keys by tests/schema-locale.test.ts.
 */

import type { SchemaLocaleTexts } from '../locale';

export const ru: SchemaLocaleTexts = {
  groups: {
    grid: { label: 'Сетка', description: 'Размер и форма ячеек пиксельной сетки.' },
    scene: {
      label: 'Композиция',
      description: 'Положение и масштаб всей картины внутри контейнера.',
    },
    animation: {
      label: 'Анимация',
      description: 'Общая скорость, смешивание режимов и живость ячеек.',
    },
    'animation.flicker': {
      label: 'Мерцание',
      description: 'Медленное случайное дыхание яркости каждой ячейки.',
    },
    'animation.sparkle': {
      label: 'Искры',
      description: 'Редкие короткие вспышки отдельных ячеек.',
    },
    'animation.sparsity': {
      label: 'Разреженность',
      description: 'На окраинах ячейки гаснут целиком, а не тускнеют.',
    },
    modes: {
      label: 'Режимы анимации',
      description: 'Слои поля яркости; можно смешивать несколько режимов одновременно.',
    },
    'modes.flow': { label: 'Поток', description: 'Плавно текущий шумовой узор.' },
    'modes.sphere': {
      label: 'Сфера',
      description: 'Светящийся полый шар с кольцом и мягким угасанием.',
    },
    'modes.pulse': { label: 'Пульсация', description: 'Концентрические кольца от центра.' },
    'modes.wave': { label: 'Волны', description: 'Бегущие плоские волны с интерференцией.' },
    'modes.ripple': { label: 'Капли', description: 'Случайные круги, как от капель на воде.' },
    'modes.vortex': { label: 'Вихрь', description: 'Закрученные спиральные рукава.' },
    'modes.life': { label: 'Жизнь', description: 'Клеточный автомат в духе «Жизни» Конвея.' },
    'modes.rain': { label: 'Дождь', description: 'Падающие светящиеся капли со шлейфом.' },
    color: { label: 'Цвет', description: 'Палитра и то, как она ложится на сетку.' },
    'color.hot': {
      label: 'Раскал',
      description: 'Самые яркие ячейки светлеют в оттенке своего цвета.',
    },
    'color.accent': {
      label: 'Акцент',
      description:
        'Органичные пятна второго цвета на внутренней кромке сферы — только в холодной половине палитры (бирюза в синем).',
    },
    background: {
      label: 'Фон',
      description: 'Подложка под сеткой: цвет, виньетка и цветные пятна.',
    },
    'background.spotA': { label: 'Пятно A', description: 'Мягкое цветное пятно на фоне.' },
    'background.spotB': { label: 'Пятно B', description: 'Мягкое цветное пятно на фоне.' },
    glow: { label: 'Свечение', description: 'Ореол вокруг ячеек, блум и атмосферная дымка.' },
    'glow.halo': { label: 'Ореол', description: 'Плотное свечение в зазорах вокруг ячеек.' },
    'glow.bloom': { label: 'Блум', description: 'Мягкое свечение ярких областей.' },
    'glow.haze': { label: 'Дымка', description: 'Широкое атмосферное свечение.' },
    lift: {
      label: 'Всплывающие пиксели',
      description: 'Отдельные ячейки приподнимаются над сеткой и опускаются обратно.',
    },
    interaction: {
      label: 'Интерактив',
      description: 'Реакция на курсор и клики, параметры привязки элементов.',
    },
    render: { label: 'Производительность', description: 'Качество, разрешение и частота кадров.' },
  },
  fields: {
    'grid.sizing': {
      label: 'Размер ячейки',
      description:
        'Задавать сетку фиксированным шагом в пикселях или числом ячеек по короткой стороне контейнера.',
    },
    'grid.pitch': {
      label: 'Шаг',
      description: 'Расстояние между центрами соседних ячеек в CSS-пикселях.',
      unit: 'px',
    },
    'grid.count': {
      label: 'Ячеек',
      description:
        'Сколько ячеек помещается по короткой стороне контейнера. Композиция тогда выглядит одинаково в квадрате, баннере и на весь экран.',
    },
    'grid.gap': {
      label: 'Зазор',
      description: 'Доля шага, занятая тёмным промежутком между ячейками.',
    },
    'grid.roundness': {
      label: 'Скругление',
      description: 'Радиус углов как доля половины ячейки: 0 — квадрат, 1 — круг.',
    },
    'grid.softness': {
      label: 'Мягкость края',
      description: 'Растушёвка края ячейки в физических пикселях.',
      unit: 'px',
    },
    'grid.emitter': { label: 'Излучатель', description: 'Насколько центр ячейки ярче её краёв.' },
    'grid.bevel': {
      label: 'Фаска',
      description: 'Лёгкий объём: светлая верхняя и тёмная нижняя грань ячейки.',
    },
    'scene.center': {
      label: 'Центр',
      description: 'Центр композиции в единицах режима (1 = половина меньшей стороны).',
    },
    'scene.zoom': { label: 'Масштаб', description: 'Увеличение всех режимов относительно центра.' },
    'animation.speed': {
      label: 'Скорость',
      description: 'Глобальный множитель времени для всех режимов.',
    },
    'animation.blend': {
      label: 'Смешивание режимов',
      description: 'Как складываются несколько активных режимов.',
    },
    'animation.brightness': { label: 'Яркость', description: 'Множитель интенсивности ячеек.' },
    'animation.gamma': {
      label: 'Контраст (гамма)',
      description: 'Больше единицы — темнее полутона и контрастнее картинка.',
    },
    'animation.floor': {
      label: 'Видимость погасших',
      description: 'Насколько заметны неосвещённые ячейки.',
    },
    'animation.energy': {
      label: 'Энергия',
      description: 'Внешний «драйв»: удобно модулировать звуком или событиями.',
    },
    'animation.flicker.amount': { label: 'Сила', description: 'Амплитуда мерцания.' },
    'animation.flicker.rate': {
      label: 'Частота',
      description: 'Как быстро меняется яркость.',
      unit: 'Гц',
    },
    'animation.sparkle.amount': {
      label: 'Сила',
      description: 'Прибавка яркости во время вспышки.',
    },
    'animation.sparkle.rate': {
      label: 'Частота',
      description: 'Вероятность вспышки на ячейку в секунду.',
    },
    'animation.sparkle.duration': {
      label: 'Длительность',
      description: 'Длина одной вспышки.',
      unit: 'с',
    },
    'animation.sparsity.amount': {
      label: 'Сила',
      description: 'Доля погашенных ячеек в слабых областях.',
    },
    'animation.sparsity.period': {
      label: 'Период',
      description: 'Как часто перетасовываются погашенные ячейки.',
      unit: 'с',
    },
    'modes.flow.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.flow.scale': {
      label: 'Масштаб',
      description: 'Частота шумового узора: больше — мельче пятна.',
    },
    'modes.flow.speed': { label: 'Скорость', description: 'Скорость течения узора.' },
    'modes.flow.direction': { label: 'Направление', description: 'Куда течёт узор.' },
    'modes.flow.threshold': { label: 'Порог', description: 'Выше — меньше светящихся пятен.' },
    'modes.flow.softness': {
      label: 'Мягкость',
      description: 'Ширина перехода от тёмного к светлому.',
    },
    'modes.sphere.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.sphere.radius': { label: 'Радиус', description: 'Радиус сферы в единицах режима.' },
    'modes.sphere.shift': {
      label: 'Смещение оболочки',
      description:
        'Сдвиг светящейся оболочки относительно отверстия: с этой стороны кольцо толще и плотнее, отверстие остаётся в центре.',
    },
    'modes.sphere.hole': {
      label: 'Отверстие',
      description: 'Радиус тёмной середины; 0 — сплошной шар.',
    },
    'modes.sphere.holeSoftness': {
      label: 'Мягкость отверстия',
      description: 'Ширина перехода от отверстия к яркому кольцу.',
    },
    'modes.sphere.rimPower': {
      label: 'Ободок',
      description: 'Больше — свет сильнее прижат к краю сферы.',
    },
    'modes.sphere.outerFalloff': {
      label: 'Внешнее затухание',
      description: 'Как далеко свет уходит за радиус сферы.',
    },
    'modes.sphere.lightAngle': {
      label: 'Направление света',
      description: 'С какой стороны сфера освещена сильнее.',
    },
    'modes.sphere.lightStrength': {
      label: 'Сила света',
      description: 'Контраст между освещённой и теневой стороной.',
    },
    'modes.sphere.rotationSpeed': {
      label: 'Вращение',
      description: 'Скорость вращения поверхности сферы (знак — направление).',
    },
    'modes.sphere.tilt': { label: 'Наклон оси', description: 'Наклон оси вращения.' },
    'modes.sphere.surface': { label: 'Рельеф', description: 'Сила узора на поверхности сферы.' },
    'modes.sphere.surfaceScale': {
      label: 'Масштаб рельефа',
      description: 'Частота узора на поверхности.',
    },
    'modes.sphere.wobble': { label: 'Неровность', description: 'Искажение формы сферы шумом.' },
    'modes.sphere.breathe': { label: 'Дыхание', description: 'Амплитуда пульсации радиуса.' },
    'modes.sphere.breatheSpeed': {
      label: 'Темп дыхания',
      description: 'Частота пульсации радиуса.',
    },
    'modes.sphere.fadeAngle': {
      label: 'Сторона угасания',
      description: 'Направление, в котором сфера растворяется в фоне.',
    },
    'modes.sphere.fadeAmount': {
      label: 'Сила угасания',
      description: 'Насколько сильно гаснет сторона угасания.',
    },
    'modes.pulse.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.pulse.speed': { label: 'Скорость', description: 'Скорость расхождения колец.' },
    'modes.pulse.frequency': { label: 'Частота', description: 'Число колец на единицу режима.' },
    'modes.pulse.width': { label: 'Ширина', description: 'Толщина кольца.' },
    'modes.pulse.breathe': { label: 'Дыхание', description: 'Общая пульсация яркости.' },
    'modes.pulse.falloff': {
      label: 'Затухание',
      description: 'Как быстро кольца гаснут с расстоянием.',
    },
    'modes.pulse.origin': {
      label: 'Источник',
      description: 'Центр колец относительно центра композиции.',
    },
    'modes.wave.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.wave.angle': { label: 'Направление', description: 'Направление распространения волн.' },
    'modes.wave.frequency': { label: 'Частота', description: 'Число гребней на единицу режима.' },
    'modes.wave.speed': { label: 'Скорость', description: 'Скорость бега волн.' },
    'modes.wave.sharpness': { label: 'Резкость', description: 'Больше — узкие яркие гребни.' },
    'modes.wave.interference': {
      label: 'Интерференция',
      description: 'Примесь второй волны под другим углом.',
    },
    'modes.ripple.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.ripple.rate': {
      label: 'Частота',
      description: 'Сколько капель появляется в секунду.',
      unit: '/с',
    },
    'modes.ripple.speed': { label: 'Скорость', description: 'Скорость расхождения круга.' },
    'modes.ripple.width': { label: 'Ширина', description: 'Толщина круга.' },
    'modes.ripple.life': {
      label: 'Время жизни',
      description: 'Сколько живёт один круг.',
      unit: 'с',
    },
    'modes.vortex.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.vortex.arms': { label: 'Рукава', description: 'Количество спиральных рукавов.' },
    'modes.vortex.twist': {
      label: 'Закрутка',
      description: 'Насколько сильно закручены рукава (знак — направление).',
    },
    'modes.vortex.speed': { label: 'Скорость', description: 'Скорость вращения вихря.' },
    'modes.vortex.falloff': {
      label: 'Затухание',
      description: 'Как быстро вихрь гаснет от центра.',
    },
    'modes.vortex.sharpness': { label: 'Резкость', description: 'Чёткость границ рукавов.' },
    'modes.life.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.life.stepRate': {
      label: 'Шагов в секунду',
      description: 'Скорость эволюции автомата.',
      unit: 'Гц',
    },
    'modes.life.birthRate': {
      label: 'Спонтанные рождения',
      description: 'Вероятность случайного рождения клетки за шаг — не даёт полю вымереть.',
    },
    'modes.life.fadeSteps': {
      label: 'Затухание',
      description: 'Сколько шагов гаснет умершая клетка.',
    },
    'modes.life.seedDensity': {
      label: 'Плотность посева',
      description: 'Доля живых клеток после сброса.',
    },
    'modes.life.rule': {
      label: 'Правило',
      description: 'Правило рождения и выживания; смена правила перезапускает поле.',
    },
    'modes.rain.weight': {
      label: 'Вес',
      description: 'Вклад режима в итоговую картину; 0 — режим выключен.',
    },
    'modes.rain.speed': { label: 'Скорость', description: 'Скорость падения капель.' },
    'modes.rain.density': {
      label: 'Плотность',
      description: 'Доля колонок, по которым идёт дождь.',
    },
    'modes.rain.tail': { label: 'Шлейф', description: 'Длина светящегося следа за каплей.' },
    'modes.rain.angle': { label: 'Наклон', description: 'Отклонение дождя от вертикали.' },
    'color.palette': {
      label: 'Палитра',
      description: 'Опорные цвета градиента от начала к концу.',
    },
    'color.interpolation': {
      label: 'Интерполяция',
      description: 'Как смешиваются соседние цвета палитры.',
    },
    'color.mapping': { label: 'Раскладка', description: 'Что определяет место ячейки на палитре.' },
    'color.angle': {
      label: 'Угол оси',
      description: 'Направление от начала палитры к концу (для раскладки по оси).',
    },
    'color.bend': {
      label: 'Изгиб оси',
      description:
        'Выгибает границы цветов дугой вокруг центра (для раскладки по оси): начальный цвет собирается в серп с одной стороны.',
    },
    'color.scale': { label: 'Растяжение', description: 'Больше — палитра повторяется чаще.' },
    'color.offset': { label: 'Сдвиг', description: 'Смещение палитры вдоль раскладки.' },
    'color.warp': { label: 'Искажение', description: 'Шумовое искривление границ цветов.' },
    'color.warpScale': { label: 'Масштаб искажения', description: 'Частота шума искажения.' },
    'color.jitter': { label: 'Разброс', description: 'Случайный сдвиг цвета каждой ячейки.' },
    'color.intensityShift': {
      label: 'Сдвиг от яркости',
      description: 'Яркие ячейки смещаются по палитре.',
    },
    'color.drift': { label: 'Дрейф', description: 'Прокрутка палитры, циклов в секунду.' },
    'color.saturation': { label: 'Насыщенность', description: 'Насыщенность цвета ячеек.' },
    'color.hot.amount': { label: 'Сила', description: 'Насколько сильно светлеют яркие ячейки.' },
    'color.hot.threshold': { label: 'Порог', description: 'С какой яркости начинается раскал.' },
    'color.hot.core': { label: 'Ядро', description: 'Размер раскалённой середины ячейки.' },
    'color.accent.color': { label: 'Цвет', description: 'Цвет акцентных пятен.' },
    'color.accent.amount': {
      label: 'Сила',
      description: 'Насколько пятна окрашиваются в цвет акцента; 0 — выключено.',
    },
    'background.color': { label: 'Цвет', description: 'Основной цвет фона.' },
    'background.vignette': {
      label: 'Виньетка',
      description: 'Затемнение углов фона (ячейки не затрагивает).',
    },
    'background.spotA.color': { label: 'Цвет', description: 'Цвет пятна.' },
    'background.spotA.position': {
      label: 'Положение',
      description: 'Центр пятна в единицах режима.',
    },
    'background.spotA.radius': { label: 'Радиус', description: 'Размер пятна.' },
    'background.spotA.strength': { label: 'Сила', description: 'Яркость пятна.' },
    'background.spotB.color': { label: 'Цвет', description: 'Цвет пятна.' },
    'background.spotB.position': {
      label: 'Положение',
      description: 'Центр пятна в единицах режима.',
    },
    'background.spotB.radius': { label: 'Радиус', description: 'Размер пятна.' },
    'background.spotB.strength': { label: 'Сила', description: 'Яркость пятна.' },
    'glow.halo.strength': { label: 'Сила', description: 'Яркость ореола.' },
    'glow.halo.radius': {
      label: 'Радиус',
      description: 'Как далеко ореол заходит в зазор.',
      unit: 'яч.',
    },
    'glow.bloom.strength': { label: 'Сила', description: 'Яркость блума.' },
    'glow.bloom.radius': {
      label: 'Радиус',
      description: 'Ширина размытия блума в ячейках.',
      unit: 'яч.',
    },
    'glow.bloom.threshold': {
      label: 'Порог',
      description: 'С какой яркости ячейка начинает светиться.',
    },
    'glow.bloom.knee': { label: 'Плавность порога', description: 'Мягкость перехода через порог.' },
    'glow.haze.strength': { label: 'Сила', description: 'Яркость дымки.' },
    'glow.haze.radius': {
      label: 'Радиус',
      description: 'Ширина размытия дымки в ячейках.',
      unit: 'яч.',
    },
    'glow.saturation': {
      label: 'Насыщенность свечения',
      description: 'Насыщенность ореола, блума и дымки.',
    },
    'glow.exposure': { label: 'Экспозиция', description: 'Общая яркость перед тонмаппингом.' },
    'glow.whitePoint': {
      label: 'Точка белого',
      description: 'Какая яркость становится белой; больше — мягче пересветы.',
    },
    'lift.enabled': { label: 'Включено', description: 'Показывать всплывающие пиксели.' },
    'lift.style': {
      label: 'Стиль',
      description: 'Подъём на месте или всплытие вверх, как пузырьки.',
    },
    'lift.amount': { label: 'Количество', description: 'Доля ячеек, поднятых одновременно.' },
    'lift.max': { label: 'Максимум', description: 'Предел одновременно поднятых ячеек.' },
    'lift.scale': {
      label: 'Увеличение',
      description: 'Во сколько раз поднятая ячейка больше обычной.',
    },
    'lift.height': { label: 'Высота', description: 'Смещение вверх при подъёме.', unit: 'яч.' },
    'lift.parallax': {
      label: 'Параллакс',
      description: 'Сдвиг от центра, создающий ощущение глубины.',
    },
    'lift.tilt': { label: 'Наклон', description: 'Случайный наклон поднятой ячейки.', unit: '°' },
    'lift.holdMin': {
      label: 'Удержание от',
      description: 'Минимальное время в поднятом состоянии.',
      unit: 'с',
    },
    'lift.holdMax': {
      label: 'Удержание до',
      description: 'Максимальное время в поднятом состоянии.',
      unit: 'с',
    },
    'lift.rise': {
      label: 'Подъём',
      description: 'Длительность подъёма (с пружинным отскоком).',
      unit: 'с',
    },
    'lift.fall': {
      label: 'Опускание',
      description: 'Длительность возвращения на место.',
      unit: 'с',
    },
    'lift.brightness': { label: 'Яркость', description: 'Дополнительная яркость поднятой ячейки.' },
    'lift.whiten': { label: 'Высветление', description: 'Сдвиг цвета к светлому оттенку.' },
    'lift.bokeh': { label: 'Боке', description: 'Доля поднятых ячеек, размытых как вне фокуса.' },
    'lift.shadow': { label: 'Тень', description: 'Плотность тени под поднятой ячейкой.' },
    'lift.halo': { label: 'Ореол', description: 'Свечение вокруг поднятой ячейки.' },
    'lift.socket': {
      label: 'Гнездо',
      description: 'Насколько темнеет место, откуда поднялась ячейка.',
    },
    'lift.threshold': {
      label: 'Порог',
      description: 'Минимальная яркость ячейки, чтобы она могла подняться.',
    },
    'lift.outerBias': {
      label: 'Тяга к краю',
      description: 'Предпочитать внешние и тусклые области.',
    },
    'lift.cluster': {
      label: 'Группы',
      description: 'Вероятность поднять вместе с ячейкой её соседей.',
    },
    'lift.landing': { label: 'Приземление', description: 'Сила кольца-волны при опускании.' },
    'lift.floatSpeed': {
      label: 'Скорость всплытия',
      description: 'Скорость подъёма в стиле «Всплытие».',
      unit: 'яч./с',
    },
    'lift.floatDrift': { label: 'Снос', description: 'Боковое покачивание при всплытии.' },
    'interaction.pointer': { label: 'Курсор', description: 'Подсвечивать ячейки под курсором.' },
    'interaction.pointerRadius': {
      label: 'Радиус курсора',
      description: 'Размер пятна света вокруг курсора.',
      unit: 'яч.',
    },
    'interaction.pointerStrength': {
      label: 'Сила курсора',
      description: 'Яркость подсветки под курсором.',
    },
    'interaction.pointerLift': {
      label: 'Подъём под курсором',
      description: 'Поднимать ячейки при наведении.',
    },
    'interaction.click': { label: 'Клик', description: 'Запускать волну по клику.' },
    'interaction.rippleStrength': { label: 'Сила волны', description: 'Яркость волны от клика.' },
    'interaction.rippleSpeed': {
      label: 'Скорость волны',
      description: 'Скорость расхождения волны.',
      unit: 'яч./с',
    },
    'interaction.rippleWidth': {
      label: 'Ширина волны',
      description: 'Толщина кольца волны.',
      unit: 'яч.',
    },
    'interaction.influenceStrength': {
      label: 'Сила влияний',
      description: 'Сила по умолчанию для привязанных элементов (bindElement / addInfluence).',
    },
    'interaction.influenceFalloff': {
      label: 'Спад влияний',
      description: 'Ширина мягкого края влияния по умолчанию.',
      unit: 'яч.',
    },
    'render.quality': {
      label: 'Качество',
      description: '«Авто» снижает качество, если устройство не успевает.',
    },
    'render.maxDpr': { label: 'Макс. DPR', description: 'Предел плотности пикселей холста.' },
    'render.maxPixels': {
      label: 'Макс. пикселей',
      description: 'Предел размера холста; на телефонах не больше 2.4 Мпикс.',
      unit: 'Мпикс',
    },
    'render.overflow': {
      label: 'Выход за край',
      description: 'Холст выходит за контейнер, чтобы свечение не обрезалось.',
      unit: 'px',
    },
    'render.maxFps': {
      label: 'Макс. FPS',
      description: '0 — частота дисплея; иначе целый делитель частоты обновления.',
    },
    'render.pauseOffscreen': {
      label: 'Пауза вне экрана',
      description: 'Останавливать отрисовку, когда фон не виден.',
    },
    'render.reducedMotion': {
      label: 'Меньше движения',
      description: 'Учитывать системную настройку prefers-reduced-motion.',
    },
    transition: {
      label: 'Переход',
      description: 'Длительность плавного перехода при смене настроек.',
      unit: 'мс',
    },
  },
  enums: {
    'grid.sizing': { pitch: 'Шаг в px', count: 'Число ячеек' },
    'animation.blend': { screen: 'Экран', add: 'Сложение', max: 'Максимум' },
    'modes.life.rule': {
      conway: 'Конвей B3/S23',
      highlife: 'HighLife B36/S23',
      daynight: 'День и ночь',
      seeds: 'Семена B2/S',
    },
    'color.interpolation': { oklab: 'OKLab (ровно)', linear: 'Линейно (RGB)', steps: 'Ступени' },
    'color.mapping': {
      spatial: 'По оси',
      radial: 'По радиусу',
      angular: 'По углу',
      intensity: 'По яркости',
      noise: 'Шум',
    },
    'lift.style': { pop: 'Подъём', float: 'Всплытие' },
    'render.quality': { auto: 'Авто', high: 'Высокое', medium: 'Среднее', low: 'Низкое' },
    'render.reducedMotion': { respect: 'Учитывать', ignore: 'Игнорировать' },
  },
  presets: {
    reference: {
      label: 'Референс',
      description:
        'Полая неоновая сфера: малиновый верх слева, синий низ справа, угасание в тёмно-синий.',
    },
    orb: {
      label: 'Сфера',
      description:
        'Сплошная вращающаяся планета: освещённый голубой край, глубокая индиговая тень и тонкая атмосфера.',
    },
    pulse: {
      label: 'Пульс',
      description:
        'Чёткие кольца расходятся от центра и мягко дышат: малиновый, розовый, фиолетовый.',
    },
    life: {
      label: 'Жизнь',
      description:
        'Клеточный автомат Конвея: клетки быстро вспыхивают и плавно гаснут, бирюза и мята.',
    },
    vortex: {
      label: 'Вихрь',
      description: 'Трёхрукавная галактика: золотое ядро, огненные рукава и фиолетовые окраины.',
    },
    waves: {
      label: 'Волны',
      description:
        'Интерференционная плазма: изгибающиеся гребни от индиго через фиолет к голубому.',
    },
    ripples: {
      label: 'Капли',
      description:
        'Тёмная вода под луной: от случайных капель расходятся серебристо-голубые круги.',
    },
    rain: {
      label: 'Дождь',
      description: 'Зелёный «цифровой дождь» на почти чёрном фоне, мелкая сетка.',
    },
    minimal: {
      label: 'Минимализм',
      description:
        'Монохромные белые острова медленно плывут по угольному фону, сдержанное свечение.',
    },
  },
};
