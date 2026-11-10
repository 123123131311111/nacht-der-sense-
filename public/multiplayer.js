// =====================================================================
//  multiplayer.js — выбор режима, лобби и синхронизация игроков
//  Подключается ПОСЛЕ основного скрипта игры. Использует его глобальные
//  переменные: scene, camera, controls, pos, SPAWN, colliders, menuOn, menuEl, bPlay.
// =====================================================================
(function () {
  if (typeof io === 'undefined') { console.warn('[MP] socket.io не загружен — доступна только одиночная игра'); return; }

  // Если игра открыта с самого сервера — оставь пусто. Если клиент отдельно (GitHub Pages) — URL сервера.
  const SERVER_URL = '';
  const EYE_HEIGHT = 1.7, SEND_RATE = 20;
  const $ = id => document.getElementById(id);
  const setView = v => { menuEl.dataset.view = v; };

  let socket = null;               // создаётся только когда игрок выбрал мультиплеер
  let mode = 'solo';               // 'solo' | 'multi'
  let selfId = null, mySlot = 0, roomCode = null, hostId = null, entered = false, bypass = false;
  let gameState = null, worldRevision = 0, shotSeq = 0;
  const remote = {};               // id → { group, target, label, active }

  // ------------------------------------------------------------------
  //  1) КНОПКА «ИГРАТЬ» → выбор режима
  //  Перехватываем клик (capture) ДО основного обработчика игры.
  //  Пока игра не начата (menuOn) — показываем выбор режима. В паузе пропускаем как раньше.
  // ------------------------------------------------------------------
  bPlay.addEventListener('click', e => {
    if (bypass || !menuOn) return;
    e.stopImmediatePropagation();
    if (mode === 'multi' && roomCode && gameState && gameState.started) {
      startGame();
      return;
    }
    setView('mode');
  }, true);

  function startGame() {           // запускаем штатный старт игры (внутри пользовательского клика)
    bypass = true; bPlay.click(); bypass = false;
  }

  $('bSolo').onclick = () => { mode = 'solo'; startGame(); };
  $('bModeBack').onclick = () => setView('main');
  $('bMulti').onclick = () => { mode = 'multi'; connect(); setView('mp'); };
  $('bMpBack').onclick = () => setView('mode');

  const nameInput = $('mpName');
  try { nameInput.value = localStorage.getItem('nb_name') || ''; } catch (e) {}
  const myName = () => { const n = nameInput.value.trim(); try { localStorage.setItem('nb_name', n); } catch (e) {} return n; };
  const showErr = t => { $('mpErr').textContent = t || ''; };

  $('bCreate').onclick = () => { showErr(); socket.emit('createRoom', { name: myName() }); };
  $('bJoin').onclick = () => { showErr(); socket.emit('joinRoom', { code: $('mpCode').value, name: myName() }); };
  $('bGo').onclick = () => startGame();
  $('bLeave').onclick = () => { socket.emit('leaveRoom'); clearRemote(); roomCode = null; gameState = null; setView('mp'); };

  // ------------------------------------------------------------------
  //  2) ПОДКЛЮЧЕНИЕ К СЕРВЕРУ (только при выборе «Мультиплеер»)
  // ------------------------------------------------------------------
  function connect() {
    if (socket) { if (!socket.connected) socket.connect(); return; }
    socket = SERVER_URL ? io(SERVER_URL) : io();

    socket.on('connect_error', () => showErr('Нет связи с сервером (на бесплатном Render он может просыпаться ~1 мин)'));
    socket.on('connect', () => { selfId = socket.id; showErr(); });
    socket.on('disconnect', () => { clearRemote(); roomCode = null; if (menuOn) { setView('mp'); showErr('Соединение потеряно'); } });
    socket.on('joinError', showErr);

    // Мы вошли в лобби.
    socket.on('joined', ({ selfId: id, code, slot, players }) => {
      selfId = id; roomCode = code; mySlot = slot; entered = false;
      gameState = null; worldRevision = 0;
      clearRemote();
      Object.values(players).forEach(p => { if (p.id !== selfId) createAvatar(p); });
      setView('lobby');
    });
    socket.on('lobby', renderLobby);
    socket.on('playerJoined', p => { if (p.id !== selfId && !remote[p.id]) createAvatar(p); });
    socket.on('playerLeft', removeAvatar);
    socket.on('gameState', receiveGameState);
    socket.on('zombieHit', applyNetworkHit);
    socket.on('playerHurt', hit => {
      if (!hit || hit.playerId !== selfId || !Number.isFinite(hit.damage)) return;
      if (typeof hurtPlayer === 'function') hurtPlayer(hit.damage);
    });
    socket.on('purchaseCommitted', applyNetworkPurchase);
    socket.on('windowBoardAction', action => {
      if (!action || action.actorId === selfId || action.action !== 'repair') return;
      const w = windows[action.index];
      if (w) repairBoard(w);
    });
    socket.on('purchaseRejected', message => {
      if (typeof pop === 'function') pop(message || 'Покупка отклонена', 'neg');
    });
    socket.on('playerShot', shot => {
      if (!shot || shot.id === selfId) return;
      if (typeof shotSnd === 'function') shotSnd(shot.weapon);
      const player = remote[shot.id];
      if (player && player.muzzleLight) {
        player.muzzleLight.color.setHex(shot.weapon === 5 ? 0x45ff64 : 0xffa030);
        player.muzzleLight.intensity = 2.5;
        setTimeout(() => { if (player.muzzleLight) player.muzzleLight.intensity = 0; }, 90);
      }
      showShotTrace(shot);
    });
    socket.on('playerMoved', d => {
      if (gameState && gameState.players) {
        const p = gameState.players.find(player => player.id === d.id);
        if (p) Object.assign(p, d, { active: true });
      }
      const r = remote[d.id]; if (!r) return;
      if (!r.active) { r.active = true; r.group.position.set(d.x, d.y - EYE_HEIGHT, d.z); }   // первое появление — без «пролёта»
      r.target = { x: d.x, y: d.y, z: d.z, yaw: d.yaw };
    });
  }

  function receiveGameState(state) {
    if (!state) return;
    gameState = state;
    hostId = state.hostId || hostId;
    worldRevision = Number.isFinite(state.revision) ? state.revision : worldRevision;
    if (state.started && mode === 'multi' && roomCode && !entered && !window.MP.isAuthority) {
      enterHostStartedGame();
    }
    if (Array.isArray(state.players)) {
      state.players.forEach(p => {
        if (p.id === selfId) {
          if (typeof p.points === 'number') { points = p.points; updatePoints(); }
          if (p.perks) {
            if (p.perks.cola && !speedCola) { speedCola = true; perkMsg('cola'); }
            if (p.perks.doubleTap && !doubleTap) { doubleTap = true; perkMsg('dtap'); }
          }
        } else {
          const r = remote[p.id];
          if (r && p.active) {
            r.active = true;
            r.target = { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
          }
        }
      });
    }
    if (Array.isArray(state.doors)) {
      state.doors.forEach((open, i) => {
        if (open && DOORS[i] && !DOORS[i].open) openDoor(DOORS[i]);
      });
    }
    if (state.started) {
      started = true;
      const previousRound = round;
      round = state.round || round;
      roundActive = !!state.roundActive;
      toSpawn = state.toSpawn || 0;
      roundEl.textContent = round ? 'ROUND ' + round : '';
      if (typeof state.nextRoundIn === 'number') nextRoundAt = gtime + state.nextRoundIn;
      if (round > previousRound && entered && !menuOn) {
        annEl.textContent = 'ROUND ' + round;
        annEl.classList.remove('go'); void annEl.offsetWidth; annEl.classList.add('go');
        sfx('round');
      }
      interEl.textContent = roundActive ? '' : `ROUND ${round + 1} IN ${Math.ceil(state.nextRoundIn || 0)}`;
      if (!window.MP.isAuthority && entered && !menuOn) {
        if (Array.isArray(state.zombies)) applyNetworkZombies(state.zombies);
        if (Array.isArray(state.windowBoards)) applyNetworkWindows(state.windowBoards);
      }
    }
  }

  function enterHostStartedGame() {
    if (entered || !roomCode) return;
    entered = true;
    placeAtSpawn();
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      // A guest must never keep menu/solo zombies alongside the host's world.
      if (z.mpId) continue;
      scene.remove(z.g);
      z.mats.forEach(m => m.dispose());
      zombies.splice(i, 1);
    }
    menuOn = false;
    document.body.classList.remove('menu');
    document.body.classList.add('playing');
    setView('main');
    infoMsg.textContent = 'Хост запустил игру — нажмите «В ИГРУ», чтобы управлять';
    $('bPlay').textContent = '▶ В ИГРУ';
    info.style.display = 'flex';
    sendMove(true);
  }

  function applyNetworkWindows(states) {
    states.forEach((target, i) => {
      const w = windows[i];
      if (!w || !target) return;
      const total = Math.max(0, Math.min(4, (target.boards | 0) + (target.pending | 0)));
      let current = w.boards.length + w.pending.length;
      while (current > total && w.boards.length) { tearBoard(w); current--; }
      while (current < total && repairBoard(w)) current++;
    });
  }

  const NETWORK_CORPSE_HIDE_MS = 2200;
  function scheduleNetworkCorpseHide(z) {
    if (!z || z.networkCorpseTimer) return;
    z.networkCorpseTimer = setTimeout(() => {
      z.networkCorpseTimer = null;
      if (z.state === 'dying' && zombies.includes(z)) z.g.visible = false;
    }, NETWORK_CORPSE_HIDE_MS);
  }

  function applyNetworkZombies(list) {
    const received = new Set();
    const keep = new Set();
    for (const data of list) {
      if (!data || typeof data.id !== 'string' || received.has(data.id) ||
          ![data.x, data.y, data.z].every(Number.isFinite)) continue;
      received.add(data.id);
      let z = zombies.find(item => item.mpId === data.id);
      if (!z) {
        z = spawnZombie({ x: data.x, y: data.y, z: data.z }, true);
        z.mpId = data.id;
        z.g.position.set(data.x, data.y, data.z);
        z.networkRemote = true;
      }
      keep.add(z);
      z.networkTarget = {
        x: data.x, y: data.y, z: data.z,
        vx: Number.isFinite(data.vx) ? data.vx : 0,
        vy: Number.isFinite(data.vy) ? data.vy : 0,
        vz: Number.isFinite(data.vz) ? data.vz : 0,
        speed: Number.isFinite(data.speed) ? data.speed : z.speed,
        receivedAt: performance.now(),
      };
      if (Number.isFinite(data.hp)) z.hp = data.hp;
      // Only gameplay state is shared. Gait, pose, head details and timing
      // stay local so the same zombie can look different on every machine.
      if (typeof data.state === 'string') z.state = data.state;
      z.menu = false;
      if (z.state === 'dying') scheduleNetworkCorpseHide(z);
      if (z.state === 'dying' && !z.rd) {
        z.dt = 0;
        z.eyes.forEach(e => e.visible = false);
        startRagdoll(z, false, 0);
      }
    }
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      // The host snapshot is the complete zombie list for guests. Remove any
      // local/menu zombie as well as stale network replicas.
      if (keep.has(z)) continue;
      if (z.networkCorpseTimer) clearTimeout(z.networkCorpseTimer);
      scene.remove(z.g);
      z.mats.forEach(m => m.dispose());
      zombies.splice(i, 1);
    }
  }

  function applyNetworkHit(hit) {
    if (!hit || !Array.isArray(zombies)) return;
    worldRevision = Number.isFinite(hit.revision) ? hit.revision : worldRevision;
    const z = zombies.find(item => item.mpId === hit.zombieId);
    if (z) {
      const wasAlive = z.state !== 'dying';
      z.hp = hit.hp;
      z.flash = 1;
      z.stagger = 0.2;
      if (hit.state === 'dying' && wasAlive) {
        z.state = 'dying'; z.dt = 0;
        z.eyes.forEach(e => e.visible = false);
        startRagdoll(z, !!hit.head, 0);
        scheduleNetworkCorpseHide(z);
        if (typeof kills === 'number') kills++;
      }
      const dir = new THREE.Vector3(0, 0, 1);
      bloodHit(new THREE.Vector3(z.g.position.x, z.g.position.y + 1.1, z.g.position.z), dir, !!hit.head, false);
    }
  }

  function applyNetworkPurchase(event) {
    if (!event) return;
    const own = event.playerId === selfId;
    if (event.kind === 'door' && DOORS[event.doorIndex] && !DOORS[event.doorIndex].open) {
      openDoor(DOORS[event.doorIndex]);
    } else if (event.kind === 'box') {
      boxStart(event.boxResult, own);
    } else if (own && event.kind === 'cola') {
      speedCola = true; perkMsg('cola');
    } else if (own && event.kind === 'doubleTap') {
      doubleTap = true; perkMsg('dtap');
    } else if (own && event.kind === 'thompson') {
      const w = WEAPONS[1];
      w.mag = w.magSize; w.reserve = w.maxReserve - w.magSize;
      if (!w.own) equip(1); else updateHUD();
      sfx('buy');
    } else if (own && event.kind === 'shotgun') {
      const w = WEAPONS[2];
      w.mag = w.magSize; w.reserve = w.maxReserve - w.magSize;
      if (!w.own) equip(2); else updateHUD();
      sfx('buy');
    }
    if (!own && event.kind !== 'door' && event.kind !== 'box' && typeof pop === 'function') {
      const p = gameState && gameState.players && gameState.players.find(item => item.id === event.playerId);
      pop((p ? p.name : 'Игрок') + ' совершил покупку', 'head');
    }
  }

  function publishWorld(snapshot) {
    if (!socket || !socket.connected || !roomCode || !window.MP.isAuthority) return;
    socket.emit('worldSnapshot', { ...snapshot, revision: worldRevision });
  }

  function registerShot(weapon) {
    if (!socket || !socket.connected || !roomCode || !window.MP.active) return null;
    const shotId = `${selfId}:${++shotSeq}`;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    socket.emit('shoot', { shotId, weapon, yaw: euler.y, pitch: euler.x });
    return shotId;
  }

  function requestPurchase(kind, doorIndex) {
    if (!socket || !socket.connected || !roomCode) return false;
    socket.emit('purchaseRequest', { kind, doorIndex });
    return true;
  }

  function requestHit(zombie, head, shotId) {
    if (!socket || !socket.connected || !roomCode || !zombie || !zombie.mpId || !shotId) return;
    socket.emit('zombieHit', { zombieId: zombie.mpId, head: !!head, shotId });
  }

  function requestPlayerHit(playerId, zombieId) {
    if (!socket || !socket.connected || !roomCode || !window.MP.isAuthority ||
        typeof playerId !== 'string' || typeof zombieId !== 'string') return;
    socket.emit('zombieAttack', { playerId, zombieId });
  }

  function showShotTrace(shot) {
    if (![shot.x, shot.y, shot.z, shot.yaw, shot.pitch].every(Number.isFinite)) return;
    const c = Math.cos(shot.pitch);
    const dir = new THREE.Vector3(-Math.sin(shot.yaw) * c, Math.sin(shot.pitch), -Math.cos(shot.yaw) * c);
    const from = new THREE.Vector3(shot.x, shot.y, shot.z);
    const to = from.clone().addScaledVector(dir, shot.weapon === 5 ? 28 : 18);
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const material = new THREE.LineBasicMaterial({
      color: shot.weapon === 5 ? 0x5cff65 : 0xffd07a, transparent: true, opacity: 0.85,
    });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    setTimeout(() => { scene.remove(line); geometry.dispose(); material.dispose(); }, 110);
  }

  function renderLobby({ code, hostId: h, players }) {
    hostId = h; roomCode = code;
    $('lobCode').textContent = code;
    $('lobList').innerHTML = players.map(p =>
      `<div class="lp"><i style="background:${p.color}"></i>${esc(p.name)}${p.id === hostId ? ' <small>(хост)</small>' : ''}${p.id === selfId ? ' <small>(ты)</small>' : ''}</div>`
    ).join('') + `<div class="lc">${players.length} / 4</div>`;
  }
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------
  //  3) СПАВН: у каждого игрока своя точка рядом с SPAWN, без стен
  // ------------------------------------------------------------------
  // Свободна ли точка (x,z) — проверяем коллайдеры игры (радиус игрока 0.35).
  function freeAt(x, z) {
    const r = 0.35;
    for (const c of colliders) {
      if (c.y1 <= 0.3 || c.y0 >= EYE_HEIGHT - 0.1) continue;          // пол и потолок не мешают
      if (x > c.x0 - r && x < c.x1 + r && z > c.z0 - r && z < c.z1 + r) return false;
    }
    return true;
  }
  // Есть ли прямой проход от SPAWN к точке (чтобы не выбрать место за стеной в другой комнате).
  function reachable(x, z) {
    const n = 12;
    for (let i = 1; i <= n; i++) if (!freeAt(SPAWN.x + (x - SPAWN.x) * i / n, SPAWN.z + (z - SPAWN.z) * i / n)) return false;
    return true;
  }
  // Список спавн-точек: сетка вокруг SPAWN с шагом 1.5 м, от ближних к дальним.
  // Слот 0 получает точку 0, слот 1 — точку 1 и т.д. → у всех разные места.
  function spawnPoints() {
    const pts = [];
    for (let dx = -4.5; dx <= 4.5; dx += 1.5) for (let dz = -4.5; dz <= 4.5; dz += 1.5) {
      const x = SPAWN.x + dx, z = SPAWN.z + dz;
      if (freeAt(x, z) && reachable(x, z)) pts.push({ x, z, d: Math.hypot(dx, dz) });
    }
    pts.sort((a, b) => a.d - b.d);
    return pts;
  }
  function placeAtSpawn() {
    const pts = spawnPoints();
    const p = pts[Math.min(mySlot, pts.length - 1)] || { x: SPAWN.x, z: SPAWN.z };
    pos.set(p.x, SPAWN.y, p.z);
    camera.rotation.set(0, 0, 0);
  }

  // Стартовая точка в мультиплеере: срабатывает после штатного обработчика 'lock' игры.
  controls.addEventListener('lock', () => {
    if (mode !== 'multi' || !roomCode || entered) return;
    entered = true;
    placeAtSpawn();
    sendMove(true);                                   // сразу сообщаем остальным, где мы
    socket.emit('gameStart');
  });

  // ------------------------------------------------------------------
  //  4) ОТПРАВКА СВОИХ ДАННЫХ
  // ------------------------------------------------------------------
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  let last = { x: 1e9, y: 1e9, z: 1e9, yaw: 1e9, pitch: 1e9 };
  function sendMove(force) {
    _e.setFromQuaternion(camera.quaternion, 'YXZ');
    const cur = { x: pos.x, y: pos.y, z: pos.z, yaw: _e.y, pitch: _e.x };
    if (!force && Math.abs(cur.x - last.x) + Math.abs(cur.y - last.y) + Math.abs(cur.z - last.z) +
        Math.abs(cur.yaw - last.yaw) + Math.abs(cur.pitch - last.pitch) < 0.001) return;
    last = cur; socket.emit('move', cur);
  }
  setInterval(() => {
    if (mode === 'multi' && socket && roomCode && entered && !menuOn && controls.isLocked) sendMove(false);
  }, 1000 / SEND_RATE);

  setInterval(() => {
    if (!window.MP.active || !window.MP.isAuthority || !entered || menuOn || !controls.isLocked || !started) return;
    publishWorld({
      started: true,
      round,
      roundActive,
      toSpawn,
      nextRoundIn: Math.max(0, nextRoundAt - gtime),
      windowBoards: windows.map(w => ({ boards: w.boards.length, pending: w.pending.length })),
      zombies: zombies.filter(z => !z.menu && z.mpId).map(z => ({
        id: z.mpId,
        x: z.g.position.x, y: z.g.position.y, z: z.g.position.z,
        hp: z.hp, state: z.state, speed: z.speed,
      })),
    });
  }, 100);

  // ------------------------------------------------------------------
  //  5) АВАТАРЫ ДРУГИХ ИГРОКОВ
  // ------------------------------------------------------------------
  function makeLabel(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 32px sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(text, 128, 42);
    g.fillStyle = '#fff'; g.fillText(text, 128, 42);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
    spr.scale.set(1.6, 0.4, 1); spr.position.y = 1.95; spr.renderOrder = 10;
    return spr;
  }
  function createAvatar(p) {
    const group = new THREE.Group();                  // начало координат = ступни
    const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 12), mat); body.position.y = 0.8; group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), mat); head.position.y = 1.55; group.add(head);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    gun.position.set(0.25, 1.25, -0.4); group.add(gun);
    const muzzleLight = new THREE.PointLight(0xffa030, 0, 2);
    muzzleLight.position.set(0.25, 1.25, -0.76); group.add(muzzleLight);
    group.add(makeLabel(p.name));
    group.visible = false;                            // покажем, когда игрок реально войдёт в игру
    scene.add(group);
    remote[p.id] = { group, muzzleLight, active: false, target: { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0 } };
  }
  function removeAvatar(id) {
    const r = remote[id]; if (!r) return;
    scene.remove(r.group);
    r.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    delete remote[id];
  }
  function clearRemote() { Object.keys(remote).forEach(removeAvatar); }

  // Плавное движение чужих аватаров.
  (function smooth() {
    requestAnimationFrame(smooth);
    for (const id in remote) {
      const r = remote[id], t = r.target, g = r.group;
      if (!r.active) continue;
      g.position.x += (t.x - g.position.x) * 0.25;
      g.position.y += ((t.y - EYE_HEIGHT) - g.position.y) * 0.25;
      g.position.z += (t.z - g.position.z) * 0.25;
      let dy = t.yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); g.rotation.y += dy * 0.25;
      g.visible = !menuOn;
    }
  })();

  window.MP = {
    get socket() { return socket; },
    get active() { return mode === 'multi' && !!roomCode && !!socket && socket.connected; },
    get inMultiplayerGame() { return mode === 'multi' && entered; },
    get selfId() { return selfId; },
    get isAuthority() { return !!roomCode && !!selfId && selfId === hostId; },
    get remote() { return remote; },
    get players() {
      if (!gameState || !Array.isArray(gameState.players)) return [];
      return gameState.players.map(p => p.id === selfId
        ? { ...p, x: pos.x, y: pos.y, z: pos.z, active: entered }
        : p);
    },
    publishWorld,
    registerShot,
    requestPurchase,
    requestHit,
    requestPlayerHit,
    requestWindowRepair(index) {
      if (socket && socket.connected && roomCode) socket.emit('windowBoardAction', { action: 'repair', index });
    },
  };
})();
