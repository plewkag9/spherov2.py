# App do BB-8

Controle do Sphero BB-8 pelo navegador, feito sobre a biblioteca `spherov2` deste repositório.

```
iPhone / computador ──Wi-Fi──▶ ponte (este programa) ──Bluetooth──▶ BB-8
```

A ponte roda num computador ou Raspberry Pi a até uns 30 m do robô. Ela fala com o BB-8 por Bluetooth e serve uma página de controle. O iPhone não precisa de Bluetooth nem de app instalado: basta abrir a página no Safari.

## O que a página faz

- Procura e conecta ao BB-8 (o desbloqueio do robô é automático)
- Joystick para dirigir, botão de turbo e limite de velocidade
- No computador: setas ou WASD para dirigir, espaço para turbo
- Cor do LED e luz azul de trás
- Calibração da direção ("frente" do joystick)
- Bússola: desenho do BB-8 que gira junto com o robô, pelo giroscópio dele
- Estado da bateria
- Dormir e desconectar

Por segurança, o robô para sozinho se a página ficar 0,6 s sem mandar comandos (por exemplo, se o Wi-Fi cair).

## Como rodar

Precisa de Python 3.9 ou mais novo e de um computador com Bluetooth 4.0 (BLE).

```bash
pip install -r bb8_app/requirements.txt
python -m bb8_app
```

O terminal mostra o endereço para abrir, algo como `http://192.168.0.10:8088/`. Abra no navegador do computador ou no iPhone ligado ao mesmo Wi-Fi.

Para testar a página sem o robô:

```bash
python -m bb8_app --simulate
```

### No iPhone, como app

No Safari, toque em Compartilhar e depois em "Adicionar à Tela de Início". O BB-8 vira um ícone que abre em tela cheia.

### Senha

Para exigir uma senha, use `python -m bb8_app --token minhasenha` (ou a variável `BB8_TOKEN`). O terminal mostra o link com a senha, e o navegador a guarda depois do primeiro acesso. Use sempre uma senha antes de expor a ponte fora de casa.

### Raspberry Pi (Raspberry Pi OS)

```bash
sudo apt install python3-venv bluetooth bluez
python3 -m venv ~/bb8 && ~/bb8/bin/pip install -r bb8_app/requirements.txt
~/bb8/bin/python -m bb8_app --token minhasenha
```

## Testes

```bash
pip install -r bb8_app/requirements-dev.txt
python -m pytest
```

Os testes usam um BB-8 simulado (`bb8_app/simulator.py`), então rodam sem o robô.

## Próximos passos

- Acesso de fora de casa (túnel seguro do Raspberry Pi para a internet)
- Acordar o robô à distância
- Gestos, sons do BB-8, modo patrulha e comandos de voz
