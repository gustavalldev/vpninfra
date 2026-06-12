const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const Docker = require('dockerode');

require('dotenv').config();

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const PORT = parseInt(process.env.PROVISIONER_PORT || '3021', 10);
const TOKEN = process.env.PROVISIONER_TOKEN || '';
const DEFAULT_PROTOCOL = process.env.VPN_BACKEND_PROTOCOL || 'VLESS';
const DEFAULT_PROFILE_FORMAT = process.env.VPN_BACKEND_PROFILE_FORMAT || 'uri';
const NODES_JSON = process.env.VPN_BACKEND_NODES_JSON || '';
const XRAY_CONFIG_PATH = process.env.XRAY_CONFIG_PATH || '/data/xray-config.json';
const XRAY_CONTAINER_NAME = process.env.XRAY_CONTAINER_NAME || 'foreign-vless-xray';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

app.use(express.json());

let queue = Promise.resolve();

function normalizeNode(node, index = 0) {
  return {
    id: node.id || `node-${index + 1}`,
    name: node.name || `Node ${index + 1}`,
    protocol: node.protocol || DEFAULT_PROTOCOL,
    profile_format: node.profile_format || DEFAULT_PROFILE_FORMAT,
    enabled: node.enabled !== false,
    is_default: Boolean(node.is_default),
    host: node.host || node.ip || '127.0.0.1',
    ip: node.ip || node.host || '127.0.0.1',
    port: Number(node.port) || 443,
    country_code: node.country_code || 'SG',
    transport: node.transport || 'tcp',
    security: node.security || 'tls',
    sni: node.sni || node.host || node.ip || '127.0.0.1'
  };
}

function getNodes() {
  if (NODES_JSON) {
    try {
      const parsed = JSON.parse(NODES_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((node, index) => normalizeNode(node, index));
      }
    } catch (error) {
      console.warn('VPN_BACKEND_NODES_JSON невалиден:', error.message);
    }
  }

  return [
    normalizeNode({
      id: 'foreign-vless-main',
      name: 'Foreign VLESS Main',
      is_default: true,
      host: 'vpnserv1.ordbox.ru',
      ip: '176.98.191.110',
      country_code: 'SG',
      port: 443,
      transport: 'tcp',
      security: 'tls',
      sni: 'vpnserv1.ordbox.ru'
    })
  ];
}

function resolveNode(_profile, server) {
  const nodes = getNodes().filter(node => node.enabled);
  if (nodes.length === 0) {
    throw new Error('Нет доступных VPN-нод');
  }

  const preferredId = server?.node_id || server?.route_id || server?.id;
  if (preferredId) {
    return nodes.find(node => node.id === preferredId) || null;
  }

  return nodes.find(node => node.is_default) || nodes[0];
}

function uuidFromToken(token) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return token;
  }

  const hex = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-');
}

function buildAccessUri({ profile, node }) {
  const uuid = uuidFromToken(profile.token);
  const query = new URLSearchParams({
    encryption: 'none',
    type: node.transport,
    security: node.security,
    sni: node.sni
  });

  return `vless://${uuid}@${node.host}:${node.port}?${query.toString()}#${encodeURIComponent(profile.name)}`;
}

function buildConfigPayload({ profile, node, user }) {
  return {
    version: 1,
    protocol: node.protocol,
    profile_name: profile.name,
    profile_id: profile.id,
    node: {
      id: node.id,
      name: node.name,
      host: node.host,
      ip: node.ip,
      port: node.port,
      country_code: node.country_code,
      transport: node.transport,
      security: node.security,
      sni: node.sni
    },
    user: {
      telegram_id: user.id,
      username: user.username || null
    },
    client_import: {
      format: node.profile_format,
      access_uri: buildAccessUri({ profile, node })
    },
    notes: [
      'Профиль добавлен в live Xray config на foreign-нoде.',
      'Для полноценного прод-TLS нужен валидный сертификат на тот же hostname.'
    ]
  };
}

function parseUuidFromAccessUri(accessUri) {
  if (!accessUri) {
    return null;
  }

  try {
    const match = String(accessUri).match(/^vless:\/\/([^@]+)@/i);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

async function loadConfig() {
  const raw = await fs.readFile(XRAY_CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

async function saveConfig(config) {
  await fs.writeFile(XRAY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function getVlessInbound(config) {
  if (!Array.isArray(config.inbounds)) {
    throw new Error('Xray config не содержит inbounds');
  }

  const inbound = config.inbounds.find(item => item?.protocol === 'vless');
  if (!inbound?.settings) {
    throw new Error('Не найден VLESS inbound');
  }

  if (!Array.isArray(inbound.settings.clients)) {
    inbound.settings.clients = [];
  }

  return inbound;
}

async function restartXray() {
  const container = docker.getContainer(XRAY_CONTAINER_NAME);
  await container.restart();
}

function withQueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function requireAuth(req, res, next) {
  if (!TOKEN) {
    return next();
  }

  const header = req.get('authorization') || '';
  if (header === `Bearer ${TOKEN}`) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    return res.status(404).send('Admin is not configured');
  }

  const header = req.get('authorization') || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const username = separator >= 0 ? decoded.slice(0, separator) : '';
      const password = separator >= 0 ? decoded.slice(separator + 1) : '';
      if (safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD)) {
        return next();
      }
    } catch (_error) {
      // Fall through to the auth challenge.
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="VLESS Admin", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

function adminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VLESS Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #172033;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f5f7fb; }
    main { width: min(960px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; }
    .status { color: #4d5b73; font-size: 14px; }
    .panel { background: #fff; border: 1px solid #d8deea; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    input { height: 40px; min-width: 240px; border: 1px solid #c6cedd; border-radius: 6px; padding: 0 12px; font: inherit; background: #fff; color: inherit; }
    button { height: 40px; border: 0; border-radius: 6px; padding: 0 14px; font: inherit; cursor: pointer; background: #1167d8; color: #fff; }
    button.secondary { background: #e8edf5; color: #172033; }
    button.danger { background: #c9362c; color: #fff; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid #edf0f6; font-size: 14px; vertical-align: middle; }
    th { color: #5b667a; font-weight: 600; }
    code, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    textarea { width: 100%; min-height: 92px; resize: vertical; border: 1px solid #c6cedd; border-radius: 6px; padding: 10px; background: #fff; color: inherit; }
    .empty, .error { padding: 14px 0; color: #5b667a; }
    .error { color: #b42318; }
    @media (prefers-color-scheme: dark) {
      :root, body { background: #111827; color: #eef2f7; }
      .panel { background: #172033; border-color: #2c374b; }
      input, textarea { background: #111827; border-color: #3a465b; }
      th, .status, .empty { color: #aab4c5; }
      button.secondary { background: #2c374b; color: #eef2f7; }
      th, td { border-color: #263044; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>VLESS Admin</h1>
        <div id="status" class="status">Loading</div>
      </div>
      <button class="secondary" id="refresh" type="button">Refresh</button>
    </header>

    <section class="panel">
      <form id="create" class="row">
        <input id="clientName" name="name" autocomplete="off" placeholder="client-name" required>
        <button type="submit">Create Profile</button>
      </form>
    </section>

    <section class="panel" id="resultPanel" hidden>
      <textarea id="result" readonly></textarea>
      <div class="row" style="margin-top: 10px;">
        <button class="secondary" id="copy" type="button">Copy</button>
      </div>
    </section>

    <section class="panel">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>UUID</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="clients"></tbody>
      </table>
      <div id="empty" class="empty" hidden>No clients</div>
      <div id="error" class="error" hidden></div>
    </section>
  </main>
  <script>
    const clientsEl = document.getElementById('clients');
    const emptyEl = document.getElementById('empty');
    const errorEl = document.getElementById('error');
    const statusEl = document.getElementById('status');
    const resultPanel = document.getElementById('resultPanel');
    const resultEl = document.getElementById('result');

    function setError(message) {
      errorEl.hidden = !message;
      errorEl.textContent = message || '';
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || response.statusText);
      }
      return data;
    }

    function renderClients(clients) {
      clientsEl.innerHTML = '';
      emptyEl.hidden = clients.length > 0;
      for (const client of clients) {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        const id = document.createElement('td');
        const action = document.createElement('td');
        const revoke = document.createElement('button');
        revoke.className = 'danger';
        revoke.type = 'button';
        revoke.textContent = 'Remove';
        revoke.addEventListener('click', async () => {
          if (!confirm('Remove ' + client.email + '?')) return;
          await api('/admin/api/clients/revoke', {
            method: 'POST',
            body: JSON.stringify({ id: client.id, email: client.email })
          });
          await load();
        });
        name.textContent = client.email || '';
        id.innerHTML = '<code></code>';
        id.querySelector('code').textContent = client.id || '';
        action.appendChild(revoke);
        tr.append(name, id, action);
        clientsEl.appendChild(tr);
      }
    }

    async function load() {
      setError('');
      try {
        const data = await api('/admin/api/clients');
        renderClients(data.clients || []);
        statusEl.textContent = (data.node?.name || 'Node') + ' - ' + (data.clients?.length || 0) + ' clients';
      } catch (error) {
        setError(error.message);
        statusEl.textContent = 'Error';
      }
    }

    document.getElementById('create').addEventListener('submit', async (event) => {
      event.preventDefault();
      setError('');
      const name = document.getElementById('clientName').value.trim();
      try {
        const data = await api('/admin/api/clients', {
          method: 'POST',
          body: JSON.stringify({ name })
        });
        resultEl.value = data.access_uri;
        resultPanel.hidden = false;
        event.target.reset();
        await load();
      } catch (error) {
        setError(error.message);
      }
    });

    document.getElementById('copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(resultEl.value);
    });
    document.getElementById('refresh').addEventListener('click', load);
    load();
  </script>
</body>
</html>`;
}

app.get('/health', async (_req, res) => {
  try {
    const config = await loadConfig();
    const inbound = getVlessInbound(config);
    res.json({
      ok: true,
      status: 'running',
      xray_container: XRAY_CONTAINER_NAME,
      clients: inbound.settings.clients.length,
      nodes: getNodes().map(node => ({
        id: node.id,
        name: node.name,
        enabled: node.enabled
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.type('html').send(adminHtml());
});

app.get('/admin/api/clients', requireAdmin, async (_req, res) => {
  try {
    const config = await loadConfig();
    const inbound = getVlessInbound(config);
    const node = resolveNode({}, {});
    res.json({
      ok: true,
      node: {
        id: node.id,
        name: node.name,
        host: node.host,
        port: node.port
      },
      clients: inbound.settings.clients.map(client => ({
        id: client.id,
        email: client.email || ''
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/api/clients', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      return res.status(400).json({ error: 'Use 1-64 chars: letters, numbers, dot, underscore, dash' });
    }

    const profile = {
      id: `admin-${Date.now()}`,
      name,
      token: crypto.randomUUID()
    };
    const user = {
      id: 1,
      username: ADMIN_USERNAME
    };
    const node = resolveNode(profile, {});
    const uuid = uuidFromToken(profile.token);

    await withQueue(async () => {
      const config = await loadConfig();
      const inbound = getVlessInbound(config);
      const clients = inbound.settings.clients;
      const existingIndex = clients.findIndex(client => client?.id === uuid || client?.email === profile.name);
      const nextClient = {
        id: uuid,
        email: profile.name
      };

      if (existingIndex >= 0) {
        clients[existingIndex] = nextClient;
      } else {
        clients.push(nextClient);
      }

      await saveConfig(config);
      await restartXray();
    });

    res.json({
      ok: true,
      access_uri: buildAccessUri({ profile, node }),
      config_payload: buildConfigPayload({ profile, node, user }),
      client: {
        id: uuid,
        email: profile.name
      }
    });
  } catch (error) {
    console.error('Ошибка admin create client:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/api/clients/revoke', requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!id && !email) {
      return res.status(400).json({ error: 'id or email is required' });
    }

    let removed = 0;
    await withQueue(async () => {
      const config = await loadConfig();
      const inbound = getVlessInbound(config);
      const currentCount = inbound.settings.clients.length;
      inbound.settings.clients = inbound.settings.clients.filter(client => {
        if (id && client?.id === id) {
          return false;
        }
        if (email && client?.email === email) {
          return false;
        }
        return true;
      });
      removed = currentCount - inbound.settings.clients.length;
      if (removed > 0) {
        await saveConfig(config);
        await restartXray();
      }
    });

    res.json({ ok: true, removed });
  } catch (error) {
    console.error('Ошибка admin revoke client:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/provision', requireAuth, async (req, res) => {
  try {
    const { profile, server, user } = req.body || {};

    if (!profile?.name || !profile?.id || !profile?.token) {
      return res.status(400).json({ error: 'profile.name, profile.id и profile.token обязательны' });
    }

    if (!user?.id) {
      return res.status(400).json({ error: 'user.id обязателен' });
    }

    const node = resolveNode(profile, server);
    if (!node) {
      return res.status(404).json({ error: 'VPN-нода не найдена' });
    }

    const uuid = uuidFromToken(profile.token);

    await withQueue(async () => {
      const config = await loadConfig();
      const inbound = getVlessInbound(config);
      const clients = inbound.settings.clients;
      const existingIndex = clients.findIndex(client => client?.id === uuid || client?.email === profile.name);
      const nextClient = {
        id: uuid,
        email: profile.name
      };

      if (existingIndex >= 0) {
        clients[existingIndex] = nextClient;
      } else {
        clients.push(nextClient);
      }

      await saveConfig(config);
      await restartXray();
    });

    const accessUri = buildAccessUri({ profile, node });
    const configPayload = buildConfigPayload({ profile, node, user });

    res.json({
      protocol: node.protocol,
      profile_format: node.profile_format,
      access_uri: accessUri,
      config_payload: configPayload,
      download_name: `${profile.name}.${node.profile_format === 'uri' ? 'txt' : 'json'}`,
      meta: {
        node_id: node.id,
        node_name: node.name,
        country_code: node.country_code,
        host: node.host,
        port: node.port,
        live: true
      }
    });
  } catch (error) {
    console.error('Ошибка provision:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/revoke', requireAuth, async (req, res) => {
  try {
    const { peer } = req.body || {};
    const peerName = peer?.name || null;
    const uuid = parseUuidFromAccessUri(peer?.access_uri);

    await withQueue(async () => {
      const config = await loadConfig();
      const inbound = getVlessInbound(config);
      const currentCount = inbound.settings.clients.length;
      inbound.settings.clients = inbound.settings.clients.filter(client => {
        if (uuid && client?.id === uuid) {
          return false;
        }

        if (peerName && client?.email === peerName) {
          return false;
        }

        return true;
      });

      if (inbound.settings.clients.length !== currentCount) {
        await saveConfig(config);
        await restartXray();
      }
    });

    res.json({
      ok: true,
      revoked_profile: peerName
    });
  } catch (error) {
    console.error('Ошибка revoke:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Xray provisioner listening on port ${PORT}`);
});
