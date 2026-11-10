# Nacht der Untoten — мультиплеер

## Структура
```
server.js            – штатная точка запуска
server-multiplayer.js – серверное состояние мира, попадания и экономика
package.json
public/index.html    – твоя игра (nacht_bunker.html) + 2 добавленных <script>
public/multiplayer.js – сетевой клиент и применение серверного состояния
```

## Запуск локально
```
npm install
npm start
```
Открой http://localhost:3000 в двух вкладках: ИГРАТЬ → МУЛЬТИПЛЕЕР → в одной «Создать лобби», в другой ввести код. Макс. 4 игрока.

## Деплой: GitHub → Render
1. Залей папку в репозиторий GitHub (`node_modules` игнорируется через .gitignore).
2. render.com → New → **Web Service** → выбери репозиторий.
3. Build Command: `npm install` · Start Command: `npm start`
4. После деплоя открой выданный адрес `https://имя.onrender.com`.

Бесплатный план Render «засыпает» без запросов — первое подключение может занять ~30–60 сек.
Проверка работы: `/health`.

В мультиплеере сервер хранит общий счёт, покупки, двери, раунд и подтверждённое состояние зомби. Клиент хоста передаёт серверу снимки движения и ИИ зомби; сервер рассылает их комнате, подтверждает попадания и начисляет очки. В одиночном режиме игровая логика остаётся локальной и не меняется.

## Клиент отдельно от сервера (GitHub Pages)
В `public/multiplayer.js` впиши `const SERVER_URL = 'https://имя.onrender.com';`
и подключи в HTML `<script src="https://имя.onrender.com/socket.io/socket.io.js"></script>`.

## Имя игрока
В консоли браузера: `MP.setName('Вася')`.
