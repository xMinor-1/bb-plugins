---
paths:
  - "plugins/sticker-note/**"
---

# Sticker Note: живая проверка на bb владельца

- Доска владельца живая: тестовые карточки удалять, его карточки не трогать.
  Номера стикеров не переиспользуются, поэтому после уборки вернуть счётчик
  `plugin_kv` (`plugin_id='sticker-note'`, `key='seq'`) к наибольшему номеру его
  карточек и перезагрузить плагин.
- Голос проверять настоящим путём: русская фраза через gTTS в отдельном venv,
  `ffmpeg` в WAV 48 кГц моно, Chromium с `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` и
  `grantPermissions(["microphone"])`. Так видно горячую клавишу, запись,
  распознавание voice-ink и разбор фразы за один прогон.
- Фразы владельца, на которых ломался разбор, — в тесты (`test/parse.test.ts`),
  без имён людей: репозиторий публичный.
