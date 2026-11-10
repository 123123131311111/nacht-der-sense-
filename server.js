// =====================================================================
//  server.js — мультиплеерный сервер с ЛОББИ (Express + Socket.io)
//  Локально:  npm install && npm start   → http://localhost:3000
//  Render:    Build: npm install | Start: npm start
// =====================================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;           // Render задаёт порт сам

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 4;                            // максимум игроков в лобби

// rooms:  { 'ABCD': { code, hostId, players: { socketId: {id,name,color,slot,x,y,z,yaw,pitch,active} } } }
const rooms = {};
// Вспомогательная таблица: в какой комнате сидит сокет.
const roomOf = {};

app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ---------- утилиты ----------
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const COLORS = ['#e04040', '#3a8ee6', '#46c46a', '#e6c83a'];   // цвет по номеру слота

function makeCode() {                              // код лобби из 4 букв (без похожих O/0, I/1)
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
  while (rooms[code]);
  return code;
}
function freeSlot(room) {                          // самый маленький свободный слот 0..3 (определяет точку спавна)
  const used = new Set(Object.values(room.players).map(p => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}
const cleanName = (n, id) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 16) : 'Игрок ' + id.slice(0, 3));

// Рассылка актуального списка игроков лобби всем в комнате.
function sendLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code,
    hostId: room.hostId,
    players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, color: p.color, slot: p.slot })),
  });
}

function addToRoom(socket, room, name) {
  const slot = freeSlot(room);
  const player = { id: socket.id, name: cleanName(name, socket.id), color: COLORS[slot], slot,
                   x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0, active: false };
  room.players[socket.id] = player;
  roomOf[socket.id] = room.code;
  socket.join(room.code);
  // Новому игроку: его данные и все, кто уже в комнате.
  socket.emit('joined', { selfId: socket.id, code: room.code, slot, players: room.players });
  socket.to(room.code).emit('playerJoined', player);
  sendLobby(room);
}

function leaveRoom(socket) {
  const code = roomOf[socket.id];
  if (!code) return;
  const room = rooms[code];
  delete roomOf[socket.id];
  socket.leave(code);
  if (!room) return;
  delete room.players[socket.id];
  io.to(code).emit('playerLeft', socket.id);
  const ids = Object.keys(room.players);
  if (ids.length === 0) { delete rooms[code]; return; }          // пустую комнату удаляем
  if (room.hostId === socket.id) room.hostId = ids[0];           // хоста передаём следующему
  sendLobby(room);
}

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  // Создать лобби.
  socket.on('createRoom', ({ name } = {}) => {
    leaveRoom(socket);
    const code = makeCode();
    rooms[code] = { code, hostId: socket.id, players: {} };
    addToRoom(socket, rooms[code], name);
  });

  // Войти в лобби по коду.
  socket.on('joinRoom', ({ code, name } = {}) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('joinError', 'Лобби с таким кодом не найдено');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('joinError', 'Лобби заполнено (макс. 4)');
    leaveRoom(socket);
    addToRoom(socket, room, name);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));

  // Позиция/поворот. Первое сообщение делает игрока «активным» (он вошёл в игру).
  socket.on('move', (d) => {
    const room = rooms[roomOf[socket.id]];
    const p = room && room.players[socket.id];
    if (!p || !d) return;
    p.x = num(d.x, p.x); p.y = num(d.y, p.y); p.z = num(d.z, p.z);
    p.yaw = num(d.yaw, p.yaw); p.pitch = num(d.pitch, p.pitch); p.active = true;
    socket.to(room.code).volatile.emit('playerMoved', { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
  });

  socket.on('shoot', () => {
    const code = roomOf[socket.id];
    if (code) socket.to(code).emit('playerShot', { id: socket.id });
  });

  socket.on('disconnect', () => { leaveRoom(socket); console.log('[-]', socket.id); });
});

server.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
