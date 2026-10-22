"""A stand-in BB-8 that records commands, for trying the app and running tests without the robot."""
from spherov2.listeners.core import PowerState, PowerStates


class SimulatedSensorControl:
    def __init__(self, toy):
        self._toy = toy
        self.listeners = set()
        self.enabled = set()

    def add_sensor_data_listener(self, listener):
        self.listeners.add(listener)

    def set_interval(self, interval):
        self._toy._record('set_sensor_interval', interval)

    def enable(self, *sensors):
        self.enabled.update(sensors)
        self.emit_yaw(0)

    def emit_yaw(self, yaw):
        """Pretend the IMU reported ``yaw`` (counter-clockwise degrees, like the real robot)."""
        if 'attitude' in self.enabled:
            yaw = (yaw + 180) % 360 - 180
            for listener in list(self.listeners):
                listener({'attitude': {'pitch': 0., 'roll': 0., 'yaw': float(yaw)}})


class SimulatedBB8:
    def __init__(self, name='BB-SIM1', address='00:00:00:00:00:00'):
        self.name = name
        self.address = address
        self.calls = []
        self.entered = False
        self.in_range = True
        self.sensor_control = SimulatedSensorControl(self)

    @property
    def is_connected(self):
        return self.entered and self.in_range

    def __enter__(self):
        if not self.in_range:
            raise RuntimeError('BB-8 fora de alcance')
        self.entered = True
        return self

    def __exit__(self, *args):
        self.entered = False

    def _record(self, name, *args):
        if not self.entered:
            raise RuntimeError('Use toys in context manager')
        self.calls.append((name, *args))

    def wake(self):
        self._record('wake')

    def set_stabilization(self, stabilize):
        self._record('set_stabilization', stabilize)

    def set_main_led(self, r, g, b):
        self._record('set_main_led', r, g, b)

    def set_back_led_brightness(self, brightness):
        self._record('set_back_led_brightness', brightness)

    def roll(self, speed, heading, roll_mode, reverse_flag):
        self._record('roll', speed, heading, roll_mode, reverse_flag)
        self.sensor_control.emit_yaw(-heading)  # the simulated robot turns instantly

    def set_heading(self, heading):
        self._record('set_heading', heading)
        self.sensor_control.emit_yaw(0)

    def sleep(self, interval_option, unk, unk2):
        self._record('sleep', interval_option, unk, unk2)

    def get_power_state(self):
        self._record('get_power_state')
        return PowerState(record_version=1, state=PowerStates.OK, voltage=7.8,
                          number_of_charges=12, time_since_last_charge=600)


def simulated_find_toys(toy=None):
    toy = toy or SimulatedBB8()

    def find_toys(timeout=5.0):
        return [toy]

    return find_toys
