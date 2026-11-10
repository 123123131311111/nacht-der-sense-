// Server-owned shared game state for Nacht der Untoten multiplayer.
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const rooms = Object.create(null);
const roomOf = Object.create(null);

const WEAPONS = [
  { body: 50, head: 100, interval: 150, pellets: 1 },
  { body: 75, head: 150, interval: 75, pellets: 1 },
  { body: 60, head: 120, interval: 850, pellets: 8 },
  { body: 150, head: 300, interval: 550, pellets: 1 },
  { body: 250, head: 500, interval: 280, pellets: 1 },
  { body: 940, head: 940, interval: 350, pellets: 24 },
];
const DOORS = [
  { x: -9.5, z: 4 }, { x: 4, z: -4 }, { x: -3, z: 4 },
  { x: 10, z: -2 }, { x: 7, z: 1 },
];
const WINDOWS = [
  [-8, -15, 1.7], [5, -15, 1.7], [-8, -15, 5.7], [5, -15, 5.7],
  [-12, 15, 1.7], [-7, 15, 1.7], [-2, 15, 5.7], [6, 15, 5.7],
  [-15, -5.5, 1.7], [-15, 7, 5.7], [15, -2, 1.7], [15, 4, 5.7],
];

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cleanName = (n, id) => typeof n === 'string' && n.trim()
  ? n.trim().slice(0, 16) : `Игрок ${id.slice(0, 3)}`;
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms[code]);
  return code;
}
function makePlayer(id, name, slot) {
  return {
    id, name: cleanName(name, id), color: ['#e04040', '#3a8ee6', '#46c46a', '#e6c83a'][slot], slot,
    x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0, active: false,
    points: 500, hp: 100, perks: { cola: false, doubleTap: false },
    owned: { thompson: false, shotgun: false }, shots: Object.create(null), lastShotAt: -Infinity,
  };
}
function makeRoom(code, hostId) {
  return {
    code, hostId, players: Object.create(null),
    game: {
      started: false, round: 0, roundActive: false, toSpawn: 0, nextRoundIn: 0,
      doors: [false, false, false, false, false],
      windowBoards: WINDOWS.map(() => ({ boards: 4, pending: 0 })), zombies: [],
      revision: 0, boxBusyUntil: 0,
    },
  };
}
function gamePayload(room) {
  const game = room.game;
  return {
    hostId: room.hostId,
    started: game.started,
    round: game.round,
    roundActive: game.roundActive,
    toSpawn: game.toSpawn,
    nextRoundIn: game.nextRoundIn,
    doors: game.doors.slice(),
    windowBoards: game.windowBoards,
    zombies: game.zombies,
    revision: game.revision,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch, active: p.active, points: p.points, hp: p.hp,
      perks: { ...p.perks },
    })),
  };
}
function sendGame(room) { io.to(room.code).emit('gameState', gamePayload(room)); }
function sendLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code, hostId: room.hostId,
    players: Object.values(room.players).map(({ id, name, color, slot }) => ({ id, name, color, slot })),
  });
}
function freeSlot(room) {
  const used = new Set(Object.values(room.players).map(p => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}
function addToRoom(socket, room, name) {
  const slot = freeSlot(room);
  if (slot < 0) return socket.emit('joinError', 'Лобби заполнено (макс. 4)');
  const player = makePlayer(socket.id, name, slot);
  room.players[socket.id] = player;
  roomOf[socket.id] = room.code;
  socket.join(room.code);
  socket.emit('joined', {
    selfId: socket.id, code: room.code, slot,
    players: Object.fromEntries(Object.entries(room.players).map(([id, p]) => [id, {
      id: p.id, name: p.name, color: p.color, slot: p.slot,
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, active: p.active,
    }])),
  });
  socket.to(room.code).emit('playerJoined', player);
  sendLobby(room);
  sendGame(room);
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
  if (!ids.length) { delete rooms[code]; return; }
  if (room.hostId === socket.id) {
    room.hostId = ids[0];
    // Host-generated IDs include the previous host's socket ID; the new host can
    // continue them while preserving each zombie's server-issued identity.
  }
  sendLobby(room);
  sendGame(room);
}
function roomAndPlayer(socket) {
  const room = rooms[roomOf[socket.id]];
  return room && room.players[socket.id] ? { room, player: room.players[socket.id] } : null;
}
function near(player, x, z, radius, minY = -Infinity, maxY = Infinity) {
  return player.active && player.y >= minY && player.y <= maxY &&
    Math.hypot(player.x - x, player.z - z) <= radius;
}
function failPurchase(socket, message) { socket.emit('purchaseRejected', message); }

io.on('connection', socket => {
  socket.on('createRoom', ({ name } = {}) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = rooms[code] = makeRoom(code, socket.id);
    addToRoom(socket, room, name);
  });

  socket.on('joinRoom', ({ code, name } = {}) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit('joinError', 'Лобби с таким кодом не найдено');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('joinError', 'Лобби заполнено (макс. 4)');
    leaveRoom(socket);
    addToRoom(socket, room, name);
  });

  socket.on('leaveRoom', () => leaveRoom(socket));

  socket.on('move', data => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !data || typeof data !== 'object') return;
    const { room, player } = ctx;
    player.x = clamp(finite(data.x, player.x), -100, 100);
    player.y = clamp(finite(data.y, player.y), -10, 30);
    player.z = clamp(finite(data.z, player.z), -100, 100);
    player.yaw = finite(data.yaw, player.yaw);
    player.pitch = finite(data.pitch, player.pitch);
    player.active = true;
    socket.to(room.code).volatile.emit('playerMoved', {
      id: player.id, x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch,
    });
  });

  socket.on('gameStart', () => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || ctx.room.hostId !== socket.id) return;
    ctx.room.game.started = true;
    sendGame(ctx.room);
  });

  socket.on('shoot', ({ shotId, weapon, yaw, pitch } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !ctx.room.game.started || !ctx.player.active) return;
    const { room, player } = ctx;
    if (typeof shotId !== 'string' || shotId.length > 80) return;
    weapon = Number(weapon);
    const interval = weapon === -1 ? 2000 : (WEAPONS[weapon] && WEAPONS[weapon].interval);
    if (!interval) return;
    const now = Date.now();
    if (now - player.lastShotAt < interval * 0.75) return;
    player.lastShotAt = now;
    const maxHits = weapon === -1 ? 24 : (WEAPONS[weapon].pellets || 1);
    player.shots[shotId] = { weapon, at: now, hits: 0, hitIds: new Set(), maxHits };
    for (const [key, shot] of Object.entries(player.shots)) if (now - shot.at > 3000) delete player.shots[key];
    io.to(room.code).emit('playerShot', {
      id: socket.id, weapon, x: player.x, y: player.y, z: player.z,
      yaw: finite(yaw, player.yaw), pitch: finite(pitch, player.pitch),
    });
  });

  socket.on('zombieHit', ({ zombieId, shotId, head } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || typeof zombieId !== 'string' || typeof shotId !== 'string') return;
    const { room, player } = ctx;
    const shot = player.shots[shotId];
    if (!shot || Date.now() - shot.at > 3000 || shot.hits >= shot.maxHits ||
        (shot.weapon !== 2 && shot.hitIds.has(zombieId))) return;
    const zombie = room.game.zombies.find(z => z.id === zombieId);
    if (!zombie || zombie.state === 'dying' || !(shot.weapon === -1 || WEAPONS[shot.weapon])) return;
    shot.hits++;
    if (shot.weapon !== 2) shot.hitIds.add(zombieId);
    const weapon = shot.weapon === -1
      ? { body: 100000, head: 100000 }
      : WEAPONS[shot.weapon];
    const damage = (head ? weapon.head : weapon.body) * (player.perks.doubleTap ? 2 : 1);
    zombie.hp = Math.max(0, zombie.hp - damage);
    const killed = zombie.hp <= 0;
    if (killed) zombie.state = 'dying';
    const reward = killed ? (head ? 100 : 60) : 10;
    player.points += reward;
    room.game.revision++;
    io.to(room.code).emit('zombieHit', {
      zombieId, head: !!head, hp: zombie.hp, state: zombie.state,
      killed, shooterId: socket.id, points: player.points, reward, revision: room.game.revision,
    });
    sendGame(room);
  });

  socket.on('windowBoardAction', ({ action, index } = {}) => {
    const ctx = roomAndPlayer(socket);
    index = Number(index);
    if (!ctx || !ctx.room.game.started || action !== 'repair' || !Number.isInteger(index) || !WINDOWS[index]) return;
    const [x, z, y] = WINDOWS[index];
    if (!near(ctx.player, x, z, 2.7, y - 1.6, y + 1.6)) return;
    const now = Date.now();
    if (now - (ctx.player.lastBoardRepair || 0) < 550) return;
    const windowState = ctx.room.game.windowBoards[index];
    if (!windowState || windowState.boards + windowState.pending >= 4) return;
    ctx.player.lastBoardRepair = now;
    windowState.pending++;
    ctx.player.points += 10;
    io.to(ctx.room.code).emit('windowBoardAction', { action, index, actorId: socket.id });
    sendGame(ctx.room);
  });

  socket.on('purchaseRequest', ({ kind, doorIndex } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !ctx.room.game.started) return;
    const { room, player } = ctx;
    let price = 0, weaponIndex = null, boxResult = null;
    const floor = player.y;
    if (kind === 'door') {
      doorIndex = Number(doorIndex);
      const door = DOORS[doorIndex];
      if (!door || room.game.doors[doorIndex]) return failPurchase(socket, 'Эта дверь уже открыта');
      if (!near(player, door.x, door.z, 3.2, -1, 3.2)) return failPurchase(socket, 'Подойдите ближе к двери');
      price = 1000;
    } else if (kind === 'cola') {
      if (!near(player, -14.25, 7, 2.8, -1, 3.2)) return failPurchase(socket, 'Подойдите к автомату Speed Cola');
      if (player.perks.cola) return failPurchase(socket, 'Speed Cola уже куплено');
      price = 4000;
    } else if (kind === 'doubleTap') {
      if (!near(player, -12, -14.25, 2.8, 3.2, 7.5)) return failPurchase(socket, 'Подойдите к автомату Double Tap');
      if (player.perks.doubleTap) return failPurchase(socket, 'Double Tap уже куплено');
      price = 2500;
    } else if (kind === 'thompson' || kind === 'shotgun') {
      const shotgun = kind === 'shotgun';
      const owned = shotgun ? player.owned.shotgun : player.owned.thompson;
      const pos = shotgun ? { x: -14.7, z: -11.5 } : { x: -14.7, z: 10 };
      if (!near(player, pos.x, pos.z, 3, -1, 3.2)) return failPurchase(socket, 'Подойдите к стене с оружием');
      price = shotgun ? (owned ? 600 : 1200) : (owned ? 500 : 1000);
      weaponIndex = shotgun ? 2 : 1;
    } else if (kind === 'box') {
      if (!near(player, -6, 5.7, 3.5, -1, 3.2)) return failPurchase(socket, 'Подойдите к Mystery Box');
      if (room.game.boxBusyUntil > Date.now()) return failPurchase(socket, 'Mystery Box уже используется');
      price = 950;
      boxResult = 1 + Math.floor(Math.random() * 5);
    } else return failPurchase(socket, 'Неизвестная покупка');
    if (player.points < price) return failPurchase(socket, 'Не хватает очков');
    player.points -= price;
    if (kind === 'box') room.game.boxBusyUntil = Date.now() + 3800;
    if (kind === 'door') room.game.doors[doorIndex] = true;
    if (kind === 'cola') player.perks.cola = true;
    if (kind === 'doubleTap') player.perks.doubleTap = true;
    if (kind === 'thompson') player.owned.thompson = true;
    if (kind === 'shotgun') player.owned.shotgun = true;
    if (kind === 'box') {
      if (boxResult === 1) player.owned.thompson = true;
      if (boxResult === 2) player.owned.shotgun = true;
    }
    io.to(room.code).emit('purchaseCommitted', {
      playerId: socket.id, kind, doorIndex, price, weaponIndex, boxResult,
    });
    sendGame(room);
  });

  socket.on('worldSnapshot', snapshot => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || ctx.room.hostId !== socket.id || !ctx.room.game.started || !snapshot) return;
    const { room } = ctx;
    // The gameplay cap limits living zombies, but dead ragdolls remain in the
    // host's snapshot briefly. Allow those alongside the living cap instead of
    // dropping the entire world update and leaving guests with stale zombies.
    if (!Array.isArray(snapshot.zombies) || snapshot.zombies.length > 64) return;
    const allowed = new Set(['window', 'tear', 'enter', 'vault', 'chase', 'dying']);
    const seen = new Set();
    const incoming = [];
    for (const z of snapshot.zombies) {
      if (!z || typeof z.id !== 'string' || z.id.length > 80 || seen.has(z.id)) continue;
      if (![z.x, z.y, z.z, z.yaw, z.hp].every(Number.isFinite) || !allowed.has(z.state)) continue;
      seen.add(z.id);
      const previous = room.game.zombies.find(old => old.id === z.id);
      const current = {
        id: z.id, x: clamp(z.x, -100, 100), y: clamp(z.y, -5, 20),
        z: clamp(z.z, -100, 100), yaw: z.yaw,
        hp: clamp(z.hp, 0, 100000), state: z.state,
        phase: finite(z.phase), gait: typeof z.gait === 'string' ? z.gait.slice(0, 16) : 'shamble',
        speed: clamp(finite(z.speed, 1), 0, 10), seed: finite(z.seed),
        window: Number.isInteger(z.window) ? clamp(z.window, -1, 20) : -1,
        headTilt: finite(z.headTilt), headDrop: finite(z.headDrop),
      };
      // A host snapshot that was in flight before a server hit cannot undo it.
      if (previous && finite(snapshot.revision, -1) < room.game.revision) {
        current.hp = previous.hp;
        current.state = previous.state;
      }
      incoming.push(current);
    }
    room.game.zombies = incoming;
    room.game.started = true;
    room.game.round = clamp(Math.floor(finite(snapshot.round, room.game.round)), 0, 1000);
    room.game.roundActive = !!snapshot.roundActive;
    room.game.toSpawn = clamp(Math.floor(finite(snapshot.toSpawn, room.game.toSpawn)), 0, 10000);
    room.game.nextRoundIn = clamp(finite(snapshot.nextRoundIn, room.game.nextRoundIn), 0, 60);
    if (Array.isArray(snapshot.windowBoards) && snapshot.windowBoards.length <= 32) {
      room.game.windowBoards = snapshot.windowBoards.slice(0, 32).map(w => ({
        boards: clamp(Math.floor(finite(w && w.boards)), 0, 4),
        pending: clamp(Math.floor(finite(w && w.pending)), 0, 4),
      }));
    }
    sendGame(room);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
