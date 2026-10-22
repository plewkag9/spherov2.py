"""Thread-safe controller that keeps one BB-8 connected and turns UI intents into toy commands."""
import math
import threading
import time
from typing import Callable, Dict, List, Optional

from spherov2.commands.core import IntervalOptions
from spherov2.commands.sphero import RollModes, ReverseFlags

DRIVE_INTERVAL = 0.1  # seconds between roll commands while driving
DRIVE_WATCHDOG = 0.6  # stop if the UI goes quiet for this long while moving
BATTERY_INTERVAL = 30.0
BOOST_SPEED = 255
SENSOR_INTERVAL_MS = 100  # attitude streaming period, ~10 Hz
YAW_STEP = 2  # only report orientation changes of at least this many degrees


class RobotError(Exception):
    ...


def joystick_to_roll(x: float, y: float, max_speed: int):
    """Map a joystick vector (x right, y forward, both -1..1) to (speed, heading).

    Heading 0 is "forward" as set during aiming and grows clockwise, like the robot's heading.
    """
    magnitude = min(1.0, math.hypot(x, y))
    if magnitude < 0.05:
        return 0, None
    heading = int(round(math.degrees(math.atan2(x, y)))) % 360
    return int(round(magnitude * max_speed)), heading


class RobotController:
    def __init__(self, find_toys: Callable[..., List], on_state: Callable[[Dict], None] = None):
        """:param find_toys: callable(timeout=...) returning BB-8 toy objects, e.g. a partial of
        ``spherov2.scanner.find_toys``.
        :param on_state: called (from any thread) with the new state dict whenever it changes."""
        self._find_toys = find_toys
        self._on_state = on_state or (lambda state: None)
        self._lock = threading.RLock()
        self._toy = None
        self._toys_by_name: Dict[str, object] = {}

        self._target = (0, 0)  # (speed, heading) the UI asked for
        self._sent = (0, 0)
        self._last_drive = 0.0
        self._last_battery = 0.0
        self._boost = False

        self.state = {
            'connected': False,
            'name': None,
            'address': None,
            'battery': None,
            'color': [255, 120, 0],
            'back_led': 0,
            'aiming': False,
            'max_speed': 90,
            'heading': 0,
            'yaw': None,  # measured orientation in degrees, clockwise from "forward"; None until streaming
            'error': None,
        }

        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name='bb8-drive', daemon=True)
        self._thread.start()

    # -- state ---------------------------------------------------------------

    def _update(self, **changes):
        self.state.update(changes)
        self._on_state(dict(self.state))

    def _require_toy(self):
        if self._toy is None:
            raise RobotError('BB-8 não está conectado')
        return self._toy

    # -- connection ----------------------------------------------------------

    def scan(self, timeout: float = 5.0) -> List[Dict]:
        toys = self._find_toys(timeout=timeout)
        with self._lock:
            self._toys_by_name = {toy.name: toy for toy in toys}
        return [{'name': toy.name, 'address': toy.address} for toy in toys]

    def connect(self, name: Optional[str] = None, timeout: float = 5.0):
        with self._lock:
            if self._toy is not None:
                if name is None or self._toy.name == name:
                    return
                self.disconnect()
            toy = self._toys_by_name.get(name) if name else None
            if toy is None:
                toys = self._find_toys(timeout=timeout)
                if name:
                    toys = [t for t in toys if t.name == name]
                if not toys:
                    raise RobotError('Nenhum BB-8 encontrado. Ele está ligado e perto da ponte?')
                toy = toys[0]
            toy.__enter__()
            try:
                toy.wake()
                toy.set_stabilization(True)
                toy.set_back_led_brightness(0)
                toy.set_main_led(*self.state['color'])
            except BaseException:
                toy.__exit__(None, None, None)
                raise
            self._toy = toy
            self._target = self._sent = (0, self.state['heading'])
            self._update(connected=True, name=toy.name, address=toy.address, back_led=0,
                         aiming=False, yaw=None, error=None)
        self._start_orientation_stream(toy)
        self.refresh_battery()

    def _start_orientation_stream(self, toy):
        """Stream the IMU attitude so the page can draw which way BB-8 is facing."""
        try:
            sensors = toy.sensor_control
            sensors.add_sensor_data_listener(self._on_sensor_data)
            sensors.set_interval(SENSOR_INTERVAL_MS)
            sensors.enable('attitude')
        except Exception as e:  # driving still works without it
            self._update(error=f'Bússola indisponível: {e}')

    def _on_sensor_data(self, data):
        attitude = data.get('attitude')
        if not attitude or self._toy is None:
            return
        # The IMU's yaw grows counter-clockwise; the page and roll headings use clockwise degrees.
        yaw = int(round(-attitude['yaw'])) % 360
        previous = self.state['yaw']
        if previous is None or min(abs(yaw - previous), 360 - abs(yaw - previous)) >= YAW_STEP:
            self._update(yaw=yaw)

    def disconnect(self):
        with self._lock:
            toy, self._toy = self._toy, None
            if toy is not None:
                try:
                    toy.__exit__(None, None, None)
                except Exception:
                    pass
            self._update(connected=False, aiming=False, battery=None, yaw=None)

    def sleep(self):
        """Put the robot to sleep and drop the connection. Reconnecting wakes it again."""
        with self._lock:
            toy = self._require_toy()
            toy.roll(0, self.state['heading'], RollModes.STOP, ReverseFlags.OFF)
            toy.sleep(IntervalOptions.NONE, 0, 0)
            self.disconnect()

    # -- driving -------------------------------------------------------------

    def drive(self, x: float, y: float, boost: bool = False):
        """Record the latest joystick position. The drive loop turns it into roll commands."""
        speed, heading = joystick_to_roll(x, y, self.state['max_speed'])
        with self._lock:
            if heading is None:
                heading = self._target[1]
            self._target = (speed, heading)
            self._boost = boost and speed > 0
            self._last_drive = time.monotonic()

    def stop(self):
        with self._lock:
            self._target = (0, self._target[1])
            self._boost = False
            if self._toy is not None:
                self._send_roll(0, self._target[1])

    def set_max_speed(self, value: int):
        self._update(max_speed=max(10, min(255, int(value))))

    def _send_roll(self, speed: int, heading: int):
        mode = RollModes.GO if speed else RollModes.STOP
        self._toy.roll(speed, heading, mode, ReverseFlags.OFF)
        self._sent = (speed, heading)
        self.state['heading'] = heading

    def _loop(self):
        while not self._stop.wait(DRIVE_INTERVAL):
            try:
                with self._lock:
                    if self._toy is None or self.state['aiming']:
                        continue
                    speed, heading = self._target
                    if speed and time.monotonic() - self._last_drive > DRIVE_WATCHDOG:
                        speed = 0
                        self._target = (0, heading)
                    if self._boost and speed:
                        speed = BOOST_SPEED
                    if (speed, heading) != self._sent:
                        self._send_roll(speed, heading)
                if time.monotonic() - self._last_battery > BATTERY_INTERVAL:
                    self.refresh_battery()
            except Exception as e:  # keep the loop alive; report the problem to the UI
                self._update(error=str(e) or e.__class__.__name__)

    def close(self):
        self._stop.set()
        self._thread.join()
        self.disconnect()

    # -- lights --------------------------------------------------------------

    def set_color(self, r: int, g: int, b: int):
        color = [max(0, min(255, int(c))) for c in (r, g, b)]
        with self._lock:
            if self._toy is not None and not self.state['aiming']:
                self._toy.set_main_led(*color)
            self._update(color=color)

    def set_back_led(self, brightness: int):
        brightness = max(0, min(255, int(brightness)))
        with self._lock:
            self._require_toy().set_back_led_brightness(brightness)
            self._update(back_led=brightness)

    # -- aiming --------------------------------------------------------------

    def start_aim(self):
        """Light the tail LED so the user can turn BB-8 until the blue light faces them."""
        with self._lock:
            toy = self._require_toy()
            self._target = (0, self._target[1])
            toy.roll(0, self._target[1], RollModes.STOP, ReverseFlags.OFF)
            toy.set_main_led(0, 0, 0)
            toy.set_back_led_brightness(255)
            self._update(aiming=True, back_led=255)

    def aim(self, angle: int):
        with self._lock:
            if not self.state['aiming']:
                raise RobotError('Comece a calibração antes de girar')
            angle = int(angle) % 360
            self._toy.roll(0, angle, RollModes.CALIBRATE, ReverseFlags.OFF)
            self.state['heading'] = angle

    def finish_aim(self):
        """Make the current orientation the new "forward"."""
        with self._lock:
            toy = self._require_toy()
            toy.set_heading(0)
            toy.set_back_led_brightness(0)
            toy.set_main_led(*self.state['color'])
            self._target = self._sent = (0, 0)
            self._update(aiming=False, back_led=0, heading=0)

    # -- status --------------------------------------------------------------

    def refresh_battery(self):
        with self._lock:
            self._last_battery = time.monotonic()
            if self._toy is None:
                return None
            power = self._toy.get_power_state()
            battery = {'state': power.state.name.lower(), 'voltage': round(power.voltage, 2)}
            self._update(battery=battery)
            return battery
