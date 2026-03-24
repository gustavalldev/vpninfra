# Архитектура

Текущая MVP-схема:

- `vpnbot` на отдельном сервере управляет выдачей доступов
- клиент получает прямой `VLESS`-профиль
- подключение идёт напрямую к foreign VPN node

Состав:

- control plane: бот, mini app, API, provisioning backend
- data plane: foreign node с `Xray/VLESS`

Пока не реализовано:

- реальный provisioning в `Xray`
- выдача боевых `Reality`/TLS-параметров
- revoke на уровне реальной ноды
