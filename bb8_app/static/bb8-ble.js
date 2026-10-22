'use strict';

// Talks to a BB-8 straight from the browser over Web Bluetooth (Chrome on desktop/Android, Bluefy on iPhone).
// It speaks the same messages as the Python bridge (bb8_app/server.py), so app.js can use either one.
// Protocol: Sphero API v1, the same packets spherov2 builds in controls/v1.py and commands/{core,sphero}.py.

const BB8_UUID = (n) => `22bb746f-${n}-7554-2d6f-726568705327`;
const RADIO_SERVICE = BB8_UUID('2bb0');
const ANTI_DOS = BB8_UUID('2bbd');
const TX_POWER = BB8_UUID('2bb2');
const WAKE = BB8_UUID('2bbf');
const CONTROL_SERVICE = BB8_UUID('2ba0');
const COMMANDS = BB8_UUID('2ba1');
const RESPONSES = BB8_UUID('2ba6');

const CORE = 0x00;
const SPHERO = 0x02;
const CMD = {
  getPowerState: [CORE, 0x20], sleep: [CORE, 0x22],
  setHeading: [SPHERO, 0x01], setStabilization: [SPHERO, 0x02], setDataStreaming: [SPHERO, 0x11],
  setMainLed: [SPHERO, 0x20], setBackLed: [SPHERO, 0x21], roll: [SPHERO, 0x30],
};
const ROLL_STOP = 0, ROLL_GO = 1, ROLL_CALIBRATE = 2;
const POWER_STATES = ['unknown', 'charging', 'ok', 'low', 'critical'];
const ATTITUDE_MASK = 0x40000 | 0x20000 | 0x10000; // pitch, roll, yaw

const DRIVE_INTERVAL_MS = 100;
const DRIVE_WATCHDOG_MS = 600;
const BATTERY_INTERVAL_MS = 30000;
const RESPONSE_TIMEOUT_MS = 3000;
const BOOST_SPEED = 255;

function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return ~sum & 0xff;
}

function joystickToRoll(x, y, maxSpeed) {
  const magnitude = Math.min(1, Math.hypot(x, y));
  if (magnitude < 0.05) return [0, null];
  const heading = (Math.round(Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
  return [Math.round(magnitude * maxSpeed), heading];
}

class BB8Direct {
  constructor(onmessage) {
    this.onmessage = onmessage;
    this.device = null;
    this.commands = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = [];
    this.queue = Promise.resolve();
    this.target = [0, 0];
    this.sent = [0, 0];
    this.boost = false;
    this.lastDrive = 0;
    this.timers = [];
    this.state = {
      connected: false, name: null, address: null, battery: null, color: [255, 120, 0], back_led: 0,
      aiming: false, max_speed: 90, heading: 0, yaw: null, reconnecting: false, error: null,
    };
  }

  static supported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  start() { this.emitState(); }

  emitState(changes = {}) {
    Object.assign(this.state, changes);
    this.onmessage({ type: 'state', state: { ...this.state } });
  }

  // Same message shapes as the bridge's WebSocket.
  async send(message) {
    try {
      const handler = this.handlers()[message.type];
      if (!handler) throw new Error(`Comando desconhecido: ${message.type}`);
      await handler(message);
    } catch (e) {
      this.onmessage({ type: 'error', message: e.message || String(e) });
    }
  }

  handlers() {
    return {
      scan: () => this.connect(),
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      sleep: () => this.sleep(),
      drive: (m) => this.drive(m.x || 0, m.y || 0, !!m.boost),
      stop: () => this.stop(),
      max_speed: (m) => this.emitState({ max_speed: Math.max(10, Math.min(255, Number(m.value))) }),
      color: (m) => this.setColor(m.r, m.g, m.b),
      back_led: (m) => this.setBackLed(m.value),
      aim_start: () => this.startAim(),
      aim: (m) => this.aim(m.angle),
      aim_finish: () => this.finishAim(),
      battery: () => this.refreshBattery(),
    };
  }

  // -- connection -------------------------------------------------------------

  async connect() {
    if (this.state.connected) return;
    // The browser's own picker replaces the bridge's scan list.
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BB-' }],
      optionalServices: [RADIO_SERVICE, CONTROL_SERVICE],
    });
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
    const server = await device.gatt.connect();
    const radio = await server.getPrimaryService(RADIO_SERVICE);
    const control = await server.getPrimaryService(CONTROL_SERVICE);
    await this.writeChar(await radio.getCharacteristic(ANTI_DOS), new TextEncoder().encode('011i3'));
    await this.writeChar(await radio.getCharacteristic(TX_POWER), new Uint8Array([7]));
    await this.writeChar(await radio.getCharacteristic(WAKE), new Uint8Array([1]));
    const responses = await control.getCharacteristic(RESPONSES);
    responses.addEventListener('characteristicvaluechanged', (e) => this.onData(e.target.value));
    await responses.startNotifications();
    this.commands = await control.getCharacteristic(COMMANDS);
    this.device = device;

    await this.command(CMD.setStabilization, [1]);
    await this.command(CMD.setBackLed, [0]);
    await this.command(CMD.setMainLed, this.state.color);
    this.target = this.sent = [0, this.state.heading];
    this.emitState({ connected: true, name: device.name, address: device.id, back_led: 0, aiming: false,
                     yaw: null, error: null });
    this.startStreaming().catch((e) => this.emitState({ error: `Bússola indisponível: ${e.message}` }));
    await this.refreshBattery();
    this.timers.push(setInterval(() => this.driveTick(), DRIVE_INTERVAL_MS));
    this.timers.push(setInterval(() => this.refreshBattery().catch(() => {}), BATTERY_INTERVAL_MS));
  }

  onDisconnected() {
    const wasConnected = this.state.connected;
    this.cleanup();
    this.emitState({ connected: false, aiming: false, battery: null, yaw: null,
                     error: wasConnected ? 'Conexão com o BB-8 perdida. Aproxime o iPhone e toque em Procurar.' : null });
  }

  cleanup() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Desconectado')); }
    this.pending.clear();
    this.commands = null;
  }

  async disconnect() {
    const device = this.device;
    this.device = null;
    this.cleanup();
    if (device && device.gatt.connected) device.gatt.disconnect();
    this.emitState({ connected: false, aiming: false, battery: null, yaw: null });
  }

  async sleep() {
    this.requireConnected();
    await this.command(CMD.roll, [0, ...this.u16(this.state.heading), ROLL_STOP, 0]);
    await this.command(CMD.sleep, [0, 0, 0, 0, 0]);
    await this.disconnect();
  }

  // -- packets ----------------------------------------------------------------

  u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }

  writeChar(characteristic, data) {
    // Web Bluetooth allows one GATT operation at a time, so every write goes through this queue.
    const run = () => (characteristic.writeValueWithResponse
      ? characteristic.writeValueWithResponse(data) : characteristic.writeValue(data));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  command([did, cid], data = []) {
    if (!this.commands) return Promise.reject(new Error('BB-8 não está conectado'));
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const body = [did, cid, seq, data.length + 1, ...data];
    const packet = new Uint8Array([0xff, 0xff, ...body, checksum(body)]);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('O BB-8 não respondeu'));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(seq, { resolve, reject, timer });
    });
    const writes = [];
    for (let i = 0; i < packet.length; i += 20) writes.push(this.writeChar(this.commands, packet.slice(i, i + 20)));
    return Promise.all(writes).then(() => response);
  }

  onData(view) {
    for (let i = 0; i < view.byteLength; i++) this.buffer.push(view.getUint8(i));
    while (this.buffer.length && this.buffer[0] !== 0xff) this.buffer.shift();
    while (this.buffer.length > 4) {
      const [, sop2] = this.buffer;
      if (sop2 === 0xff) { // [FF FF MRSP SEQ DLEN data CHK]
        const dlen = this.buffer[4];
        if (this.buffer.length < 5 + dlen) return;
        const packet = this.buffer.splice(0, 5 + dlen);
        const [, , mrsp, seq] = packet;
        const waiter = this.pending.get(seq);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(seq);
          if (mrsp === 0) waiter.resolve(packet.slice(5, -1));
          else waiter.reject(new Error(`O BB-8 recusou o comando (erro ${mrsp})`));
        }
      } else if (sop2 === 0xfe) { // [FF FE ID DLEN-MSB DLEN-LSB data CHK]
        const dlen = (this.buffer[3] << 8) | this.buffer[4];
        if (this.buffer.length < 5 + dlen) return;
        const packet = this.buffer.splice(0, 5 + dlen);
        this.onAsync(packet[2], packet.slice(5, -1));
      } else {
        this.buffer.shift(); // out of sync: drop a byte and look for the next start of packet
      }
    }
  }

  onAsync(id, data) {
    if (id === 0x03 && data.length >= 6) { // sensor streaming: int16 pitch, roll, yaw
      let yaw = (data[4] << 8) | data[5];
      if (yaw & 0x8000) yaw -= 0x10000;
      const clockwise = ((Math.round(-yaw) % 360) + 360) % 360;
      const previous = this.state.yaw;
      const diff = previous == null ? 0 : Math.abs(clockwise - previous);
      if (previous == null || Math.min(diff, 360 - diff) >= 2) this.emitState({ yaw: clockwise });
    } else if (id === 0x01) { // battery state changed
      this.refreshBattery().catch(() => {});
    }
  }

  startStreaming() {
    // 400 Hz / 40 = 10 Hz, 1 frame per packet, attitude only, stream forever.
    return this.command(CMD.setDataStreaming,
      [0, 40, 0, 1, (ATTITUDE_MASK >>> 24) & 0xff, (ATTITUDE_MASK >> 16) & 0xff, (ATTITUDE_MASK >> 8) & 0xff,
       ATTITUDE_MASK & 0xff, 0, 0, 0, 0, 0]);
  }

  async refreshBattery() {
    if (!this.state.connected) return null;
    const data = await this.command(CMD.getPowerState);
    const battery = { state: POWER_STATES[data[1]] || 'unknown', voltage: ((data[2] << 8) | data[3]) / 100 };
    this.emitState({ battery });
    return battery;
  }

  requireConnected() {
    if (!this.state.connected) throw new Error('BB-8 não está conectado');
  }

  // -- driving ----------------------------------------------------------------

  drive(x, y, boost) {
    let [speed, heading] = joystickToRoll(x, y, this.state.max_speed);
    if (heading == null) heading = this.target[1];
    this.target = [speed, heading];
    this.boost = boost && speed > 0;
    this.lastDrive = performance.now();
  }

  async stop() {
    this.target = [0, this.target[1]];
    this.boost = false;
    if (this.state.connected) await this.sendRoll(0, this.target[1]);
  }

  sendRoll(speed, heading) {
    this.sent = [speed, heading];
    this.state.heading = heading;
    return this.command(CMD.roll, [speed, ...this.u16(heading), speed ? ROLL_GO : ROLL_STOP, 0]);
  }

  driveTick() {
    if (!this.state.connected || this.state.aiming || this.rolling) return;
    let [speed, heading] = this.target;
    if (speed && performance.now() - this.lastDrive > DRIVE_WATCHDOG_MS) {
      speed = 0;
      this.target = [0, heading];
    }
    if (this.boost && speed) speed = BOOST_SPEED;
    if (speed === this.sent[0] && heading === this.sent[1]) return;
    this.rolling = true; // never stack roll commands behind a slow link
    this.sendRoll(speed, heading)
      .catch((e) => this.emitState({ error: e.message }))
      .finally(() => { this.rolling = false; });
  }

  // -- lights and aiming --------------------------------------------------------

  async setColor(r, g, b) {
    const color = [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))));
    if (this.state.connected && !this.state.aiming) await this.command(CMD.setMainLed, color);
    this.emitState({ color });
  }

  async setBackLed(value) {
    this.requireConnected();
    const brightness = Math.max(0, Math.min(255, Math.round(value)));
    await this.command(CMD.setBackLed, [brightness]);
    this.emitState({ back_led: brightness });
  }

  async startAim() {
    this.requireConnected();
    this.target = [0, this.target[1]];
    await this.command(CMD.roll, [0, ...this.u16(this.target[1]), ROLL_STOP, 0]);
    await this.command(CMD.setMainLed, [0, 0, 0]);
    await this.command(CMD.setBackLed, [255]);
    this.emitState({ aiming: true, back_led: 255 });
  }

  async aim(angle) {
    if (!this.state.aiming) throw new Error('Comece a calibração antes de girar');
    angle = ((Math.round(angle) % 360) + 360) % 360;
    this.state.heading = angle;
    await this.command(CMD.roll, [0, ...this.u16(angle), ROLL_CALIBRATE, 0]);
  }

  async finishAim() {
    this.requireConnected();
    await this.command(CMD.setHeading, [0, 0]);
    await this.command(CMD.setBackLed, [0]);
    await this.command(CMD.setMainLed, this.state.color);
    this.target = this.sent = [0, 0];
    this.emitState({ aiming: false, back_led: 0, heading: 0 });
  }
}

if (typeof module !== 'undefined') module.exports = { BB8Direct, checksum, joystickToRoll };
