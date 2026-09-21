/**
 * Blind Test Entre Amis - Serveur Relais Cloud WebSocket
 * 100% autonome, zéro dépendance complexe (utilise uniquement 'ws' et 'http').
 * Déployable gratuitement en 1 clic sur Glitch, Render, Railway, etc.
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Stockage des salons en mémoire : { roomCode: { hostWs: ws, clients: Set<ws>, track: {}, scores: {} } }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/ping' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeRooms: rooms.size }));
    return;
  }

  // Création de salon par API REST
  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const code = generateRoomCode();
      rooms.set(code, { hostWs: null, clients: new Set(), players: new Map() });
      console.log(`[REST] Nouveau salon créé : ${code}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: code, status: 'created' }));
    });
    return;
  }

  // Info salon par API REST
  if (url.pathname.startsWith('/api/rooms/')) {
    const code = url.pathname.split('/').pop().toUpperCase();
    if (rooms.has(code)) {
      const r = rooms.get(code);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: code,
        playerCount: r.clients.size,
        hasHost: !!r.hostWs
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room not found' }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let userRoomCode = null;
  let userRole = null;
  let userName = null;

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('JSON invalide reçu:', message);
      return;
    }

    const type = data.type;

    // --- ENREGISTREMENT DE L'HÔTE ---
    if (type === 'register_host') {
      const code = (data.code || generateRoomCode()).toUpperCase();
      userRoomCode = code;
      userRole = 'host';
      
      let room = rooms.get(code);
      if (!room) {
        room = { hostWs: ws, clients: new Set(), players: new Map(), currentTrack: null };
        rooms.set(code, room);
      } else {
        room.hostWs = ws;
      }
      
      console.log(`[Hôte connecté] Salon ${code}`);
      ws.send(JSON.stringify({ type: 'host_registered', code: code }));
      return;
    }

    // --- CONNEXION D'UN JOUEUR / BUZZER ---
    if (type === 'join') {
      const code = (data.room || data.code || '').toUpperCase();
      userName = data.name || 'Joueur';
      userRoomCode = code;
      userRole = 'player';

      let room = rooms.get(code);
      if (!room) {
        // Crée le salon au vol si non existant
        room = { hostWs: null, clients: new Set(), players: new Map(), currentTrack: null };
        rooms.set(code, room);
      }

      room.clients.add(ws);
      room.players.set(ws, userName);
      console.log(`[Joueur connecté] ${userName} a rejoint le salon ${code} (${room.clients.size} joueurs)`);

      // Confirmer au joueur qu'il est bien dans le salon
      ws.send(JSON.stringify({
        type: 'joined',
        room: code,
        name: userName,
        currentTrack: room.currentTrack || null
      }));

      // Avertir l'hôte qu'un joueur a rejoint
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify({
          type: 'player_joined',
          name: userName,
          playerCount: room.clients.size
        }));
      }
      return;
    }

    // --- ACTIONS D'UN JOUEUR (BUZZER) ---
    if (type === 'buzz') {
      const code = (data.room || userRoomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return;

      const buzzerName = data.name || userName || 'Un joueur';
      console.log(`[BUZZ !] ${buzzerName} dans le salon ${code}`);

      const buzzMsg = JSON.stringify({
        type: 'buzzer_pressed',
        name: buzzerName,
        timestamp: Date.now()
      });

      // Transmettre à l'hôte
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(buzzMsg);
      }
      // Re-diffuser à tous les joueurs (pour bloquer leurs buzzers)
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(buzzMsg);
        }
      }
      return;
    }

    // --- ACTIONS DE L'HÔTE (DIFFUSION AUX JOUEURS) ---
    // (track_update, start_round, scores_update, reset, etc.)
    const code = (data.room || userRoomCode || '').toUpperCase();
    const room = rooms.get(code);

    if (room) {
      if (type === 'track_update') {
        room.currentTrack = data.track;
      }

      // Diffuser le message à tous les joueurs connectés au salon
      const broadcastMsg = JSON.stringify(data);
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN && client !== ws) {
          client.send(broadcastMsg);
        }
      }

      // Si le message vient d'un joueur (ex: points/score) et doit aller à l'hôte
      if (ws !== room.hostWs && room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(broadcastMsg);
      }
    }
  });

  ws.on('close', () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    if (userRole === 'host') {
      console.log(`[Hôte déconnecté] Salon ${userRoomCode}`);
      room.hostWs = null;
      // Notifier les joueurs si nécessaire
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'host_disconnected' }));
        }
      }
    } else if (userRole === 'player') {
      room.clients.delete(ws);
      room.players.delete(ws);
      console.log(`[Joueur parti] ${userName || 'Inconnu'} du salon ${userRoomCode} (reste ${room.clients.size})`);
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify({
          type: 'player_left',
          name: userName,
          playerCount: room.clients.size
        }));
      }
    }

    // Nettoyage si salon complètement vide
    if (!room.hostWs && room.clients.size === 0) {
      rooms.delete(userRoomCode);
      console.log(`[Salon supprimé] ${userRoomCode} car vide.`);
    }
  });

  ws.on('error', (err) => {
    console.error('Erreur WebSocket client:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`=============================================`);
  console.log(` Serveur Blind Test Relais démarré !`);
  console.log(` Port d'écoute : ${PORT}`);
  console.log(` Prêt à relayer les buzzers en temps réel.`);
  console.log(`=============================================`);
});
