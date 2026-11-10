// =====================================================================
//  multiplayer.js — клиентская часть мультиплеера
//  Подключается ПОСЛЕ основного скрипта игры. Использует его глобальные
//  переменные: scene, camera, controls, pos, menuOn (они объявлены через
//  const/let в обычном <script>, поэтому видны из другого обычного <script>).
// =====================================================================
(function () {
  if (typeof io === 'undefined') { console.warn('[MP] socket.io не загружен'); return; }

  // ---- Адрес сервера -------------------------------------------------
  // Если игра открыта с самого сервера (Render) — оставь пусто: подключится к тому же адресу.
  // Если клиент лежит отдельно (GitHub Pages) — впиши URL: 'https://my-game.onrender.com'
  const SERVER_URL = '';
  const socket = SERVER_URL ? io(SERVER_URL) : io();

  const SEND_RATE = 20;          // сколько раз в секунду отправляем позицию
  const EYE_HEIGHT = 1.7;        // высота камеры над полом (как SPAWN.y в игре)
  const remote = {};             // id → { group, target:{x,y,z,yaw}, label }
  let selfId = null;

  // ---- Рисуем аватар другого игрока ----------------------------------
  function makeLabel(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 32px sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(text, 128, 42);
    g.fillStyle = '#fff'; g.fillText(text, 128, 42);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(1.6, 0.4, 1); spr.position.y = 0.55; spr.renderOrder = 10;
    return spr;
  }

  function createAvatar(p) {
    const group = new THREE.Group();                       // начало координат = ступни
    const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.2, 12), mat);
    body.position.y = 0.8; group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), mat);
    head.position.y = 1.55; group.add(head);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    gun.position.set(0.25, 1.25, -0.4); group.add(gun);    // «вперёд» = -Z, как у камеры
    const label = makeLabel(p.name); group.add(label);
    label.position.y = 1.95;
    group.position.set(p.x, p.y - EYE_HEIGHT, p.z);
    group.rotation.y = p.yaw;
    scene.add(group);
    remote[p.id] = { group, label, mat, target: { x: p.x, y: p.y, z: p.z, yaw: p.yaw } };
  }

  function removeAvatar(id) {
    const r = remote[id]; if (!r) return;
    scene.remove(r.group);
    r.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    delete remote[id];
  }

  // ---- События от сервера --------------------------------------------
  socket.on('init', ({ selfId: id, players }) => {
    selfId = id;
    Object.values(players).forEach(p => { if (p.id !== selfId) createAvatar(p); });
    console.log('[MP] подключено, мой id =', selfId);
    const saved = localStorage.getItem('nb_name');
    if (saved) socket.emit('setName', saved);
  });
  socket.on('playerJoined', p => { if (p.id !== selfId && !remote[p.id]) createAvatar(p); });
  socket.on('playerLeft', removeAvatar);
  socket.on('playerMoved', d => { const r = remote[d.id]; if (r) r.target = { x: d.x, y: d.y, z: d.z, yaw: d.yaw }; });
  socket.on('playerRenamed', ({ id, name }) => {
    const r = remote[id]; if (!r) return;
    r.group.remove(r.label); r.label.material.map.dispose(); r.label.material.dispose();
    r.label = makeLabel(name); r.label.position.y = 1.95; r.group.add(r.label);
  });
  socket.on('serverFull', () => alert('Сервер полон, попробуй позже.'));

  // ---- Отправка своих данных -----------------------------------------
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  let last = { x: 1e9, y: 1e9, z: 1e9, yaw: 1e9, pitch: 1e9 };

  setInterval(() => {
    if (!selfId || menuOn || !controls.isLocked) return;      // шлём только когда реально играем
    _e.setFromQuaternion(camera.quaternion, 'YXZ');
    const cur = { x: pos.x, y: pos.y, z: pos.z, yaw: _e.y, pitch: _e.x };
    // Не шлём то же самое, что уже отправляли (экономим трафик).
    if (Math.abs(cur.x - last.x) + Math.abs(cur.y - last.y) + Math.abs(cur.z - last.z) +
        Math.abs(cur.yaw - last.yaw) + Math.abs(cur.pitch - last.pitch) < 0.001) return;
    last = cur;
    socket.emit('move', cur);
  }, 1000 / SEND_RATE);

  // Выстрел: левая кнопка мыши во время игры.
  addEventListener('mousedown', e => {
    if (e.button === 0 && selfId && !menuOn && controls.isLocked) socket.emit('shoot');
  });

  // ---- Плавное движение чужих аватаров (интерполяция) ----------------
  function smooth() {
    requestAnimationFrame(smooth);
    for (const id in remote) {
      const r = remote[id], t = r.target, g = r.group;
      g.position.x += (t.x - g.position.x) * 0.25;
      g.position.y += ((t.y - EYE_HEIGHT) - g.position.y) * 0.25;
      g.position.z += (t.z - g.position.z) * 0.25;
      let dy = t.yaw - g.rotation.y;                          // кратчайший путь поворота
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.rotation.y += dy * 0.25;
      g.visible = !menuOn;                                    // в меню чужих не показываем
    }
  }
  smooth();

  // Для отладки из консоли браузера: MP.socket, MP.remote
  window.MP = { socket, remote, setName: n => { localStorage.setItem('nb_name', n); socket.emit('setName', n); } };
})();
