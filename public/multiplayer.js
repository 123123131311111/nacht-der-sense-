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

  setTimeout(function resume() {
    let r = null, code = null;
    try { r = sessionStorage.getItem('nb-resume'); code = sessionStorage.getItem('nb-rejoin'); sessionStorage.removeItem('nb-resume'); sessionStorage.removeItem('nb-rejoin'); } catch (e) {}
    if (r === 'solo') { mode = 'solo'; setView('maps'); }
    else if (r === 'multi') { mode = 'multi'; connect(); setView('mp'); }
    else if (r === 'rejoin' && code) { mode = 'multi'; connect(); setView('mp'); const go = () => socket.emit('joinRoom', { code, name: myName() }); socket.connected ? go() : socket.once('connect', go); }
  }, 0);

  function startGame() {           // запускаем штатный старт игры (внутри пользовательского клика)
    bypass = true; bPlay.click(); bypass = false;
  }

  // ---- выбор карты: режим -> КАРТА -> (одиночная: старт / онлайн: лобби) ----
  const MAPS = [
    { id: 'nacht', name: 'NACHT DER UNTOTEN', img: 'maps/nacht.jpg', d: 'Бункер · окна с досками · круговая лестница' },
    { id: 'verruckt', name: 'VERRÜCKT', img: 'maps/verruckt.jpg', d: 'Двор с фонтаном · два корпуса · Улучшайзер' },
    { id: 'soon', name: 'СКОРО', img: 'maps/soon.jpg', d: 'Новая карта в разработке', soon: true }
  ];
  let selMap = MAP_ID;
  const mapList = $('mapList');
  $('mapCount').textContent = (MAPS.length - 1) + ' КАРТЫ';
  MAPS.forEach(m => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'mc' + (m.soon ? ' soon' : '') + (m.id === selMap ? ' sel' : '');
    b.innerHTML = '<div class="im"><img src="' + m.img + '" alt=""><span class="tag">' + (m.soon ? 'СКОРО' : 'ВЫБРАНО') + '</span></div><div class="tx"><b>' + m.name + '</b><small>' + m.d + '</small></div>';
    if (!m.soon) b.addEventListener('click', () => { selMap = m.id; mapList.querySelectorAll('.mc').forEach(x => x.classList.toggle('sel', x === b)); });
    mapList.appendChild(b);
  });
  // смена карты = перезагрузка с ?map=; после неё продолжаем с того же места (sessionStorage)
  function reloadWith(map, resume) {
    try { sessionStorage.setItem('nb-resume', resume); } catch (e) {}
    location.search = '?map=' + map;
  }
  $('bSolo').onclick = () => { mode = 'solo'; setView('maps'); };
  $('bMulti').onclick = () => { mode = 'multi'; connect(); setView('maps'); };
  $('bMapsBack').onclick = () => setView('mode');
  $('bMapGo').onclick = () => {
    if (selMap !== MAP_ID) { reloadWith(selMap, mode === 'multi' ? 'multi' : 'solo'); return; }
    if (mode === 'multi') setView('mp'); else startGame();
  };
  $('bModeBack').onclick = () => setView('main');
  $('bMpBack').onclick = () => setView('maps');

  const nameInput = $('mpName');
  try { nameInput.value = localStorage.getItem('nb_name') || ''; } catch (e) {}
  const myName = () => { const n = nameInput.value.trim(); try { localStorage.setItem('nb_name', n); } catch (e) {} return n; };
  const showErr = t => { $('mpErr').textContent = t || ''; };

  $('bCreate').onclick = () => { showErr(); socket.emit('createRoom', { name: myName(), map: MAP_ID }); };
  $('bJoin').onclick = () => { showErr(); socket.emit('joinRoom', { code: $('mpCode').value, name: myName() }); };
  $('bGo').onclick = () => startGame();
  $('bLeave').onclick = () => { socket.emit('leaveRoom'); clearRemote(); clearNetworkZombies(); roomCode = null; gameState = null; setView('mp'); };

  // ------------------------------------------------------------------
  //  2) ПОДКЛЮЧЕНИЕ К СЕРВЕРУ (только при выборе «Мультиплеер»)
  // ------------------------------------------------------------------
  function connect() {
    if (socket) { if (!socket.connected) socket.connect(); return; }
    socket = SERVER_URL ? io(SERVER_URL) : io();

    socket.on('connect_error', () => showErr('Нет связи с сервером (на бесплатном Render он может просыпаться ~1 мин)'));
    socket.on('connect', () => { selfId = socket.id; showErr(); });
    socket.on('disconnect', () => { clearRemote(); clearNetworkZombies(); roomCode = null; if (menuOn) { setView('mp'); showErr('Соединение потеряно'); } });
    socket.on('joinError', showErr);
    // гость зашёл в комнату с другой картой — перезагружаемся на неё и входим по тому же коду
    const wrongMap = m => { if (m && m !== MAP_ID && /^[a-z]+$/.test(m) && roomCode) { try { sessionStorage.setItem('nb-rejoin', roomCode); } catch (e) {} reloadWith(m, 'rejoin'); return true; } return false; };

    // Мы вошли в лобби.
    socket.on('joined', ({ selfId: id, code, slot, players, map }) => {
      selfId = id; roomCode = code; mySlot = slot; entered = false;
      if (wrongMap(map)) return;
      gameState = null; worldRevision = 0;
      clearRemote(); clearNetworkZombies();
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
      const hasPos = Number.isFinite(shot.x) && Number.isFinite(shot.z);
      if (shot.weapon === -2) {   // взрыв чужой гранаты: огонь, дым и записанный взрыв в точке настоящего взрыва
        if (hasPos && typeof remoteGrenadeBoom === 'function') remoteGrenadeBoom(shot.nid, shot.x, Number.isFinite(shot.y) ? shot.y : 0, shot.z);
        return;
      }
      if (shot.weapon === -1) {   // нож: слышен взмах (позиционно) и на аватаре видна атака ножом
        if (hasPos && typeof playSfxAt === 'function' && typeof sfxBufs !== 'undefined') {
          const ok = []; for (let i = 1; i <= 5; i++) if (sfxBufs['ks' + i]) ok.push(i);
          if (ok.length) playSfxAt('ks' + ok[Math.floor(Math.random() * ok.length)], shot.x, shot.z, 30, 0.9, 0, 0.96 + Math.random() * 0.08);
        }
        const r = remote[shot.id]; if (r) r.knifeT = 0.0001;
        return;
      }
      if (typeof shotSnd === 'function') shotSnd(shot.weapon);
      const player = remote[shot.id];
      if (player && Number.isInteger(shot.weapon) && shot.weapon >= 0) player.weapon = shot.weapon;
      if (player && player.muzzleLight) {
        player.muzzleLight.color.setHex(shot.weapon === 5 ? 0x45ff64 : 0xffa030);
        player.muzzleLight.intensity = 2.5; player.kick = 1;
        setTimeout(() => { if (player.muzzleLight) player.muzzleLight.intensity = 0; }, 90);
      }
      showShotTrace(shot);
    });
    socket.on('bossSpit', d => {   // плевок босса: каждый клиент сам считает попадание по своему игроку
      if (!d || window.MP.isAuthority || typeof spawnSpit !== 'function' || ![d.x, d.y, d.z, d.vx, d.vy, d.vz].every(Number.isFinite)) return;
      spawnSpit(d);
      const z = zombies.find(item => item.mpId === d.zid); if (z && z.boss) z.spitT = 0.3;
    });
    socket.on('necroEvt', d => {   // некромант: надгробия, попадания по ним, колдовство
      if (!d || typeof d.t !== 'string' || typeof NGRAVES === 'undefined') return;
      const gr = NGRAVES.find(g => g.id === d.id);
      if (d.t === 'grave' && !window.MP.isAuthority && !gr && [d.x, d.z].every(Number.isFinite)) spawnGrave(d.x, d.z, null, d.id, Number(d.y) || 0);
      else if (d.t === 'gone' && gr) destroyGrave(gr, true);
      else if (d.t === 'hit' && gr && window.MP.isAuthority) graveHit(gr, 'm' + d.sid, Math.min(2, Math.max(1, Number(d.n) || 1)));
      else if (d.t === 'brute' && typeof bruteRemote === 'function') bruteRemote(d);
      else if (d.t === 'cast') { const z = zombies.find(item => item.mpId === d.zid); if (z && z.necro) { z.castT = 1.8; necroScream(z); } }
    });
    socket.on('grenadeThrown', d => { if (d && d.id !== selfId && typeof spawnRemoteGrenade === 'function') spawnRemoteGrenade(d); });
    // повален / поднят / вся команда повалена
    socket.on('playerDowned', ({ id } = {}) => setDowned(id, true));
    socket.on('playerRevived', ({ id } = {}) => {
      setDowned(id, false);
      if (id === selfId && typeof reviveSelf === 'function') reviveSelf();
    });
    socket.on('teamWipe', () => { if (typeof finalDeath === 'function') finalDeath(); });
    // бонусы (Max Ammo / Double Points): подбор приходит событием сервера
    socket.on('dropPicked', d => {
      if (!d || typeof removeDropById !== 'function') return;
      removeDropById(d.id);
      if (typeof collectMaxAmmo === 'function' && !dead) collectMaxAmmo();
    });
    socket.on('playerMoved', d => {
      if (gameState && gameState.players) {
        const p = gameState.players.find(player => player.id === d.id);
        if (p) Object.assign(p, d, { active: true });
      }
      const r = remote[d.id]; if (!r) return;
      if (!r.active) { r.active = true; r.group.position.set(d.x, d.y - EYE_HEIGHT, d.z); }   // первое появление — без «пролёта»
      r.target = { x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: Number.isFinite(d.pitch) ? d.pitch : 0 };
      if (Number.isInteger(d.w)) r.weapon = d.w; r.reloading = d.rl === 1; r.sprint = d.sp === 1;
    });
  }

  function setDowned(id, val) {
    if (typeof id !== 'string') return;
    if (gameState && Array.isArray(gameState.players)) { const p = gameState.players.find(q => q.id === id); if (p) p.downed = !!val; }
    const r = remote[id]; if (r) r.downed = !!val;
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
            // 1.27: перк мог прийти в состоянии раньше, чем событие покупки, — тогда раньше выдавалась только иконка без анимации
            if (p.perks.cola && !speedCola) { speedCola = true; drinkPerk('cola'); }
            if (p.perks.doubleTap && !doubleTap) { doubleTap = true; drinkPerk('dtap'); }
            if (p.perks.juggernog && typeof juggernog !== 'undefined' && !juggernog) { applyJugg(); drinkPerk('jugg'); }
            if (p.perks.builder && typeof gotBuilder === 'function') gotBuilder(true);   // «Строитель» (Verrückt)
          }
        } else {
          const r = remote[p.id];
          if (r) r.downed = !!p.downed;
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
    // Хост — единственный источник раундов: он сам публикует round/roundActive/toSpawn/nextRoundIn.
    // Если применять эхо этого же состояния обратно на хосте, nextRoundAt постоянно сдвигается вперёд
    // и отсчёт до начала раунда никогда не доходит до нуля.
    if (state.started && !window.MP.isAuthority) {
      started = true;
      const previousRound = round;
      round = state.round || round;
      if (round !== previousRound && typeof nades !== 'undefined') nades = NADE_PER_ROUND;   // новый раунд — снова 2 гранаты
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
        if (Array.isArray(state.zombies)) {
          try { applyNetworkZombies(state.zombies); } catch (err) { console.warn('[MP] zombies', err); }
        }
        if (Array.isArray(state.windowBoards)) {
          try { applyNetworkWindows(state.windowBoards); } catch (err) { console.warn('[MP] windows', err); }
        }
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

  function clearNetworkZombies() {
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      if (!z.mpId && !z.networkRemote) continue;
      scene.remove(z.g);
      z.mats.forEach(m => m.dispose());
      zombies.splice(i, 1);
    }
  }

  function applyNetworkZombies(list) {
    const received = new Set();
    for (const data of list) {
      if (!data || typeof data.id !== 'string' ||
          ![data.x, data.y, data.z].every(Number.isFinite)) continue;
      received.add(data.id);
      let z = zombies.find(item => item.mpId === data.id);
      if (!z) {
        z = spawnZombie({ x: data.x, y: data.y, z: data.z, yaw: data.yaw }, true, data.boss === true, typeof data.kind === 'string' ? data.kind : null);
        if (!z) continue;
        z.mpId = data.id;
        z.g.position.set(data.x, data.y, data.z);
        if (Number.isFinite(data.yaw)) z.g.rotation.y = data.yaw;
        z.networkRemote = true;
      }
      z.networkTarget = {
        x: data.x, y: data.y, z: data.z,
        vx: Number.isFinite(data.vx) ? data.vx : 0,
        vy: Number.isFinite(data.vy) ? data.vy : 0,
        vz: Number.isFinite(data.vz) ? data.vz : 0,
        speed: Number.isFinite(data.speed) ? data.speed : z.speed,
        yaw: Number.isFinite(data.yaw) ? data.yaw : null,
        moving: typeof data.moving === 'boolean' ? data.moving : null,
        attacking: data.attacking === true,
        attackKind: Number.isInteger(data.attackKind) ? data.attackKind : 0,
        receivedAt: performance.now(),
      };
      if (Number.isFinite(data.hp)) z.hp = data.hp;
      // Only gameplay state is shared. Gait, pose, head details and timing
      // stay local so the same zombie can look different on every machine.
      if (typeof data.state === 'string') z.state = data.state;
      z.menu = false;
      if (z.state === 'dying' && !z.rd) {
        z.dt = 0;
        z.eyes.forEach(e => e.visible = false);
        try { startRagdoll(z, false, 0); } catch (err) { console.warn('[MP] ragdoll', err); }
      }
    }
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      // The host snapshot is the complete zombie list for guests. Remove any
      // local/menu zombie as well as stale network replicas.
      if (received.has(z.mpId)) continue;
      scene.remove(z.g);
      z.mats.forEach(m => m.dispose());
      zombies.splice(i, 1);
    }
  }

  function applyNetworkHit(hit) {
    if (!hit || !Array.isArray(zombies)) return;
    if (hit.drop && typeof spawnDrop === 'function') spawnDrop(hit.drop);   // убитый зомби уронил бонус
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
        if (typeof kills === 'number') kills++;
      }
      if (hit.weapon === -1 && hit.shooterId !== selfId && typeof playSfxAt === 'function' && typeof sfxBufs !== 'undefined') {   // нож: слышно попадание по зомби
        const ok = []; for (let i = 1; i <= 5; i++) if (sfxBufs['kh' + i]) ok.push(i);
        if (ok.length) playSfxAt('kh' + ok[Math.floor(Math.random() * ok.length)], z.g.position.x, z.g.position.z, 30, 1, 0, 0.96 + Math.random() * 0.08);
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
      if (!speedCola) { speedCola = true; drinkPerk('cola'); }
    } else if (own && event.kind === 'doubleTap') {
      if (!doubleTap) { doubleTap = true; drinkPerk('dtap'); }
    } else if (own && event.kind === 'thompson') {
      const w = WEAPONS[1];
      w.mag = w.magSize; w.reserve = w.maxReserve - w.magSize;
      if (!w.own) equip(1); else updateHUD();
      sfx('buy');
    } else if (own && event.kind === 'mp40') {
      const w = WEAPONS[9];
      w.mag = w.magSize; w.reserve = w.maxReserve - w.magSize;
      if (!w.own) equip(9); else updateHUD();
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

  function registerShot(weapon, extra) {
    if (!socket || !socket.connected || !roomCode || !window.MP.active) return null;
    const shotId = `${selfId}:${++shotSeq}`;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    const msg = { shotId, weapon, yaw: euler.y, pitch: euler.x };
    if (extra) { msg.ex = extra.x; msg.ey = extra.y; msg.ez = extra.z; msg.nid = extra.nid; }   // граната: где и какая взорвалась
    socket.emit('shoot', msg);
    return shotId;
  }
  function throwGrenade(d) { if (socket && socket.connected && roomCode) socket.emit('grenadeThrow', d); }
  function reportDowned() { if (socket && socket.connected && roomCode) socket.emit('playerDowned'); }
  function reviveStart(targetId) { if (socket && socket.connected && roomCode) socket.emit('reviveStart', { targetId }); }
  function reviveDone(targetId) { if (socket && socket.connected && roomCode) socket.emit('reviveDone', { targetId }); }
  function requestDropPickup(id) { if (socket && socket.connected && roomCode) socket.emit('pickupDrop', { id }); }

  function requestPurchase(kind, doorIndex) {
    if (!socket || !socket.connected || !roomCode) return false;
    socket.emit('purchaseRequest', { kind, doorIndex });
    return true;
  }

  function requestHit(zombie, head, shotId, scale) {
    if (!socket || !socket.connected || !roomCode || !zombie || !zombie.mpId || !shotId) return;
    socket.emit('zombieHit', { zombieId: zombie.mpId, head: !!head, shotId, scale: Number.isFinite(scale) ? scale : undefined });
  }

  function necroEvt(d) {
    if (!socket || !socket.connected || !roomCode) return;
    socket.emit('necroEvt', d);
  }
  function sendSpit(d) {
    if (!socket || !socket.connected || !roomCode || !window.MP.isAuthority) return;
    socket.emit('bossSpit', d);
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
      `<div class="lp"><i style="background:${p.color}"></i>${esc(p.name)}${typeof HERO_NAMES !== 'undefined' && HERO_NAMES[p.slot] ? ' <small>· ' + HERO_NAMES[p.slot] + '</small>' : ''}${p.id === hostId ? ' <small>(хост)</small>' : ''}${p.id === selfId ? ' <small>(ты)</small>' : ''}</div>`
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
    const cur = { x: pos.x, y: pos.y, z: pos.z, yaw: _e.y, pitch: _e.x,
      w: typeof window.__curWeapon === 'function' ? window.__curWeapon() : 0,   // 1.27: какое оружие в руках, перезарядка, бег — для аватара у остальных
      rl: typeof reloading !== 'undefined' && reloading ? 1 : 0, sp: typeof isSprint !== 'undefined' && isSprint ? 1 : 0 };
    if (!force && cur.w === last.w && cur.rl === last.rl && cur.sp === last.sp && Math.abs(cur.x - last.x) + Math.abs(cur.y - last.y) + Math.abs(cur.z - last.z) +
        Math.abs(cur.yaw - last.yaw) + Math.abs(cur.pitch - last.pitch) < 0.001) return;
    last = cur; socket.emit('move', cur);
  }
  setInterval(() => {
    if (mode === 'multi' && socket && roomCode && entered && !menuOn && controls.isLocked) sendMove(false);
  }, 1000 / SEND_RATE);

  setInterval(() => {
    if (!window.MP.active || !window.MP.isAuthority || !entered || menuOn || !started) return;
    publishWorld({
      started: true,
      round,
      roundActive,
      toSpawn,
      nextRoundIn: Math.max(0, nextRoundAt - gtime),
      windowBoards: windows.map(w => ({ boards: w.boards.length, pending: w.pending.length })),
      zombies: zombies.filter(z => !z.menu && z.mpId).map(z => ({
        id: z.mpId,
        x: Math.round(z.g.position.x * 100) / 100, y: Math.round(z.g.position.y * 100) / 100, z: Math.round(z.g.position.z * 100) / 100,   // 1.28: до сантиметра — пакет почти вдвое меньше
        yaw: Math.round(z.g.rotation.y * 100) / 100,
        moving: z.moved > 0.0005 || z.state === 'vault',
        attacking: z.atkT > 0,
        attackKind: z.atkKind,
        hp: z.hp, state: z.state, speed: z.speed, boss: !!z.boss, kind: z.rot || '',
      })),
    });
  }, 1000 / SEND_RATE);

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
  // Солдат из простых форм: ботинки, штаны, жилет в цвете игрока, каска, лицо, руки с винтовкой. Начало координат — ступни, «вперёд» = -Z.
  function createAvatar(p) {
    if (typeof makeHero === 'function') {   // 1.27: один из 4 героев по слоту игрока, с оружием, которое у него в руках
      try {
        const h = makeHero(p), team = new THREE.Color(p.color || '#ffffff');
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.46, 24), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.userData.team = team.getHex(); h.group.add(ring);
        const label = makeLabel(p.name); h.group.add(label);
        h.group.visible = false; scene.add(h.group);
        remote[p.id] = { group: h.group, hero: h, muzzleLight: { color: new THREE.Color(0xffa030), intensity: 0 }, ring, label, downed: false, lieK: 0, knifeT: 0, kick: 0, active: false,
          weapon: 0, reloading: false, sprint: false, vy: 0, lastY: null, target: { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0 } };
        return;
      } catch (e) { console.warn('hero', e); }
    }
    const group = new THREE.Group(); group.rotation.order = 'YXZ';   // сначала поворот по курсу, затем «ложимся» вокруг локальной X
    const team = new THREE.Color(p.color);
    const std = (c, r = 0.85, mt = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: mt });
    const mSkin = std(0xc8a07c, 0.75), mCloth = std(0x3d4030), mClothD = std(0x2c2e22), mVest = std(team.clone().multiplyScalar(0.62), 0.7),
          mBoot = std(0x141210, 0.9), mHelm = std(0x4a5232, 0.6), mBand = new THREE.MeshStandardMaterial({ color: team, roughness: 0.5, emissive: team.clone().multiplyScalar(0.35) }),
          mGun = std(0x1d1d1f, 0.45, 0.6), mWood = std(0x5a3c24, 0.8), mPack = std(0x2f3322), mEye = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
    const box = (w, h, d, mat, x, y, z, par) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); o.position.set(x, y, z); (par || group).add(o); return o; };
    const cyl = (r0, r1, h, mat, x, y, z, par, seg = 8) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat); o.position.set(x, y, z); (par || group).add(o); return o; };

    // ноги: шарнир в бедре (y = 0.92), качаются при ходьбе
    const legs = [-1, 1].map(sd => {
      const leg = new THREE.Group(); leg.position.set(sd * 0.13, 0.92, 0); group.add(leg);
      cyl(0.085, 0.07, 0.46, mCloth, 0, -0.24, 0, leg);              // бедро
      cyl(0.07, 0.065, 0.4, mClothD, 0, -0.64, 0, leg);              // голень
      box(0.13, 0.1, 0.27, mBoot, 0, -0.86, -0.04, leg);             // ботинок
      return leg;
    });
    // торс
    const torso = new THREE.Group(); torso.position.y = 0.92; group.add(torso);
    box(0.44, 0.1, 0.25, mClothD, 0, 0.04, 0, torso);                // ремень
    box(0.46, 0.5, 0.27, mCloth, 0, 0.32, 0, torso);                 // куртка
    box(0.47, 0.36, 0.29, mVest, 0, 0.4, -0.005, torso);             // жилет в цвете игрока
    box(0.1, 0.1, 0.05, mClothD, -0.12, 0.2, -0.16, torso); box(0.1, 0.1, 0.05, mClothD, 0.12, 0.2, -0.16, torso);   // подсумки
    box(0.34, 0.4, 0.14, mPack, 0, 0.34, 0.21, torso);               // рюкзак
    box(0.38, 0.1, 0.16, mPack, 0, 0.58, 0.2, torso);                // скатка
    // верх тела (голова, руки, оружие) — наклоняется по взгляду вокруг плеч
    const aim = new THREE.Group(); aim.position.set(0, 0.92 + 0.5, 0); group.add(aim);
    cyl(0.055, 0.06, 0.08, mSkin, 0, 0.06, 0, aim);                  // шея
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), mSkin); head.scale.set(0.92, 1.05, 1); head.position.set(0, 0.2, 0); aim.add(head);
    box(0.034, 0.022, 0.012, mEye, -0.045, 0.21, -0.108, aim); box(0.034, 0.022, 0.012, mEye, 0.045, 0.21, -0.108, aim);   // глаза
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mHelm); helm.position.set(0, 0.22, 0.005); helm.scale.set(1.05, 1, 1.1); aim.add(helm);
    cyl(0.152, 0.152, 0.018, mHelm, 0, 0.215, 0, aim, 16).scale.set(1, 1, 1.12);   // поля каски
    box(0.2, 0.026, 0.02, mBand, 0, 0.255, -0.14, aim);              // повязка в цвете игрока на каске
    // руки: плечо → кисть у оружия
    const arm = (sd, hand) => {
      const sh = new THREE.Vector3(sd * 0.26, -0.04, 0), d = new THREE.Vector3().subVectors(hand, sh), L = d.length();
      const o = cyl(0.058, 0.048, L, mCloth, 0, 0, 0, aim, 7); o.position.copy(sh).addScaledVector(d, 0.5);
      o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      const hnd = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), mSkin); hnd.position.copy(hand); aim.add(hnd);
    };
    // оружие — отдельная группа (для отдачи), центр у правой кисти
    const gun = new THREE.Group(); gun.position.set(0.1, -0.22, -0.28); aim.add(gun);
    box(0.06, 0.11, 0.34, mGun, 0, 0, -0.02, gun);                   // ствольная коробка
    cyl(0.017, 0.017, 0.4, mGun, 0, 0.025, -0.4, gun, 6).rotation.x = Math.PI / 2;   // ствол
    box(0.05, 0.07, 0.3, mWood, 0, -0.01, 0.3, gun);                 // приклад
    box(0.045, 0.16, 0.06, mGun, 0, -0.12, -0.04, gun);              // магазин
    box(0.04, 0.09, 0.05, mWood, 0, -0.08, 0.1, gun);                // рукоять
    arm(1, new THREE.Vector3(0.1, -0.24, -0.2));                     // правая — на рукояти
    arm(-1, new THREE.Vector3(0.08, -0.2, -0.46));                   // левая — под цевьём
    // нож в руке (показывается только на время удара): клинок плашмя, режущая кромка вперёд по ходу взмаха
    const knife = new THREE.Group(); knife.visible = false; knife.rotation.order = 'YXZ'; aim.add(knife);
    box(0.04, 0.01, 0.2, new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.25, metalness: 0.9 }), 0, 0, -0.14, knife);
    box(0.06, 0.018, 0.012, mGun, 0, 0, -0.03, knife); box(0.028, 0.022, 0.1, mWood, 0, 0, 0.03, knife);
    const muzzleLight = new THREE.PointLight(0xffa030, 0, 3);
    muzzleLight.position.set(0.1, -0.2, -0.95); aim.add(muzzleLight);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffc060, transparent: true, opacity: 0, depthWrite: false }));
    flash.position.set(0.1, -0.2, -0.95); aim.add(flash);
    // кольцо под ногами в цвете игрока — видно издалека
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.46, 24), new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.userData.team = team.getHex(); group.add(ring);
    const label = makeLabel(p.name); group.add(label);
    group.visible = false;                            // покажем, когда игрок реально войдёт в игру
    scene.add(group);
    remote[p.id] = { group, muzzleLight, flash, legs, torso, aim, gun, knife, ring, label, downed: false, lieK: 0, knifeT: 0, kick: 0, phase: 0, active: false, target: { x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0 } };
  }
  function removeAvatar(id) {
    const r = remote[id]; if (!r) return;
    scene.remove(r.group);
    r.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !(o.material.userData && o.material.userData.shared)) { if (o.material.map && !(typeof GLOW_TEX !== 'undefined' && o.material.map === GLOW_TEX)) o.material.map.dispose(); o.material.dispose(); } });
    delete remote[id];
  }
  function clearRemote() { Object.keys(remote).forEach(removeAvatar); }

  // Плавное движение чужих аватаров + походка (по реальной скорости), наклон по взгляду, отдача при выстреле.
  (function smooth() {
    requestAnimationFrame(smooth);
    const now = performance.now(), dtr = Math.min(0.05, Math.max(0.004, (now - (smooth.l || now - 16)) / 1000)); smooth.l = now;
    const kf = 1 - Math.exp(-dtr * 17);   // 1.28: сглаживание не зависит от частоты кадров (на 144 Гц аватары раньше «летали» иначе, чем на 60)
    for (const id in remote) {
      const r = remote[id], t = r.target, g = r.group;
      if (!r.active) continue;
      const px = g.position.x, pz = g.position.z;
      if (Math.hypot(t.x - px, t.z - pz) > 6) { g.position.set(t.x, t.y - EYE_HEIGHT, t.z); r.lastY = null; }   // большой разрыв (лаг, телепорт) — сразу на место
      g.position.x += (t.x - g.position.x) * kf;
      r.lieK += ((r.downed ? 1 : 0) - r.lieK) * 0.12;   // плавно ложимся / встаём
      g.position.y += ((t.y - EYE_HEIGHT + r.lieK * 0.24) - g.position.y) * kf;
      g.position.z += (t.z - g.position.z) * kf;
      let dy = t.yaw - g.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); g.rotation.y += dy * kf;
      g.visible = !menuOn;
      g.rotation.x = r.lieK * Math.PI / 2;                                   // повален: лежит на спине, головой назад
      r.label.position.set(0, 1.95 - r.lieK * 1.05, -r.lieK * 1.0);          // подпись остаётся над телом
      r.ring.material.color.setHex(r.downed ? 0xff2a2a : r.ring.userData.team);
      r.ring.material.opacity = r.downed ? 0.45 + 0.35 * Math.abs(Math.sin(performance.now() / 280)) : 0.55;
      if (r.hero) {   // герой: вся анимация внутри makeHero
        const dt = dtr, vx = (g.position.x - px) / dt, vz = (g.position.z - pz) / dt;
        if (r.lastY == null) r.lastY = g.position.y; r.vy += (((g.position.y - r.lastY) / dt) - r.vy) * 0.3; r.lastY = g.position.y;
        r.svx = (r.svx || 0) + (vx - (r.svx || 0)) * 0.25; r.svz = (r.svz || 0) + (vz - (r.svz || 0)) * 0.25;
        if (r.kick > 0) r.kick = Math.max(0, r.kick - 0.12);
        if (r.knifeT > 0) { r.knifeT += dt; if (r.knifeT >= 0.38) r.knifeT = 0; }
        r.hero.update(dt, { vx: r.svx, vz: r.svz, vy: r.downed ? 0 : r.vy, yaw: g.rotation.y, pitch: t.pitch || 0, sprint: r.sprint, reloading: r.reloading, weapon: r.weapon,
          kick: r.kick, knifeT: r.downed ? 0 : r.knifeT, downed: r.downed, flashCol: r.muzzleLight.color });
        continue;
      }
      if (r.downed) { r.knifeT = 0; r.knife.visible = false; r.gun.visible = true; for (const l of r.legs) l.rotation.x = 0; r.kick = 0; r.flash.material.opacity = 0; continue; }
      if (!r.legs) continue;
      const sp = Math.hypot(g.position.x - px, g.position.z - pz) * 60;          // м/с при ~60 кадрах/с
      const k = Math.min(1, sp / 4);
      r.phase += Math.min(sp, 9) * 0.045 + 0.0;
      const sw = Math.sin(r.phase) * 0.75 * k;
      r.legs[0].rotation.x = sw; r.legs[1].rotation.x = -sw;
      r.torso.position.y = 0.92 + Math.abs(Math.sin(r.phase)) * 0.025 * k;
      r.aim.position.y = r.torso.position.y + 0.5;
      const pitch = Math.max(-0.9, Math.min(0.9, t.pitch || 0));
      r.aim.rotation.x += (pitch - r.aim.rotation.x) * 0.3;
      r.aim.rotation.z = Math.sin(r.phase) * 0.03 * k;
      if (r.kick > 0) r.kick = Math.max(0, r.kick - 0.12);
      r.gun.position.z = -0.28 + r.kick * 0.06; r.gun.rotation.x = r.kick * 0.1;
      r.flash.material.opacity = r.kick > 0.6 ? 0.9 : 0;
      if (r.knifeT > 0) {   // удар ножом: винтовка прячется, клинок идёт справа налево кромкой вперёд
        r.knifeT += 1 / 60; const kp = Math.min(1, r.knifeT / 0.38), ke = kp < 0.5 ? 2 * kp * kp : 1 - Math.pow(-2 * kp + 2, 2) / 2, ks = Math.sin(Math.PI * kp);
        r.knife.visible = true; r.gun.visible = false;
        r.knife.position.set(0.3 - 0.5 * ke, -0.22 + 0.05 * ks, -0.3 - 0.15 * ks);
        r.knife.rotation.set(-0.12, 0.9 - 1.9 * ke, 0);
        if (kp >= 1) { r.knifeT = 0; r.knife.visible = false; r.gun.visible = true; }
      }
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
    throwGrenade, reportDowned, reviveStart, reviveDone, requestDropPickup,
    requestPurchase,
    requestHit,
    requestPlayerHit,
    sendSpit,
    necroEvt,
    requestWindowRepair(index) {
      if (socket && socket.connected && roomCode) socket.emit('windowBoardAction', { action: 'repair', index });
    },
  };
})();
