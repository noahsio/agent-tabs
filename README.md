# Agent Tabs

Расширение VS Code: каждая сессия [OmO](https://omo.dev) открывается во вкладке редактора со своим чатом. Отдельный фоновый процесс сохраняет сессии после перезагрузки окна. Лицензия MIT.

## Установка

Нужны OmO с omo.dev, VS Code, Node.js >= 22 и npm. CodeGraph необязателен: если он установлен в PATH, setup подключает его MCP и хуки.


```sh
scripts/install.sh
```

Скрипт выполняет `npm ci`, сборку, упаковку VSIX, установку в системный VS Code и проверку списка расширений, затем запускает `node kit/setup-omo.mjs --env system`.

Для другого CLI задайте `AGENT_TABS_CODE`. Без него используется системный macOS VS Code, затем `code` из PATH. Для отдельной установки доступны `AGENT_TABS_EXTENSIONS_DIR` и `AGENT_TABS_USER_DATA_DIR`; `AGENT_TABS_SKIP_OMO_SETUP=1` пропускает setup. Запуск с временным HOME изолирует также файлы OmO.

## Первый запуск

1. Перезагрузите окно: `Developer: Reload Window`.
2. В настройках VS Code задайте `agentTabs.environmentVariables` по шаблону [системной среды](setup/env.system.example.json), заменив `/Users/<you>` своим HOME. Обязательна `OMO_CODING_AGENT_DIR`. При необходимости измените `agentTabs.omoPath` (по умолчанию `~/.local/bin/omo`).
3. Откройте палитру: `Agent Tabs: Новая сессия` или `Agent Tabs: Открыть сессию…`.
4. В чате откройте «Настройки → Подключения» и укажите свой URL шлюза и свой ключ. Ключ хранится в `<agentDir>/keys/*.key` с правами 0600; в настройки VS Code его копировать не нужно.
5. Настройте «Модели и роли» или перенесите поля из [примера ролей](setup/omo.roles.example.jsonc) в `~/.omo/omo.jsonc`. Сохраните свои остальные настройки; указанные модели должны существовать у вашего шлюза. Телеметрия в примере выключена.

После изменения окружения или ключа перезагрузите окно и выполните `Agent Tabs: Перезапустить OmO`. Команда требует подтверждения и прерывает текущие ходы; вкладки переподключаются.

## Комплект OmO и вторая среда

Setup создаёт каталог агента, подключает существующие отобранные навыки из `~/.claude/skills` (остальные навыки оттуда OmO тоже видит, как Claude Code: расширение ставит в OmO своё дополнение `extensions/agent-tabs-skills.ts`; выключаются они в «Инструменты» → «Навыки»), глобальные инструкции Claude, CodeGraph при наличии, категорию рефлексии `quick` и оболочку `~/.local/bin/omo-system`. Итог показывает выполненные и пропущенные шаги. Сам OmO установите отдельно. Можно проверить изменения через `node kit/setup-omo.mjs --dry-run`.

По умолчанию доступны `system` и его псевдоним `default`: `~/.omo/agent`, `~/.omo/memory`, `~/.claude`. Вторая среда появляется только при заданной `OMO_KIT_SECOND_AGENT_DIR`:


```sh
export OMO_KIT_SECOND_AGENT_DIR=.omo-second/agent
export OMO_KIT_SECOND_MEMORY_HOME=.omo-second/memory
export OMO_KIT_SECOND_CLAUDE_DIR=.omo-second/claude
# OMO_KIT_SECOND_CODEGRAPH — необязательный путь к исполняемому файлу
node kit/setup-omo.mjs --env second
```

Все четыре пути могут быть абсолютными или относительно HOME. Без дополнительных переменных память и Claude второй среды находятся в `~/.omo-second/memory` и `~/.omo-second/claude`, CodeGraph ищется в PATH. Настройки VS Code показаны в [примере второй среды](setup/env.second.example.json). Передайте эти переменные процессу VS Code, чтобы настройки и защита видели ту же среду.

Портативный VS Code устанавливается только при `AGENT_TABS_SECOND_VSCODE=<каталог>`, содержащем `Visual Studio Code.app` и `code-portable-data`. Эта переменная также добавляет его пути в защиту.

## Что не входит

- Защита команд выключена по умолчанию; код сохранён. Включайте её явно в «Безопасность». Белый список публичных IP пуст. Описание: [kit/guard/README.md](kit/guard/README.md).
- Корпуса реальных команд и личные исследовательские материалы не включены. Синтетические регрессионные фикстуры оставлены для тестов.
- Superpowers не входит в комплект: установите собственную версию. Setup не клонирует и не обновляет его автоматически. Явный флаг `--superpowers` включает прежнюю установку закреплённого форка; `OMO_KIT_SUPERPOWERS_URL`, `OMO_KIT_SUPERPOWERS_REF` и `OMO_KIT_SUPERPOWERS_DIR` задают источник, версию и каталог. `--update-packages` применяется вместе с `--superpowers`. Переключатели уже установленных навыков в интерфейсе сохранены.

## Проверки


```sh
npm ci
npx tsc --noEmit
npm test
npm run build
npm run test:chrome
```

Браузерные тесты используют Playwright chrome-headless-shell (при необходимости установите `npx playwright install chromium-headless-shell`), без запуска приложения Google Chrome. Живые тесты запускаются отдельно: `AGENT_TABS_LIVE=1 npx vitest run test/live`. Они используют настоящий OmO и могут тратить токены; создают scratch-каталоги в /tmp и останавливают только свои процессы.

Источники live-тестов задаются через `AGENT_TABS_LIVE_ENV` (по умолчанию system), `AGENT_TABS_LIVE_MODELS`, `AGENT_TABS_LIVE_SETTINGS` и `AGENT_TABS_LIVE_KEY`. По умолчанию модели берутся из `~/.omo/agent/models.json`, ключ — из `~/.omo/agent/keys/gw.key`; настройки VS Code читаются только при явном пути. Модели можно переопределить через `AGENT_TABS_LIVE_PROVIDER` / `AGENT_TABS_LIVE_MODEL`, `AGENT_TABS_LIVE_AUTO_PROVIDER` / `AGENT_TABS_LIVE_AUTO_MODEL` и `AGENT_TABS_LIVE_MANUAL_PROVIDER` / `AGENT_TABS_LIVE_MANUAL_MODEL`.

## Известные ограничения

- После смены ключа или окружения нужен перезапуск OmO. Старые окна расширения 0.2.x могут запускать незащищённый хост: обновите расширение и перезагрузите все окна этой среды.
- Подзадачи OmO на отдельных хостах могут не получать CLAUDE_CONFIG_DIR; это не проверено вживую.
- При миграции со старого omo daemon остановите его до открытия тех же сессий. Открытие файла живой сессии через switch_session может создать второго писателя транскрипта.
- Переменные OMO/SENPI/PI/ANTHROPIC/OPENAI/GW и CLAUDE_CONFIG_DIR из окружения VS Code фильтруются; используйте явные настройки Agent Tabs.
- OmO иногда обрывает ход сам сразу после старта (`abortSource: "system"`) и сообщение не переигрывает. Вкладка узнаёт это, говорит об этом в ленте, один раз перезапускает сессию и отправляет сообщение заново (`docs/superpowers/specs/2026-11-05-liveness-abort-design.md`).
- Abort сначала отменяет диалоги разрешений. Set_model меняет глобальную модель в settings.json; возврат Auto выставляет модель профиля явно.
- Заголовок берётся из первого сообщения. Хост завершается через 15 минут без сессий и клиентов; при возобновлении меняются обработчики и ключ сессии.
- Пути cwd не канонизируются: /tmp и /private/tmp дают разные списки сессий.
- Тяжёлый поток событий расходует много памяти: прежние замеры показывали около 240 МБ на сессию с промптом и 5,5 ГБ после десяти сессий; значения зависят от OmO.
- Память, engine-trust и lsp-daemon могут разделяться через HOME. OMO_MEMORY_HOME не гарантирует полной изоляции. Фоновая рефлексия после закрытия сессии может тратить токены.
