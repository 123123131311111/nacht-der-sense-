// =====================================================================
//  server.js — мультиплеерный сервер (Express + Socket.io)
//  Запуск локально:  npm install && npm start   → http://localhost:3000
//  На Render:        Build Command: npm install | Start Command: npm start
// =====================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Render сам выдаёт порт через process.env.PORT. Локально — 3000.
const PORT = process.env.PORT || 3000;

// Socket.io. CORS открыт, чтобы можно было хостить клиент отдельно (например, GitHub Pages).
// Для продакшена лучше заменить "*" на адрес своего сайта.
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Раздаём игру (папка public) — клиент и сервер живут на одном адресе.
app.use(express.static(path.join(__dirname, 'public')));

// Эндпоинт для проверки "жив ли сервер" (Render health check / будилка для free-плана).
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(players).length }));

// ---------------------------------------------------------------------
//  Состояние игроков в памяти: { socketId: { id, name, color, x,y,z, yaw, pitch } }
//  Если сервер перезапустится — список обнулится (для игры этого достаточно).
// ---------------------------------------------------------------------
const players = {};
const MAX_PLAYERS = 8;                 // лимит комнаты
const SPAWN = { x: -9.5, y: 1.7, z: 9.5 }; // та же точка, что SPAWN в игре

// Простая проверка, что пришло нормальное число (защита от мусора и NaN).
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

// Случайный цвет для аватара игрока.
const randomColor = () => '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');

io.on('connection', (socket) => {
  // socket.id — уникальный ID, генерируется Socket.io автоматически.
  if (Object.keys(players).length >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  // 1) Создаём запись нового игрока.
  players[socket.id] = {
    id: socket.id,
    name: 'Игрок ' + socket.id.slice(0, 4),
    color: randomColor(),
    ...SPAWN,
    yaw: 0,
    pitch: 0,
  };
  console.log(`[+] ${socket.id} подключился (всего: ${Object.keys(players).length})`);

  // 2) Новому игроку — его ID и список всех, кто уже в игре.
  socket.emit('init', { selfId: socket.id, players });

  // 3) Остальным — «к нам зашёл новый».
  socket.broadcast.emit('playerJoined', players[socket.id]);

  // 4) Игрок сообщил своё имя (необязательно).
  socket.on('setName', (name) => {
    const p = players[socket.id];
    if (!p || typeof name !== 'string') return;
    p.name = name.trim().slice(0, 16) || p.name;
    io.emit('playerRenamed', { id: p.id, name: p.name });
  });

  // 5) Игрок двигается: клиент шлёт позицию + поворот камеры.
  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;
    p.x = num(data.x, p.x);
    p.y = num(data.y, p.y);
    p.z = num(data.z, p.z);
    p.yaw = num(data.yaw, p.yaw);
    p.pitch = num(data.pitch, p.pitch);
    // volatile — если пакет не успел, он просто теряется (для позиций это нормально).
    socket.broadcast.volatile.emit('playerMoved', {
      id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    });
  });

  // 6) Выстрел (чтобы другие видели вспышку/слышали звук). Урон тут не считается.
  socket.on('shoot', () => {
    socket.broadcast.emit('playerShot', { id: socket.id });
  });

  // 7) Отключение: удаляем игрока и сообщаем остальным.
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    console.log(`[-] ${socket.id} вышел (всего: ${Object.keys(players).length})`);
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
