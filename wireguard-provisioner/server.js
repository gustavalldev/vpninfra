const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

require('dotenv').config();

const app = express();

const HOST = process.env.PROVISIONER_HOST || '127.0.0.1';
const PORT = parseInt(process.env.PROVISIONER_PORT || '3021', 10);
const TOKEN = process.env.PROVISIONER_TOKEN || '';
const WG_INTERFACE = process.env.WG_INTERFACE || 'wg0';
const WG_CONFIG_DIR = process.env.WG_CONFIG_DIR || '/etc/wireguard';
const WG_CONFIG_PATH = process.env.WG_CONFIG_PATH || path.join(WG_CONFIG_DIR, `${WG_INTERFACE}.conf`);
const WG_STATE_PATH = process.env.WG_STATE_PATH || path.join(WG_CONFIG_DIR, `${WG_INTERFACE}.state.json`);
const WG_ADDRESS = process.env.WG_ADDRESS || '10.66.0.1/24';
const WG_SUBNET = process.env.WG_SUBNET || '10.66.0.0/24';
const WG_CLIENT_DNS = process.env.WG_CLIENT_DNS || '1.1.1.1';
const WG_CLIENT_ALLOWED_IPS = process.env.WG_CLIENT_ALLOWED_IPS || '0.0.0.0/0';
const WG_ENDPOINT = process.env.WG_ENDPOINT || '';
const WG_PORT = parseInt(process.env.WG_PORT || '51820', 10);
const WG_MTU = process.env.WG_MTU || '1420';
const WG_PERSISTENT_KEEPALIVE = process.env.WG_PERSISTENT_KEEPALIVE || '25';
const WG_EGRESS_INTERFACE = process.env.WG_EGRESS_INTERFACE || '';
const DEFAULT_NODE_ID = process.env.WG_NODE_ID || 'wgserv-wireguard-02';
const DEFAULT_NODE_NAME = process.env.WG_NODE_NAME || 'WGServ WireGuard 02';
const DEFAULT_COUNTRY_CODE = process.env.WG_COUNTRY_CODE || 'DE';

app.use(express.json({ limit: '1mb' }));

let queue = Promise.resolve();

function sh(command, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-lc', command], options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function withQueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function requireAuth(req, res, next) {
  if (!TOKEN) return next();

  const header = req.get('authorization') || '';
  if (header === `Bearer ${TOKEN}`) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

async function genkey() {
  return sh('wg genkey');
}

async function pubkey(privateKey) {
  return sh(`printf %s '${privateKey.replace(/'/g, "'\\''")}' | wg pubkey`);
}

async function genpsk() {
  return sh('wg genpsk');
}

function parseIpv4(cidr) {
  const [ip, prefix = '32'] = String(cidr).split('/');
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`Некорректная IPv4-сеть: ${cidr}`);
  }

  return {
    base: (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0,
    prefix: Number(prefix)
  };
}

function ipv4ToString(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

function allocateAddress(peers) {
  const subnet = parseIpv4(WG_SUBNET);
  const size = 2 ** (32 - subnet.prefix);
  const used = new Set(peers.map(peer => String(peer.address).split('/')[0]));

  for (let offset = 2; offset < size - 1; offset += 1) {
    const candidate = ipv4ToString((subnet.base + offset) >>> 0);
    if (!used.has(candidate)) return `${candidate}/32`;
  }

  throw new Error('В WireGuard subnet закончились адреса');
}

async function loadState() {
  const state = await readJson(WG_STATE_PATH, null);
  if (state?.server_private_key && state?.server_public_key && Array.isArray(state.peers)) {
    return state;
  }

  const serverPrivateKey = await genkey();
  return {
    version: 1,
    interface: WG_INTERFACE,
    server_private_key: serverPrivateKey,
    server_public_key: await pubkey(serverPrivateKey),
    peers: []
  };
}

function buildServerConfig(state) {
  const lines = [
    '[Interface]',
    `Address = ${WG_ADDRESS}`,
    `ListenPort = ${WG_PORT}`,
    `PrivateKey = ${state.server_private_key}`,
    ''
  ];

  for (const peer of state.peers) {
    lines.push('[Peer]');
    lines.push(`PublicKey = ${peer.public_key}`);
    if (peer.preshared_key) lines.push(`PresharedKey = ${peer.preshared_key}`);
    lines.push(`AllowedIPs = ${peer.address}`);
    lines.push(`# Name = ${peer.name}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function buildClientConfig(state, peer) {
  const address = String(peer.address).split('/')[0];
  const endpoint = WG_ENDPOINT || `${DEFAULT_NODE_ID}:${WG_PORT}`;
  const lines = [
    '[Interface]',
    `PrivateKey = ${peer.private_key}`,
    `Address = ${address}/32`,
    `DNS = ${WG_CLIENT_DNS}`,
    `MTU = ${WG_MTU}`,
    '',
    '[Peer]',
    `PublicKey = ${state.server_public_key}`,
    `PresharedKey = ${peer.preshared_key}`,
    `Endpoint = ${endpoint}`,
    `AllowedIPs = ${WG_CLIENT_ALLOWED_IPS}`,
    `PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}`
  ];

  return `${lines.join('\n')}\n`;
}

async function defaultRouteInterface() {
  if (WG_EGRESS_INTERFACE) return WG_EGRESS_INTERFACE;
  const route = await sh("ip route show default | awk '{print $5; exit}'");
  if (!route) throw new Error('Не удалось определить default egress interface');
  return route;
}

async function ensureFirewall() {
  const egress = await defaultRouteInterface();
  await sh('sysctl -w net.ipv4.ip_forward=1 >/dev/null');
  await sh(`iptables -C FORWARD -i ${WG_INTERFACE} -j ACCEPT 2>/dev/null || iptables -A FORWARD -i ${WG_INTERFACE} -j ACCEPT`);
  await sh(`iptables -C FORWARD -o ${WG_INTERFACE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -o ${WG_INTERFACE} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`);
  await sh(`iptables -t nat -C POSTROUTING -s ${WG_SUBNET} -o ${egress} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${WG_SUBNET} -o ${egress} -j MASQUERADE`);
}

async function applyWireGuard(state) {
  await fs.mkdir(path.dirname(WG_CONFIG_PATH), { recursive: true, mode: 0o700 });
  await fs.writeFile(WG_CONFIG_PATH, buildServerConfig(state), { mode: 0o600 });
  await ensureFirewall();

  try {
    await sh(`ip link show ${WG_INTERFACE} >/dev/null 2>&1`);
    await sh(`wg-quick strip ${WG_CONFIG_PATH} > /tmp/${WG_INTERFACE}.sync && wg syncconf ${WG_INTERFACE} /tmp/${WG_INTERFACE}.sync`);
  } catch (_error) {
    await sh(`wg-quick up ${WG_CONFIG_PATH}`);
  }
}

async function saveAndApply(state) {
  await writeJson(WG_STATE_PATH, state);
  await applyWireGuard(state);
}

function resolvePeerMatch(peer, requestPeer) {
  const requestName = requestPeer?.name || null;
  const requestId = requestPeer?.id || null;
  return (
    (requestName && peer.name === requestName) ||
    (requestId && peer.profile_id === requestId)
  );
}

app.get('/health', async (_req, res) => {
  try {
    const state = await loadState();
    let interface_up = false;
    try {
      await sh(`ip link show ${WG_INTERFACE} >/dev/null 2>&1`);
      interface_up = true;
    } catch (_error) {
      interface_up = false;
    }

    res.json({
      ok: true,
      status: interface_up ? 'running' : 'configured',
      interface: WG_INTERFACE,
      listen_port: WG_PORT,
      peers: state.peers.length,
      nodes: [{
        id: DEFAULT_NODE_ID,
        name: DEFAULT_NODE_NAME,
        enabled: true,
        country_code: DEFAULT_COUNTRY_CODE
      }]
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/provision', requireAuth, async (req, res) => {
  try {
    const { profile, user } = req.body || {};
    if (!profile?.name || !profile?.id) {
      return res.status(400).json({ error: 'profile.name и profile.id обязательны' });
    }

    const result = await withQueue(async () => {
      const state = await loadState();
      const existingIndex = state.peers.findIndex(peer => peer.name === profile.name || peer.profile_id === profile.id);
      const privateKey = existingIndex >= 0 ? state.peers[existingIndex].private_key : await genkey();
      const nextPeer = {
        name: profile.name,
        profile_id: profile.id,
        private_key: privateKey,
        public_key: await pubkey(privateKey),
        preshared_key: existingIndex >= 0 ? state.peers[existingIndex].preshared_key : await genpsk(),
        address: existingIndex >= 0 ? state.peers[existingIndex].address : allocateAddress(state.peers),
        user: user || null,
        created_at: existingIndex >= 0 ? state.peers[existingIndex].created_at : new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      if (existingIndex >= 0) {
        state.peers[existingIndex] = nextPeer;
      } else {
        state.peers.push(nextPeer);
      }

      await saveAndApply(state);
      return { state, peer: nextPeer };
    });

    const clientConfig = buildClientConfig(result.state, result.peer);
    res.json({
      protocol: 'WireGuard',
      profile_format: 'conf',
      access_uri: null,
      config_payload: {
        wireguard_config: clientConfig,
        client: {
          name: result.peer.name,
          address: result.peer.address,
          public_key: result.peer.public_key
        },
        server: {
          public_key: result.state.server_public_key,
          endpoint: WG_ENDPOINT,
          port: WG_PORT,
          country_code: DEFAULT_COUNTRY_CODE
        }
      },
      download_name: `${profile.name}.conf`,
      meta: {
        node_id: DEFAULT_NODE_ID,
        node_name: DEFAULT_NODE_NAME,
        country_code: DEFAULT_COUNTRY_CODE,
        port: WG_PORT,
        live: true
      }
    });
  } catch (error) {
    console.error('Ошибка provision:', error.message);
    res.status(500).json({ error: error.message, details: error.stderr || undefined });
  }
});

app.post('/revoke', requireAuth, async (req, res) => {
  try {
    const { peer } = req.body || {};
    const result = await withQueue(async () => {
      const state = await loadState();
      const before = state.peers.length;
      state.peers = state.peers.filter(item => !resolvePeerMatch(item, peer));
      if (state.peers.length !== before) {
        await saveAndApply(state);
      }
      return { removed: before - state.peers.length };
    });

    res.json({
      ok: true,
      revoked_profile: peer?.name || null,
      removed: result.removed
    });
  } catch (error) {
    console.error('Ошибка revoke:', error.message);
    res.status(500).json({ error: error.message, details: error.stderr || undefined });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`WireGuard provisioner listening on ${HOST}:${PORT}`);
});
