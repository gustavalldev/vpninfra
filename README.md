# VPN Infra

Отдельный репозиторий для инфраструктуры VPN.

Здесь хранятся:
- шаблоны конфигураций серверов
- шаблоны env-файлов
- описания VPN-нод
- deploy/ops-документация
- вспомогательные infra-скрипты

Здесь не хранятся:
- реальные токены
- приватные ключи
- пароли
- боевые `.env`

## Что есть для direct VLESS

- `deploy/foreign-vless-node/docker-compose.yml` - Xray + remote provisioner
- `provisioner/` - HTTP backend для live `provision/revoke` клиентов в Xray
- `env/foreign-vless-node.env.example` - пример env для foreign-ноды
- `env/foreign-vless-node.generic.env.example` - generic env-шаблон для новой ноды
- `docs/ADD_VLESS_NODE.md` - runbook для добавления новой VLESS-ноды

## Текущая архитектура

Сейчас целевая схема простая:

- `vpnbot` выступает как control plane
- клиент подключается напрямую к foreign VPN node
- пользовательский транспорт: `VLESS`

RU entry-сервер как промежуточный hop в этой версии не используется.
