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
  const dir = path.dirname(XRAY_CONFIG_PATH);
  const tempPath = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, XRAY_CONFIG_PATH);
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
