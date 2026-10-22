"""Run the BB-8 bridge: ``python -m bb8_app [--simulate] [--host 0.0.0.0] [--port 8088] [--token SECRET]``."""
import argparse
import asyncio
import logging
import os
import socket
import webbrowser
from functools import partial

from aiohttp import web

from bb8_app.server import create_app


def _lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.0.2.1', 9))  # no packet is sent; this only picks the outgoing interface
            return s.getsockname()[0]
    except OSError:
        return 'localhost'


def main():
    parser = argparse.ArgumentParser(description='Ponte entre o navegador e o Sphero BB-8.')
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8088)
    parser.add_argument('--token', default=os.environ.get('BB8_TOKEN'),
                        help='senha exigida pela página (ou variável BB8_TOKEN)')
    parser.add_argument('--simulate', action='store_true', help='usa um BB-8 falso, para testar sem o robô')
    parser.add_argument('--open', action='store_true', help='abre a página no navegador deste computador')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)

    if args.simulate:
        from bb8_app.simulator import simulated_find_toys
        find_toys = simulated_find_toys()
    else:
        from spherov2 import scanner
        from spherov2.toy.bb8 import BB8
        find_toys = partial(scanner.find_toys, toy_types=[BB8])

    url = f'http://{_lan_address()}:{args.port}/'
    if args.token:
        url += f'#token={args.token}'
    print(f'Abra no navegador (computador ou iPhone no mesmo Wi-Fi): {url}')
    print('Deixe esta janela aberta. Fechar a janela ou apertar Ctrl+C desliga a ponte.', flush=True)
    app = create_app(find_toys, args.token)
    if args.open:
        local_url = f'http://localhost:{args.port}/' + (f'#token={args.token}' if args.token else '')

        async def open_browser(app):
            # on_startup runs just before the port starts listening, so give it a moment.
            asyncio.get_running_loop().call_later(1.0, webbrowser.open, local_url)

        app.on_startup.append(open_browser)
    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    finally:
        print('Ponte desligada.', flush=True)


if __name__ == '__main__':
    main()
