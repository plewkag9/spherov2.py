"""Checks the gentle-driving easing in static/smooth.js."""
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

SMOOTH_JS = Path(__file__).parents[1] / 'static' / 'smooth.js'
pytestmark = pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')


def run_js(body):
    script = f"const m = require({json.dumps(str(SMOOTH_JS))}); console.log(JSON.stringify((() => {{ {body} }})()));"
    return json.loads(subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True).stdout)


def test_small_change_lands_on_target():
    assert run_js('return m.easeJoystick([0.5, 0.5], [0.55, 0.5]);') == [0.55, 0.5]


def test_each_tick_moves_at_most_one_step():
    path = run_js('''
        const out = []; let p = [0, 0];
        for (let i = 0; i < 30; i++) { p = m.easeJoystick(p, [0, 1]); out.push(p); }
        return [m.SMOOTH_STEP, out];''')
    step, points = path
    previous = [0, 0]
    for point in points:
        assert math.dist(previous, point) <= step + 1e-9
        previous = point
    assert points[-1] == [0, 1]
    assert points.index([0, 1]) == math.ceil(1 / step) - 1


def test_reversal_slows_through_zero():
    speeds = run_js('''
        const out = []; let p = [0, 1];
        for (let i = 0; i < 20; i++) { p = m.easeJoystick(p, [0, -1]); out.push(Math.hypot(...p)); }
        return out;''')
    assert min(speeds) < 0.1
    assert speeds[-1] == 1
