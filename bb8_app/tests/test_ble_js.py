"""Checks that the browser's Web Bluetooth driver (static/bb8-ble.js) builds the same packets as spherov2."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from bb8_app.robot import joystick_to_roll
from spherov2.controls.v1 import Packet

BLE_JS = Path(__file__).parents[1] / 'static' / 'bb8-ble.js'
pytestmark = pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')


def run_js(expr):
    script = f"const m = require({json.dumps(str(BLE_JS))}); console.log(JSON.stringify({expr}));"
    return json.loads(subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True).stdout)


@pytest.mark.parametrize('did, cid, seq, data', [
    (2, 0x30, 5, [60, 0, 90, 1, 0]),  # roll
    (2, 0x20, 0, [255, 120, 0]),  # main LED
    (0, 0x20, 200, []),  # power state
    (2, 0x11, 3, [0, 40, 0, 1, 0, 7, 0, 0, 0, 0, 0, 0, 0]),  # data streaming
])
def test_checksum_matches_spherov2(did, cid, seq, data):
    expected = Packet.Request(did, cid, seq, bytearray(data)).build()
    body = [did, cid, seq, len(data) + 1, *data]
    assert run_js(f'm.checksum({json.dumps(body)})') == expected[-1]


@pytest.mark.parametrize('x, y', [(0, 1), (1, 0), (0.3, -0.7), (-1, -1), (0.01, 0.02)])
def test_joystick_matches_python(x, y):
    speed, heading = joystick_to_roll(x, y, 150)
    assert run_js(f'm.joystickToRoll({x}, {y}, 150)') == [speed, heading]
