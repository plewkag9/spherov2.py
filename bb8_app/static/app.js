'use strict';

const $ = (id) => document.getElementById(id);

const COLORS = [
  ['Laranja BB-8', [255, 120, 0]],
  ['Branco', [255, 255, 255]],
  ['Vermelho', [255, 0, 0]],
  ['Azul', [0, 80, 255]],
  ['Verde', [0, 255, 60]],
  ['Roxo', [170, 0, 255]],
  ['Apagado', [0, 0, 0]],
];
const BATTERY = {
  charging: ['Carregando', 100, 'var(--blue)'],
  ok: ['Bateria ok', 75, 'var(--green)'],
  low: ['Bateria baixa', 30, 'var(--orange)'],
  critical: ['Bateria crítica', 10, 'var(--red)'],
  unknown: ['Bateria ?', 0, 'var(--muted)'],
};
const DRIVE_PERIOD_MS = 100;

let ws = null;
let state = {};
let retryMs = 500;

// The bridge password can come in the link (#token=...) once and is remembered on this device.
function token() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  try {
    if (fromHash) localStorage.setItem('bb8-token', fromHash);
    return fromHash || localStorage.getItem('bb8-token') || '';
  } catch (e) {
    return fromHash || '';
  }
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function setStatus(text, level) {
  $('status-text').textContent = text;
  $('status-dot').className = 'dot ' + level;
}

function connectBridge() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const t = token();
  ws = new WebSocket(`${proto}://${location.host}/ws${t ? '?token=' + encodeURIComponent(t) : ''}`);
  ws.onopen = () => { retryMs = 500; };
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = () => {
    setStatus('Sem conexão com a ponte. Tentando de novo…', 'bad');
    $('control').hidden = true;
    $('connect-panel').hidden = true;
    setTimeout(connectBridge, retryMs);
    retryMs = Math.min(retryMs * 2, 8000);
  };
}

function handle(message) {
  if (message.type === 'state') render(message.state);
  else if (message.type === 'scan') renderToys(message.toys);
  else if (message.type === 'error') toast(message.message);
}

function render(next) {
  state = next;
  const connected = state.connected;
  $('connect-panel').hidden = connected;
  $('control').hidden = !connected;
  if (connected) setStatus(`Conectado a ${state.name}`, 'ok');
  else if (state.reconnecting) setStatus('Conexão perdida. Reconectando…', 'bad');
  else setStatus('Ponte pronta. BB-8 desconectado.', 'warn');
  if (state.error && state.error !== render.lastError) toast(state.error);
  render.lastError = state.error;

  const battery = $('battery');
  battery.hidden = !state.battery;
  if (state.battery) {
    const [label, fill, color] = BATTERY[state.battery.state] || BATTERY.unknown;
    $('battery-text').textContent = `${label} · ${state.battery.voltage} V`;
    $('battery-fill').style.width = fill + '%';
    $('battery-fill').style.background = color;
  }

  $('speed').value = state.max_speed;
  $('speed-out').textContent = Math.round(state.max_speed / 255 * 100) + '%';
  $('back-led').checked = state.back_led > 0;
  $('color-input').value = '#' + state.color.map((c) => c.toString(16).padStart(2, '0')).join('');
  document.querySelectorAll('.swatch').forEach((el) => {
    el.classList.toggle('on', el.dataset.rgb === state.color.join(','));
  });

  renderCompass(state.yaw);

  $('aim-controls').hidden = !state.aiming;
  $('aim-btn').textContent = state.aiming ? 'Pronto' : 'Calibrar';
  $('aim-btn').classList.toggle('primary', state.aiming);
  $('joystick').style.opacity = state.aiming ? 0.3 : 1;
}

// -- compass ------------------------------------------------------------------

const DIRECTIONS = ['frente', 'frente-direita', 'direita', 'trás-direita', 'trás', 'trás-esquerda', 'esquerda', 'frente-esquerda'];
const compass = { angle: 0, flip: false };
try { compass.flip = localStorage.getItem('bb8-compass-flip') === '1'; } catch (e) { /* private mode */ }

function renderCompass(yaw) {
  const svg = document.querySelector('.compass');
  svg.classList.toggle('unknown', yaw == null);
  if (yaw == null) {
    $('compass-text').textContent = 'Aguardando o giroscópio…';
    return;
  }
  const target = compass.flip ? (360 - yaw) % 360 : yaw;
  // Turn the short way round so 359° → 1° does not spin the drawing a full circle.
  const delta = ((target - compass.angle) % 360 + 540) % 360 - 180;
  compass.angle += delta;
  $('compass-robot').style.transform = `rotate(${compass.angle}deg)`;
  $('compass-text').textContent = `${DIRECTIONS[Math.round(target / 45) % 8]} · ${target}°`;
}

function renderToys(toys) {
  $('scan-btn').disabled = false;
  $('scan-btn').textContent = 'Procurar de novo';
  const list = $('toy-list');
  list.innerHTML = '';
  if (!toys.length) {
    list.innerHTML = '<li class="hint">Nenhum BB-8 encontrado. Ele está acordado e perto da ponte?</li>';
    return;
  }
  for (const toy of toys) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.innerHTML = `<span></span><small></small>`;
    button.firstChild.textContent = toy.name;
    button.lastChild.textContent = toy.address;
    button.onclick = () => {
      button.disabled = true;
      setStatus(`Conectando a ${toy.name}…`, 'warn');
      send({ type: 'connect', name: toy.name });
    };
    li.appendChild(button);
    list.appendChild(li);
  }
}

// -- joystick ---------------------------------------------------------------

const drive = { x: 0, y: 0, boost: false, active: false, timer: null };

function startDriving() {
  if (drive.timer) return;
  drive.timer = setInterval(() => send({ type: 'drive', x: drive.x, y: drive.y, boost: drive.boost }), DRIVE_PERIOD_MS);
}

function stopDriving() {
  clearInterval(drive.timer);
  drive.timer = null;
  drive.x = drive.y = 0;
  send({ type: 'stop' });
}

function setupJoystick() {
  const pad = $('joystick');
  const knob = $('knob');
  let pointer = null;

  const move = (event) => {
    const rect = pad.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (event.clientX - rect.left - radius) / radius;
    let dy = (event.clientY - rect.top - radius) / radius;
    const length = Math.hypot(dx, dy);
    if (length > 1) { dx /= length; dy /= length; }
    drive.x = dx;
    drive.y = -dy;
    knob.style.transform = `translate(${dx * radius * 0.66}px, ${dy * radius * 0.66}px)`;
  };
  const end = () => {
    pointer = null;
    pad.classList.remove('active');
    knob.style.transform = '';
    stopDriving();
  };

  pad.addEventListener('pointerdown', (event) => {
    if (state.aiming) return;
    pointer = event.pointerId;
    pad.setPointerCapture(pointer);
    pad.classList.add('active');
    move(event);
    startDriving();
  });
  pad.addEventListener('pointermove', (event) => { if (event.pointerId === pointer) move(event); });
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  const boost = $('boost-btn');
  const setBoost = (on) => { drive.boost = on; boost.classList.toggle('on', on); };
  boost.addEventListener('pointerdown', () => setBoost(true));
  boost.addEventListener('pointerup', () => setBoost(false));
  boost.addEventListener('pointerleave', () => setBoost(false));
  $('stop-btn').onclick = stopDriving;
}

function setupKeyboard() {
  const keys = new Set();
  const map = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1],
                ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  const update = () => {
    let x = 0, y = 0;
    for (const k of keys) { if (map[k]) { x += map[k][0]; y += map[k][1]; } }
    drive.boost = keys.has('Space');
    if (x || y) {
      const length = Math.hypot(x, y);
      drive.x = x / length;
      drive.y = y / length;
      startDriving();
    } else if (drive.timer) {
      stopDriving();
    }
  };
  addEventListener('keydown', (e) => {
    if (!state.connected || state.aiming || e.target.tagName === 'INPUT') return;
    if (map[e.code] || e.code === 'Space') { e.preventDefault(); keys.add(e.code); update(); }
  });
  addEventListener('keyup', (e) => { keys.delete(e.code); update(); });
  addEventListener('blur', () => { keys.clear(); update(); });
}

// -- other controls -----------------------------------------------------------

function setupControls() {
  $('scan-btn').onclick = () => {
    $('scan-btn').disabled = true;
    $('scan-btn').textContent = 'Procurando…';
    send({ type: 'scan', timeout: 5 });
  };

  const swatches = $('swatches');
  for (const [name, rgb] of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = name;
    b.setAttribute('aria-label', name);
    b.dataset.rgb = rgb.join(',');
    b.style.background = rgb.join(',') === '0,0,0' ? '#000' : `rgb(${rgb})`;
    b.onclick = () => send({ type: 'color', r: rgb[0], g: rgb[1], b: rgb[2] });
    swatches.appendChild(b);
  }
  $('color-input').oninput = (e) => {
    const hex = e.target.value.slice(1);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    send({ type: 'color', r, g, b });
  };
  $('back-led').onchange = (e) => send({ type: 'back_led', value: e.target.checked ? 255 : 0 });

  $('speed').oninput = (e) => {
    $('speed-out').textContent = Math.round(e.target.value / 255 * 100) + '%';
    send({ type: 'max_speed', value: Number(e.target.value) });
  };

  $('aim-btn').onclick = () => {
    if (state.aiming) {
      send({ type: 'aim_finish' });
    } else {
      $('aim').value = 0;
      $('aim-out').textContent = '0°';
      send({ type: 'aim_start' });
    }
  };
  $('aim').oninput = (e) => {
    $('aim-out').textContent = e.target.value + '°';
    send({ type: 'aim', angle: Number(e.target.value) });
  };

  $('compass-flip').checked = compass.flip;
  $('compass-flip').onchange = (e) => {
    compass.flip = e.target.checked;
    try { localStorage.setItem('bb8-compass-flip', compass.flip ? '1' : '0'); } catch (err) { /* private mode */ }
    renderCompass(state.yaw);
  };

  $('sleep-btn').onclick = () => send({ type: 'sleep' });
  $('disconnect-btn').onclick = () => send({ type: 'disconnect' });
}

setupJoystick();
setupKeyboard();
setupControls();
connectBridge();
