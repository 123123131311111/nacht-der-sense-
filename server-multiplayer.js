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
const UPG_PRICE = 5500, UPG_MS = 4200;   // Улучшайзер (Verrückt): цена и время анимации — как на клиенте
const DROP_CHANCE = 0.02, DP_CHANCE = 0.01, DROP_LIFE_MS = 32000, DP_MS = 25000;   // бонусы при убийстве зомби: MAX AMMO (2%) и DOUBLE POINTS (1%, x2 очки на 25 с)
const rooms = Object.create(null);
const roomOf = Object.create(null);

const WEAPONS = [
  { body: 50, head: 100, interval: 150, pellets: 1 },
  { body: 75, head: 150, interval: 75, pellets: 1 },
  { body: 60, head: 120, interval: 850, pellets: 8 },
  { body: 150, head: 300, interval: 550, pellets: 1 },
  { body: 250, head: 500, interval: 280, pellets: 1 },
  { body: 865, head: 865, interval: 420, pellets: 24 },
  { body: 110, head: 220, interval: 100, pellets: 1 },
  { body: 95, head: 190, interval: 90, pellets: 1 },   // M16A1 (только Mystery Box)
  { body: 55, head: 110, interval: 140, pellets: 2 },  // двойные пистолеты (только Mystery Box): 2 пули за выстрел
  { body: 85, head: 170, interval: 100, pellets: 1 },  // MP40 (только Mystery Box)
  { body: 105, head: 210, interval: 85, pellets: 1 },  // STG-44 (только Mystery Box)
];
// Всё, что привязано к карте. Порядок дверей и окон ОБЯЗАН совпадать с клиентом (index.html).
// windows: [x, z, y] — центр окна на стене и высота глаз игрока на этом этаже.
// Игрок «рядом», если он в радиусе 2.7 м по XZ и по высоте y ± 1.6.
// perks: x, z — позиция автомата; minY/maxY — допустимая высота игрока (этаж).
// box: x, z — точка у ящика (как на клиенте: BOX_HALL + половина глубины); available(doors) — когда ящик уже в зале.
const MAPS = {
  nacht: {
    doors: [
      { x: -9.5, z: 4 }, { x: 4, z: -4 }, { x: -3, z: 4 },
      { x: 10, z: -2 }, { x: 7, z: 1 },
    ],
    windows: [
      [-8, -15, 1.7], [5, -15, 1.7], [-8, -15, 5.7], [5, -15, 5.7],
      [-12, 15, 1.7], [-7, 15, 1.7], [-2, 15, 5.7], [6, 15, 5.7],
      [-15, -5.5, 1.7], [-15, 7, 5.7], [15, -2, 1.7], [15, 4, 5.7],
    ],
    wall: { thompson: { x: -14.7, z: 10 }, shotgun: { x: -14.7, z: -11.5 } },
    box: { x: 0.3, z: -13.25, available: dr => !!(dr[0] || dr[2] || dr[4]) },
    perks: {
      cola: { x: -14.25, z: 7, minY: -1, maxY: 3.2 },
      doubleTap: { x: -12, z: -14.25, minY: 3.2, maxY: 7.5 },
      juggernog: { x: -14.25, z: 2, minY: 3.2, maxY: 7.5 },
    },
  },
  verruckt: {
    doors: [{ x: -9, z: -2.35 }, { x: 9, z: -2.35 }],   // платный вход на 2 этаж: левый и правый корпус (порядок как в VK_DOORS на клиенте)
    windows: [],
    wall: { thompson: { x: 31.85, z: 0 }, shotgun: { x: 0, z: 31.85 } },
    box: { x: 0, z: -9.3, available: () => true },
    levers: [{ x: -16.3, z: 2.4 }, { x: 16.3, z: 2.4 }],   // рубильники на 2 этаже корпусов (как LEVERS на клиенте)
    upgrader: { x: 30.9, z: -27.6 },   // Улучшайзер в северо-восточном углу двора (как UPG на клиенте)
    perks: {
      cola: { x: -7.2, z: 3.2, minY: 3.2, maxY: 7.5 },
      doubleTap: { x: 8.4, z: 3, minY: 3.2, maxY: 7.5 },
      juggernog: { x: 1000, z: 1000, minY: 3.2, maxY: 7.5 },
    },
  },
};
const mapOf = id => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAPS, id)) ? id : 'nacht';   // белый список, неизвестная карта = nacht
const cfgOf = room => MAPS[room.map];

// no-cache: браузер каждый раз проверяет (ETag), поэтому новые звуки/скрипты сразу доходят до всех игроков
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
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
    x: 0, y: 1.7, z: 0, yaw: 0, pitch: 0, active: false, downed: false, reviving: null,
    points: 500, hp: 100, perks: { cola: false, doubleTap: false, juggernog: false },
    owned: { thompson: false, shotgun: false }, upg: Object.create(null), shots: Object.create(null), lastShotAt: -Infinity,
  };
}
function makeRoom(code, hostId, map) {
  const cfg = MAPS[map];
  return {
    code, hostId, map, players: Object.create(null),
    game: {
      started: false, round: 0, roundActive: false, toSpawn: 0, nextRoundIn: 0,
      doors: cfg.doors.map(() => false),
      levers: [false, false], upgBusyUntil: 0,
      windowBoards: cfg.windows.map(() => ({ boards: 4, pending: 0 })), zombies: [],
      revision: 0, boxBusyUntil: 0, drops: [], dropSeq: 0,
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
    levers: (game.levers || []).slice(),
    windowBoards: game.windowBoards,
    // Keep the network snapshot gameplay-only. Animation and model variation
    // are generated independently by each client.
    zombies: game.zombies.map(({ id, x, y, z, vx, vy, vz, speed, yaw, moving, attacking, attackKind, hp, state }) => ({
      id, x, y, z, vx, vy, vz, speed, yaw, moving, attacking, attackKind, hp, state,
    })),
    revision: game.revision,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch, active: p.active, points: p.points, hp: p.hp, downed: !!p.downed,
      perks: { ...p.perks },
      upg: { ...p.upg },
    })),
  };
}
function sendGame(room) { io.to(room.code).emit('gameState', gamePayload(room)); }
function sendLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code, hostId: room.hostId, map: room.map,
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
    selfId: socket.id, code: room.code, slot, map: room.map, hostId: room.hostId,
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
  { const act = Object.values(room.players).filter(p => p.active); if (room.game.started && act.length && act.every(p => p.downed)) io.to(code).emit('teamWipe'); }
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
  return player.active && !player.downed && player.y >= minY && player.y <= maxY &&
    Math.hypot(player.x - x, player.z - z) <= radius;
}
function failPurchase(socket, message) { socket.emit('purchaseRejected', message); }

io.on('connection', socket => {
  socket.on('createRoom', ({ name, map } = {}) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = rooms[code] = makeRoom(code, socket.id, mapOf(map));
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
    if (!player.active) player.downed = false;
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
    if (!ctx || !ctx.room.game.started || !ctx.player.active || ctx.player.downed) return;
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
        (shot.weapon !== 2 && shot.weapon !== 8 && shot.hitIds.has(zombieId))) return;
    const zombie = room.game.zombies.find(z => z.id === zombieId);
    if (!zombie || zombie.state === 'dying' || !(shot.weapon === -1 || WEAPONS[shot.weapon])) return;
    shot.hits++;
    if (shot.weapon !== 2 && shot.weapon !== 8) shot.hitIds.add(zombieId);
    const weapon = shot.weapon === -1
      ? (room.game.round <= 3 ? { body: 100000, head: 100000 } : { body: Math.max(10, 150 * Math.pow(0.8, room.game.round - 3)), head: Math.max(10, 150 * Math.pow(0.8, room.game.round - 3)) })   // нож: до 3 раунда с 1 удара, дальше слабее
      : WEAPONS[shot.weapon];
    const damage = (head ? weapon.head : weapon.body) * (player.perks.doubleTap ? 2 : 1) * (player.upg && player.upg[shot.weapon] ? 2 : 1);   // улучшенное оружие: урон x2
    zombie.hp = Math.max(0, zombie.hp - damage);
    const killed = zombie.hp <= 0;
    if (killed) zombie.state = 'dying';
    const reward = (killed ? (shot.weapon === -1 ? 120 : (head ? 100 : 60)) : 10) * ((room.game.dpUntil || 0) > Date.now() ? 2 : 1);   // Double Points действует на всю комнату
    player.points += reward;
    let drop = null;
    if (killed) {
      const now = Date.now();
      room.game.drops = room.game.drops.filter(d => now - d.at < DROP_LIFE_MS);
      const roll = Math.random(), kind = roll < DROP_CHANCE ? 'ammo' : (roll < DROP_CHANCE + DP_CHANCE ? 'double' : null);
      if (kind) {
        drop = { id: `d${++room.game.dropSeq}`, kind, x: clamp(finite(zombie.x), -30, 30), y: finite(zombie.y), z: clamp(finite(zombie.z), -30, 30) };
        room.game.drops.push({ ...drop, at: now });
      }
    }
    room.game.revision++;
    io.to(room.code).emit('zombieHit', {
      zombieId, head: !!head, hp: zombie.hp, state: zombie.state,
      killed, shooterId: socket.id, points: player.points, reward, drop, revision: room.game.revision,
    });
    sendGame(room);
  });

  // подбор MAX AMMO: сервер проверяет, что бонус ещё лежит и игрок рядом; патроны получают все игроки комнаты
  socket.on('pickupDrop', ({ id } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || typeof id !== 'string') return;
    const { room, player } = ctx, now = Date.now();
    room.game.drops = room.game.drops.filter(d => now - d.at < DROP_LIFE_MS);
    const i = room.game.drops.findIndex(d => d.id === id);
    if (i < 0) return;
    const d = room.game.drops[i];
    if (!near(player, d.x, d.z, 2.4, d.y - 0.6, d.y + 3.4)) return;
    room.game.drops.splice(i, 1);
    if (d.kind === 'double') { room.game.dpUntil = now + DP_MS; io.to(room.code).emit('doublePoints', { duration: DP_MS / 1000, playerId: socket.id }); }
    io.to(room.code).emit('dropPicked', { id, playerId: socket.id, kind: d.kind || 'ammo' });
  });

  socket.on('zombieAttack', ({ playerId, zombieId } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || ctx.room.hostId !== socket.id || !ctx.room.game.started ||
        typeof playerId !== 'string' || typeof zombieId !== 'string') return;
    const room = ctx.room;
    const target = room.players[playerId];
    const zombie = room.game.zombies.find(z => z.id === zombieId);
    if (!target || !target.active || target.downed || !zombie || zombie.state === 'dying') return;
    const now = Date.now();
    if (now - (zombie.lastAttackAt || 0) < 450 ||
        Math.hypot(target.x - zombie.x, target.z - zombie.z) > 1.8 ||
        Math.abs((target.y - 1.7) - zombie.y) > 1.8) return;
    zombie.lastAttackAt = now;
    io.to(playerId).emit('playerHurt', { playerId, zombieId, damage: 25 });
  });

  // ---- повален / поднятие союзником (3 с) ----
  function checkWipe(room) {
    const act = Object.values(room.players).filter(p => p.active);
    if (room.game.started && act.length && act.every(p => p.downed)) io.to(room.code).emit('teamWipe');
  }
  socket.on('playerDowned', () => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !ctx.room.game.started || !ctx.player.active || ctx.player.downed) return;
    ctx.player.downed = true; ctx.player.reviving = null;
    io.to(ctx.room.code).emit('playerDowned', { id: socket.id });
    checkWipe(ctx.room);
  });
  socket.on('reviveStart', ({ targetId } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || ctx.player.downed || typeof targetId !== 'string') return;
    ctx.player.reviving = { targetId, at: Date.now() };
  });
  socket.on('reviveDone', ({ targetId } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || ctx.player.downed || !ctx.player.active || typeof targetId !== 'string') return;
    const { room, player } = ctx, target = room.players[targetId], rv = player.reviving;
    if (!target || !target.downed || !rv || rv.targetId !== targetId || Date.now() - rv.at < 2700) return;
    if (Math.hypot(player.x - target.x, player.z - target.z) > 2.8 || Math.abs(player.y - target.y) > 1.8) return;
    player.reviving = null; target.downed = false;
    io.to(room.code).emit('playerRevived', { id: targetId, by: socket.id });
  });

  socket.on('windowBoardAction', ({ action, index } = {}) => {
    const ctx = roomAndPlayer(socket);
    index = Number(index);
    if (!ctx || !ctx.room.game.started || action !== 'repair' || !Number.isInteger(index) || !cfgOf(ctx.room).windows[index]) return;
    const [x, z, y] = cfgOf(ctx.room).windows[index];
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
    const cfg = cfgOf(room);
    let price = 0, weaponIndex = null, boxResult = null;
    const floor = player.y;
    if (kind === 'door') {
      doorIndex = Number(doorIndex);
      const door = cfg.doors[doorIndex];
      if (!door || room.game.doors[doorIndex]) return failPurchase(socket, 'Эта дверь уже открыта');
      if (!near(player, door.x, door.z, 3.2, -1, 3.2)) return failPurchase(socket, 'Подойдите ближе к двери');
      price = 1000;
    } else if (kind === 'cola') {
      const pk = cfg.perks.cola;
      if (!near(player, pk.x, pk.z, 2.8, pk.minY, pk.maxY)) return failPurchase(socket, 'Подойдите к автомату Speed Cola');
      if (player.perks.cola) return failPurchase(socket, 'Speed Cola уже куплено');
      price = 4000;
    } else if (kind === 'doubleTap') {
      const pk = cfg.perks.doubleTap;
      if (!near(player, pk.x, pk.z, 2.8, pk.minY, pk.maxY)) return failPurchase(socket, 'Подойдите к автомату Double Tap');
      if (player.perks.doubleTap) return failPurchase(socket, 'Double Tap уже куплено');
      price = 2500;
    } else if (kind === 'juggernog') {
      const pk = cfg.perks.juggernog;
      if (!near(player, pk.x, pk.z, 2.8, pk.minY, pk.maxY)) return failPurchase(socket, 'Подойдите к автомату Джагер Фанта');
      if (player.perks.juggernog) return failPurchase(socket, 'Джагер Фанта уже куплено');
      price = 2000;
    } else if (kind === 'thompson' || kind === 'shotgun') {
      const shotgun = kind === 'shotgun';
      const owned = shotgun ? player.owned.shotgun : player.owned.thompson;
      const pos = shotgun ? cfg.wall.shotgun : cfg.wall.thompson;
      if (!near(player, pos.x, pos.z, 3, -1, 3.2)) return failPurchase(socket, 'Подойдите к стене с оружием');
      price = shotgun ? (owned ? 600 : 1200) : (owned ? 500 : 1000);
      weaponIndex = shotgun ? 2 : 1;
    } else if (kind === 'box') {
      // в стартовой комнате ящика нет: он появляется в центральном зале после открытия двери (как на клиенте)
      const boxPos = cfg.box;
      if (!boxPos.available(room.game.doors)) return failPurchase(socket, 'Mystery Box пока недоступен');
      if (!near(player, boxPos.x, boxPos.z, 3.5, -1, 3.2)) return failPurchase(socket, 'Подойдите к Mystery Box');
      if (room.game.boxBusyUntil > Date.now()) return failPurchase(socket, 'Mystery Box уже используется');
      price = 950;
      boxResult = 1 + Math.floor(Math.random() * 10);
    } else return failPurchase(socket, 'Неизвестная покупка');
    if (player.points < price) return failPurchase(socket, 'Не хватает очков');
    player.points -= price;
    if (kind === 'box') room.game.boxBusyUntil = Date.now() + 3800;
    if (kind === 'door') room.game.doors[doorIndex] = true;
    if (kind === 'cola') player.perks.cola = true;
    if (kind === 'doubleTap') player.perks.doubleTap = true;
    if (kind === 'juggernog') player.perks.juggernog = true;
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

  // ---------- Verrückt: рубильники и Улучшайзер ----------
  socket.on('leverRequest', ({ index } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !ctx.room.game.started) return;
    const { room, player } = ctx, cfg = cfgOf(room);
    index = Number(index);
    const lv = cfg.levers && cfg.levers[index];
    if (!lv || room.game.levers[index]) return;
    if (!near(player, lv.x, lv.z, 3.2, 3.2, 7.5)) return failPurchase(socket, 'Подойдите к рубильнику');
    room.game.levers[index] = true;
    io.to(room.code).emit('leverToggled', { index, playerId: socket.id });
    sendGame(room);
  });
  socket.on('upgradeRequest', ({ weapon } = {}) => {
    const ctx = roomAndPlayer(socket);
    if (!ctx || !ctx.room.game.started) return;
    const { room, player } = ctx, up = cfgOf(room).upgrader;
    if (!up) return failPurchase(socket, 'Улучшайзера нет на этой карте');
    if (!room.game.levers.every(Boolean)) return failPurchase(socket, 'Сначала включите оба рубильника');
    weapon = Number(weapon);
    if (!Number.isInteger(weapon) || weapon < 0 || weapon >= WEAPONS.length) return;
    if (player.upg[weapon]) return failPurchase(socket, 'Это оружие уже улучшено');
    if (!near(player, up.x, up.z, 3.4, -1, 3.2)) return failPurchase(socket, 'Подойдите к Улучшайзеру');
    if ((room.game.upgBusyUntil || 0) > Date.now()) return failPurchase(socket, 'Улучшайзер занят');
    if (player.points < UPG_PRICE) return failPurchase(socket, 'Не хватает очков');
    player.points -= UPG_PRICE; player.upg[weapon] = true; room.game.upgBusyUntil = Date.now() + UPG_MS;
    io.to(room.code).emit('upgradeStarted', { playerId: socket.id, weapon, duration: UPG_MS / 1000, price: UPG_PRICE });
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
    const now = Date.now();
    for (const z of snapshot.zombies) {
      if (!z || typeof z.id !== 'string' || z.id.length > 80 || seen.has(z.id)) continue;
      if (![z.x, z.y, z.z, z.hp].every(Number.isFinite) || !allowed.has(z.state)) continue;
      seen.add(z.id);
      const previous = room.game.zombies.find(old => old.id === z.id);
      const x = clamp(z.x, -100, 100);
      const y = clamp(z.y, -5, 20);
      const zz = clamp(z.z, -100, 100);
      const elapsed = previous && previous.updatedAt
        ? clamp((now - previous.updatedAt) / 1000, 0.05, 0.5) : 0.1;
      const current = {
        id: z.id, x, y, z: zz,
        vx: previous ? clamp((x - previous.x) / elapsed, -12, 12) : 0,
        vy: previous ? clamp((y - previous.y) / elapsed, -12, 12) : 0,
        vz: previous ? clamp((zz - previous.z) / elapsed, -12, 12) : 0,
        yaw: Number.isFinite(z.yaw)
          ? Math.atan2(Math.sin(z.yaw), Math.cos(z.yaw))
          : (previous ? previous.yaw : 0),
        moving: typeof z.moving === 'boolean' ? z.moving : !!(previous && previous.moving),
        attacking: z.attacking === true,
        attackKind: Number.isInteger(z.attackKind) && z.attackKind >= 0 && z.attackKind <= 3
          ? z.attackKind : (previous ? previous.attackKind : 0),
        speed: clamp(finite(z.speed, previous ? previous.speed : 1), 0, 10),
        hp: clamp(z.hp, 0, 100000), state: z.state,
        updatedAt: now,
        lastAttackAt: previous ? previous.lastAttackAt || 0 : 0,
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
