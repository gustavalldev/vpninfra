# Add Direct VLESS Node

Этот runbook нужен, чтобы быстро добавить новую foreign VLESS-ноду без копания по старым заметкам.

## Что уже считается готовым

- `vpnbot` на control server уже работает как control plane.
- foreign node поднимается из `deploy/foreign-vless-node/docker-compose.yml`.
- `vpnbot` умеет выдавать профили через remote HTTP provisioner.

## Что нужно на новую ноду

- новый VPS
- домен или поддомен, который резолвится на IP ноды
- Docker + `docker compose` plugin
- git доступ к репозиторию `vpn-infra`

Если на сервере есть Docker, но нет `docker compose`, можно поставить plugin в user-space:

```bash
./scripts/install-user-docker-compose.sh
```

## Шаг 1. Подготовить env ноды

На локальной машине:

```bash
cp env/foreign-vless-node.generic.env.example env/server-2-sg.env
```

Для сервера `109.107.170.233` можно взять готовый шаблон:

```bash
cp env/foreign-vless-ru-02.env.example env/foreign-vless-ru-02.env
```

Заполни минимум:

- `SERVER_NAME`
- `SERVER_HOST`
- `SERVER_IP`
- `COUNTRY_CODE`
- `XRAY_SNI`
- `PROVISIONER_TOKEN`
- `VPN_BACKEND_NODES_JSON`

Правило для `VPN_BACKEND_NODES_JSON`:

- `id` должен совпадать с `SERVER_NAME`
- `host`, `ip`, `sni` должны совпадать с новой нодой
- `is_default=true` ставь только если хочешь сделать ноду сервером по умолчанию

## Шаг 2. Развернуть `vpn-infra` на новой ноде

На сервере:

```bash
mkdir -p ~/deploy
cd ~/deploy
git clone git@github.com:gustavalldev/vpninfra.git
cd vpninfra
mkdir -p deploy/foreign-vless-node/config deploy/foreign-vless-node/certs
cp env/server-2-sg.env deploy/foreign-vless-node/.env
```

Альтернатива без ручного редактирования `.env` и `config.json`:

```bash
SERVER_NAME=foreign-vless-ru-03 \
SERVER_DISPLAY_NAME="VLESS Node 3" \
SERVER_HOST=vpn.example.com \
SERVER_IP=203.0.113.10 \
COUNTRY_CODE=RU \
PROVISIONER_TOKEN=replace-with-shared-control-token \
CERT_SOURCE_DIR=/etc/letsencrypt/live/vpn.example.com \
./scripts/prepare-vless-node-runtime.sh
```

Дальше проверь, что есть:

- Xray config в `deploy/foreign-vless-node/config/config.json`
- TLS cert/key в `deploy/foreign-vless-node/certs/`

После этого подними стек:

```bash
docker compose \
  -f deploy/foreign-vless-node/docker-compose.yml \
  --env-file deploy/foreign-vless-node/.env \
  up -d --build
```

## Шаг 3. Проверить ноду

На ноде:

```bash
docker compose \
  -f deploy/foreign-vless-node/docker-compose.yml \
  --env-file deploy/foreign-vless-node/.env \
  ps
curl http://127.0.0.1:3021/health
openssl s_client -connect SERVER_HOST:443 -servername SERVER_HOST
```

Ожидаемо:

- `xray` и `provisioner` в `Up`
- `health` возвращает `ok: true`
- TLS handshake проходит на `443`

## Шаг 4. Зарегистрировать ноду в `vpnbot`

Дальше ноду нужно добавить в control plane.

Используй шаблон:

- `vpnbot/ops/register_direct_vless_node.sql.example`

После применения SQL:

- нода появится в `/api/servers`
- её можно будет выбирать в mini app
- `connect/remove` пойдут через existing `vpn-api`

## Шаг 5. Если нода должна быть default

Сделай ровно одну default-ноду:

- в SQL для новой ноды поставь `is_default=true`
- у старой ноды сними `is_default`

## Шаг 6. Smoke test

Проверь цепочку:

1. `POST /provision` на provisioner
2. клиент появился в live Xray config
3. `POST /revoke`
4. клиент удалился
5. `vpnbot` mini app умеет создать профиль на новой ноде

## Практический итог

Сейчас добавление новой ноды уже шаблонизировано, но не полностью автоматизировано.

Это означает:

- новая нода добавляется быстро и предсказуемо
- шаги повторяемые
- пока всё ещё остаются ручные действия по TLS, Xray config и SQL registration
