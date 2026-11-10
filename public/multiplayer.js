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
  const remote = {};               // id → { group, target, label, active }

  // ------------------------------------------------------------------
  //  1) КНОПКА «ИГРАТЬ» → выбор режима
  //  Перехватываем клик (capture) ДО основного обработчика игры.
  //  Пока игра не начата (menuOn) — показываем выбор режима. В паузе пропускаем как раньше.
  // ------------------------------------------------------------------
  bPlay.addEventListener('click', e => {
    if (bypass || !menuOn) return;
    e.stopImmediatePropagation();
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
  $('bLeave').onclick = () => { socket.emit('leaveRoom'); clearRemote(); roomCode = null; setView('mp'); };

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
      clearRemote();
      Object.values(players).forEach(p => { if (p.id !== selfId) createAvatar(p); });
      setView('lobby');
    });
    socket.on('lobby', renderLobby);
    socket.on('playerJoined', p => { if (p.id !== selfId && !remote[p.id]) createAvatar(p); });
    socket.on('playerLeft', removeAvatar);
    socket.on('playerMoved', d => {
      const r = remote[d.id]; if (!r) return;
      if (!r.active) { r.active = true; r.group.position.set(d.x, d.y - EYE_HEIGHT, d.z); }   // первое появление — без «пролёта»
      r.target = { x: d.x, y: d.y, z: d.z, yaw: d.yaw };
    });
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

  addEventListener('mousedown', e => {
    if (e.button === 0 && mode === 'multi' && socket && roomCode && !menuOn && controls.isLocked) socket.emit('shoot');
  });

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
    group.add(makeLabel(p.name));
    group.visible = false;                            // покажем, когда игрок реально войдёт в игру
    scene.add(group);
    remote[p.id] = { group, active: false, target: { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0 } };
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

  window.MP = { get socket() { return socket; }, remote };
})();
