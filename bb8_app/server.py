"""HTTP + WebSocket bridge: serves the control page and relays its messages to the RobotController."""
import asyncio
import hmac
import json
import logging
from pathlib import Path

from aiohttp import web, WSMsgType

from bb8_app.robot import RobotController, RobotError

STATIC_DIR = Path(__file__).with_name('static')
log = logging.getLogger('bb8_app')

# Messages that only update in-memory targets and must not wait behind slower Bluetooth calls.
_INSTANT = {'drive', 'max_speed'}


def _handlers(robot: RobotController):
    return {
        'scan': lambda m: {'type': 'scan', 'toys': robot.scan(float(m.get('timeout', 5)))},
        'connect': lambda m: robot.connect(m.get('name')),
        'disconnect': lambda m: robot.disconnect(),
        'sleep': lambda m: robot.sleep(),
        'drive': lambda m: robot.drive(float(m.get('x', 0)), float(m.get('y', 0)), bool(m.get('boost'))),
        'stop': lambda m: robot.stop(),
        'max_speed': lambda m: robot.set_max_speed(m['value']),
        'color': lambda m: robot.set_color(m['r'], m['g'], m['b']),
        'back_led': lambda m: robot.set_back_led(m['value']),
        'aim_start': lambda m: robot.start_aim(),
        'aim': lambda m: robot.aim(m['angle']),
        'aim_finish': lambda m: robot.finish_aim(),
        'battery': lambda m: robot.refresh_battery(),
    }


async def _broadcast(app, payload):
    data = json.dumps(payload)
    for ws in list(app['sockets']):
        if not ws.closed:
            try:
                await ws.send_str(data)
            except ConnectionError:
                pass


async def websocket(request):
    app = request.app
    token = app['token']
    if token and not hmac.compare_digest(request.query.get('token', ''), token):
        raise web.HTTPUnauthorized(text='token inválido')

    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    app['sockets'].add(ws)
    robot = app['robot']
    handlers = _handlers(robot)
    await ws.send_json({'type': 'state', 'state': dict(robot.state)})
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                message = json.loads(msg.data)
                handler = handlers[message['type']]
                if message['type'] in _INSTANT:
                    reply = handler(message)
                else:
                    reply = await asyncio.to_thread(handler, message)
                if isinstance(reply, dict) and 'type' in reply:
                    await ws.send_json(reply)
            except (RobotError, KeyError, ValueError, TypeError) as e:
                await ws.send_json({'type': 'error', 'message': str(e)})
            except Exception as e:
                log.exception('command failed')
                await ws.send_json({'type': 'error', 'message': str(e) or e.__class__.__name__})
    finally:
        app['sockets'].discard(ws)
        # Nobody left holding the joystick: make sure the robot is not left rolling.
        if not app['sockets']:
            await asyncio.to_thread(robot.stop)
    return ws


async def index(request):
    return web.FileResponse(STATIC_DIR / 'index.html')


def create_app(find_toys, token=None) -> web.Application:
    app = web.Application()
    app['token'] = token
    app['sockets'] = set()

    async def startup(app):
        loop = asyncio.get_running_loop()

        def on_state(state):
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(_broadcast(app, {'type': 'state', 'state': state})))

        app['robot'] = RobotController(find_toys, on_state)

    async def cleanup(app):
        await asyncio.to_thread(app['robot'].close)

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    app.router.add_get('/', index)
    app.router.add_get('/ws', websocket)
    app.router.add_static('/static/', STATIC_DIR)
    return app
