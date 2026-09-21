/**
 * Blind Test Entre Amis - Serveur Relais Cloud WebSocket
 * 100% autonome, z√©ro d√©pendance complexe (utilise uniquement 'ws' et 'http').
 * D√©ployable gratuitement en 1 clic sur Glitch, Render, Railway, etc.
 */

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Stockage des salons en m√©moire : { roomCode: { hostWs: ws, clients: Set<ws>, track: {}, scores: {} } }
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

  // Cr√©ation de salon par API REST
  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const code = generateRoomCode();
      rooms.set(code, { hostWs: null, clients: new Set(), players: new Map() });
      console.log(`[REST] Nouveau salon cr√©√© : ${code}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: code, status: 'created' }));
    });
    return;
  }

  // Info salon par API REST
  if (url.pathname.startsWith('/api/rooms/')) {
    const code = url.pathname.split('/').pop().toUpperCase();
    const room = rooms.get(code);
    if (room) {
      const playersList = Array.from(room.players.values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, players: playersList }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room not found' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.playerName = null;
  ws.isHost = false;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (e) {
      console.error('Message JSON invalide:', e);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { hostWs: null, clients: new Set(), players: new Map() };
    rooms.set(code, room);
  }
  return room;
}

function broadcastToRoom(room, payload, excludeWs = null) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function handleMessage(ws, data) {
  const type = data.type;
  const roomCode = (data.code || data.room || '').toUpperCase().trim();

  if (!roomCode && type !== 'ping') return;
  const room = getOrCreateRoom(roomCode);

  switch (type) {
    // 1. Inscription H√¥te ou Joueur
    case 'join':
    case 'host_register': {
      const isHost = data.isHost === true || data.role === 'host' || type === 'host_register';
      const name = (data.playerName || data.name || (isHost ? 'Moi (H√¥te)' : 'Joueur')).trim();
      
      ws.roomCode = roomCode;
      ws.playerName = name;
      ws.isHost = isHost;
      room.clients.add(ws);

      if (isHost) {
        room.hostWs = ws;
        ws.send(JSON.stringify({ type: 'host_confirmed', room: roomCode, code: roomCode }));
        console.log(`[Host] Salon ${roomCode} connect√© par ${name}`);
      } else {
        room.players.set(name, { name, score: 0.0, color: data.color || '#38bdf8' });
        ws.send(JSON.stringify({ type: 'join_confirmed', room: roomCode, code: roomCode, name }));
        console.log(`[Joueur] ${name} a rejoint le salon ${roomCode}`);
      }

      // Diffusion de la liste mise √† jour des joueurs √† tous les clients du salon
      const playersList = Array.from(room.players.values());
      broadcastToRoom(room, {
        type: 'room_state',
        room: {
          code: roomCode,
          players: playersList
        },
        players: playersList
      });
      break;
    }

    // 2. Un joueur ou l'h√¥te buzze !
    case 'buzz': {
      const name = (data.playerName || data.name || ws.playerName || 'Anonyme').trim();
      const reactionMs = data.clientTime || 0;
      console.log(`[Buzz] üö® ${name} a buzz√© dans le salon ${roomCode} (${reactionMs} ms)`);
      
      const payload = {
        type: 'buzzer_pressed',
        room: roomCode,
        code: roomCode,
        name: name,
        playerName: name,
        winner: {
          name: name,
          playerName: name,
          reactionMs: reactionMs,
          timestamp: new Date().toISOString()
        }
      };
      // Diffusion imm√©diate √† tout le salon (H√¥te + tous les joueurs)
      broadcastToRoom(room, payload);
      break;
    }

    // 3. Mise √† jour du morceau (Deezer / Disney)
    case 'track_update':
    case 'start_round': {
      console.log(`[Musique] üéµ Nouvelle manche / morceau dans le salon ${roomCode} : ${data.songTitle || ''}`);
      broadcastToRoom(room, data);
      break;
    }

    // 4. Attribution d'un score (0, 0.5, 1 pt)
    case 'submit_score':
    case 'score': {
      const name = (data.playerName || data.name || '').trim();
      const pts = Number(data.points ?? 0);
      if (name && room.players.has(name)) {
        const p = room.players.get(name);
        p.score = Math.max(0, p.score + pts);
      }
      console.log(`[Score] üèÜ ${name} : ${pts} pt(s) dans le salon ${roomCode}`);
      broadcastToRoom(room, data);
      break;
    }

    // 5. Mise √† jour compl√®te des scores par l'h√¥te
    case 'scores_update':
    case 'scores': {
      broadcastToRoom(room, data);
      break;
    }

    // 6. R√©armement / Reset des buzzers pour le morceau suivant
    case 'reset': {
      console.log(`[Reset] üîÑ R√©armement du salon ${roomCode}`);
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      break;
    }

    // 7. Commandes musicales du joueur vers l'h√¥te
    case 'resume_music':
    case 'next_track': {
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(data));
      }
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }

    default: {
      // Relais transparent de tout autre √©v√©nement aux membres du salon
      broadcastToRoom(room, data, ws);
      break;
    }
  }
}

function handleDisconnect(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  room.clients.delete(ws);

  if (ws.isHost) {
    console.log(`[Host] H√¥te d√©connect√© du salon ${ws.roomCode}`);
  } else if (ws.playerName) {
    room.players.delete(ws.playerName);
    console.log(`[Joueur] ${ws.playerName} a quitt√© le salon ${ws.roomCode}`);
    const playersList = Array.from(room.players.values());
    broadcastToRoom(room, {
      type: 'room_state',
      room: { code: ws.roomCode, players: playersList },
      players: playersList
    });
  }

  // Nettoyage du salon s'il est compl√®tement vide
  if (room.clients.size === 0) {
    rooms.delete(ws.roomCode);
  }
}

// Heartbeat 30s
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`üöÄ Serveur Relais Cloud Blind Test en ligne sur le port ${PORT}`);
});
