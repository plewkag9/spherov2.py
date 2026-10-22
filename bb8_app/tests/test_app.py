import time

import pytest

from bb8_app import robot as robot_module
from bb8_app.robot import RobotController, RobotError, joystick_to_roll
from bb8_app.server import create_app
from bb8_app.simulator import SimulatedBB8, simulated_find_toys
from spherov2.commands.sphero import RollModes


def wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def rolls(toy):
    return [c for c in toy.calls if c[0] == 'roll']


@pytest.fixture
def toy():
    return SimulatedBB8()


@pytest.fixture
def controller(toy):
    c = RobotController(simulated_find_toys(toy))
    yield c
    c.close()


@pytest.mark.parametrize('x, y, heading', [(0, 1, 0), (1, 0, 90), (0, -1, 180), (-1, 0, 270)])
def test_joystick_heading(x, y, heading):
    assert joystick_to_roll(x, y, 200) == (200, heading)


def test_joystick_dead_zone_and_clamp():
    assert joystick_to_roll(0.01, 0.01, 200) == (0, None)
    assert joystick_to_roll(3, 4, 100)[0] == 100


def test_connect_wakes_and_sets_up(controller, toy):
    controller.connect()
    names = [c[0] for c in toy.calls]
    assert names[:4] == ['wake', 'set_stabilization', 'set_back_led_brightness', 'set_main_led']
    assert controller.state['connected'] and controller.state['name'] == 'BB-SIM1'
    assert controller.state['battery'] == {'state': 'ok', 'voltage': 7.8}


def test_commands_require_connection(controller):
    with pytest.raises(RobotError):
        controller.set_back_led(255)


def test_drive_sends_roll_then_watchdog_stops(controller, toy):
    controller.connect()
    controller.set_max_speed(100)
    controller.drive(1, 0)
    assert wait_for(lambda: any(c[1] == 100 and c[2] == 90 for c in rolls(toy)))
    # No further joystick updates: the watchdog must stop the robot on its own.
    assert wait_for(lambda: rolls(toy)[-1][1] == 0, timeout=robot_module.DRIVE_WATCHDOG + 1)
    assert rolls(toy)[-1][3] == RollModes.STOP


def test_boost_uses_full_speed(controller, toy):
    controller.connect()
    controller.drive(0, 0.5, boost=True)
    assert wait_for(lambda: any(c[1] == robot_module.BOOST_SPEED for c in rolls(toy)))


def test_aim_flow(controller, toy):
    controller.connect()
    controller.set_color(0, 0, 255)
    controller.start_aim()
    assert controller.state['aiming'] and controller.state['back_led'] == 255
    controller.aim(45)
    assert toy.calls[-1] == ('roll', 0, 45, RollModes.CALIBRATE, 0)
    controller.finish_aim()
    assert ('set_heading', 0) in toy.calls
    assert toy.calls[-1] == ('set_main_led', 0, 0, 255)
    assert not controller.state['aiming'] and controller.state['heading'] == 0


def test_sleep_disconnects(controller, toy):
    controller.connect()
    controller.sleep()
    assert any(c[0] == 'sleep' for c in toy.calls)
    assert not controller.state['connected'] and not toy.entered


async def test_websocket_round_trip(aiohttp_client):
    toy = SimulatedBB8()
    client = await aiohttp_client(create_app(simulated_find_toys(toy)))
    ws = await client.ws_connect('/ws')
    assert (await ws.receive_json())['state']['connected'] is False

    await ws.send_json({'type': 'scan'})
    while (msg := await ws.receive_json())['type'] != 'scan':
        pass
    assert msg['toys'] == [{'name': 'BB-SIM1', 'address': '00:00:00:00:00:00'}]

    await ws.send_json({'type': 'connect', 'name': 'BB-SIM1'})
    while not (msg := await ws.receive_json()).get('state', {}).get('connected'):
        pass

    await ws.send_json({'type': 'bogus'})
    while (msg := await ws.receive_json())['type'] != 'error':
        pass
    await ws.close()


async def test_token_required(aiohttp_client):
    client = await aiohttp_client(create_app(simulated_find_toys(), token='segredo'))
    resp = await client.get('/ws')
    assert resp.status == 401
    ws = await client.ws_connect('/ws?token=segredo')
    assert (await ws.receive_json())['type'] == 'state'
    await ws.close()


async def test_serves_page(aiohttp_client):
    client = await aiohttp_client(create_app(simulated_find_toys()))
    resp = await client.get('/')
    assert resp.status == 200 and 'BB-8' in await resp.text()
    assert (await client.get('/static/app.js')).status == 200
