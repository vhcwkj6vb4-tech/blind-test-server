/**
 * Blind Test Entre Amis - Serveur Relais Cloud WebSocket
 * 100% autonome, z√©ro d√©pendance complexe (utilise uniquement 'ws' et 'http').
 * D√©ployable gratuitement en 1 clic sur Glitch, Render, Railway, etc.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
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

  // 1. Acc√®s au Buzzer Web pour n'importe quel navigateur (Smartphone Android/iPhone, PC, Mac)
  if (url.pathname === '/' || url.pathname === '/buzzer' || url.pathname === '/play' || url.pathname.startsWith('/room/')) {
    const htmlPath = path.join(__dirname, 'public_index.html');
    let htmlContent = '';
    if (fs.existsSync(htmlPath)) {
      htmlContent = fs.readFileSync(htmlPath, 'utf8');
    } else {
      htmlContent = EMBEDDED_HTML;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
    return;
  }

  // Health check
  if (url.pathname === '/health' || url.pathname === '/ping') {
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
      rooms.set(code, {
        hostWs: null,
        clients: new Set(),
        players: new Map(),
        currentWinner: null,
        lockedPlayers: new Set()
      });
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
    room = {
      hostWs: null,
      clients: new Set(),
      players: new Map(),
      currentWinner: null,
      lockedPlayers: new Set()
    };
    rooms.set(code, room);
  }
  if (!room.clients) room.clients = new Set();
  if (!room.players) room.players = new Map();
  if (!room.lockedPlayers) room.lockedPlayers = new Set();
  if (room.currentWinner === undefined) room.currentWinner = null;
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
        if (room.players.has(name)) {
          const existing = room.players.get(name);
          existing.color = data.color || existing.color || '#38bdf8';
          console.log(`[Joueur] ${name} s'est reconnect√© au salon ${roomCode} avec un score conserv√© de ${existing.score} pt(s)`);
        } else {
          room.players.set(name, { name, score: 0.0, color: data.color || '#38bdf8' });
          console.log(`[Joueur] ${name} a rejoint le salon ${roomCode}`);
        }
        ws.send(JSON.stringify({ type: 'join_confirmed', room: roomCode, code: roomCode, name }));
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
      const normalizedName = name.toLowerCase();

      // R√®gle 1 : Si un vainqueur est d√©j√† enregistr√© sur cette manche, bloquer tout buzz concurrent
      if (room.currentWinner !== null) {
        console.log(`[Buzz Ignor√©] ‚õîÔ∏è ${name} a buzz√© trop tard (Vainqueur d√©j√† valid√© : ${room.currentWinner})`);
        return;
      }

      // R√®gle 2 : Un joueur ne peut pas buzzer 2 fois sur le m√™me morceau
      if (room.lockedPlayers.has(normalizedName)) {
        console.log(`[Buzz Ignor√©] ‚õîÔ∏è ${name} a d√©j√† buzz√© sur ce morceau !`);
        return;
      }

      // Arbitrage strict du vainqueur unique
      room.currentWinner = name;
      room.lockedPlayers.add(normalizedName);
      console.log(`[Buzz Valid√© !] üëë ${name} est le vainqueur unique dans le salon ${roomCode} (${reactionMs} ms)`);
      
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
      room.currentWinner = null;
      room.lockedPlayers.clear();
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

    // 6. R√©armement / Reset des buzzers pour le morceau suivant ou relance
    case 'reset': {
      console.log(`[Reset] üîÑ R√©armement du salon ${roomCode}`);
      room.currentWinner = null;
      // Note : on ne vide PAS lockedPlayers ici pour laisser le joueur pr√©c√©dent bloqu√© si on relance pour les autres
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      break;
    }

    // 7. Commandes musicales du joueur vers l'h√¥te
    case 'resume_music': {
      console.log(`[Relance Musique] ‚ñ∂Ô∏è Demand√©e par ${ws.playerName || 'joueur'} dans le salon ${roomCode}`);
      room.currentWinner = null;
      // Diffuse le reset pour d√©bloquer les AUTRES joueurs
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(data));
      }
      break;
    }

    case 'next_track': {
      console.log(`[Morceau Suivant] ‚è≠Ô∏è Demand√© par ${ws.playerName || 'joueur'} dans le salon ${roomCode}`);
      room.currentWinner = null;
      room.lockedPlayers.clear();
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(data));
      }
      break;
    }

    case 'track_countdown': {
      broadcastToRoom(room, data, ws);
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
    // Note: On ne supprime PAS le joueur de room.players pour pr√©server son score en cas de micro-coupure r√©seau
    console.log(`[Joueur] D√©connexion temporaire de ${ws.playerName} dans le salon ${ws.roomCode} (score conserv√©)`);
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


// Embedded HTML Fallback for zero-dependency standalone cloud deployment
const EMBEDDED_HTML = "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n  <title>\ud83d\udd14 Mon Buzzer - Blind Test entre amis</title>\n  <style>\n    * {\n      box-sizing: border-box;\n      margin: 0;\n      padding: 0;\n      user-select: none;\n      -webkit-user-select: none;\n      -webkit-tap-highlight-color: transparent;\n    }\n    body {\n      background: #0b0f19;\n      color: #ffffff;\n      font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Display\", \"Segoe UI\", Roboto, sans-serif;\n      min-height: 100vh;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: space-between;\n      padding: 12px 16px 20px 16px;\n      overflow-x: hidden;\n      overflow-y: auto;\n    }\n\n    .container {\n      width: 100%;\n      max-width: 420px;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      gap: 12px;\n      flex: 1;\n    }\n\n    /* 1. BARRE SUP\u00c9RIEURE IDENTIQUE \u00c0 L'H\u00d4TE */\n    .top-bar {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      padding: 4px 0;\n    }\n    .room-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(56, 189, 248, 0.15);\n      color: #38bdf8;\n      padding: 4px 10px;\n      border-radius: 10px;\n      font-size: 0.75rem;\n      font-weight: 800;\n      letter-spacing: 1px;\n    }\n    .connection-dot {\n      width: 8px;\n      height: 8px;\n      border-radius: 50%;\n      background: #10b981;\n    }\n    .round-title {\n      font-size: 1.15rem;\n      font-weight: 900;\n      color: #facc15;\n      letter-spacing: 0.5px;\n      text-transform: uppercase;\n    }\n    .score-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(255, 255, 255, 0.1);\n      padding: 6px 12px;\n      border-radius: 20px;\n      font-size: 0.9rem;\n      font-weight: 800;\n      color: #facc15;\n    }\n\n    /* 2. BARRE LECTEUR DEEZER INT\u00c9GR\u00c9 */\n    .player-bar {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      gap: 10px;\n      background: rgba(255, 255, 255, 0.08);\n      border-radius: 16px;\n      padding: 8px 12px;\n    }\n    .play-icon {\n      width: 32px;\n      height: 32px;\n      border-radius: 50%;\n      background: #06b6d4;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-size: 0.9rem;\n      color: #fff;\n      flex-shrink: 0;\n    }\n    .track-info {\n      display: flex;\n      flex-direction: column;\n      flex: 1;\n      min-width: 0;\n    }\n    .track-number {\n      font-size: 0.85rem;\n      font-weight: 800;\n      color: #ffffff;\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n    }\n    .track-status {\n      font-size: 0.72rem;\n      color: #94a3b8;\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n    }\n    .player-pill {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(255, 255, 255, 0.1);\n      padding: 4px 10px;\n      border-radius: 12px;\n      font-size: 0.8rem;\n      font-weight: 700;\n      flex-shrink: 0;\n    }\n    .player-dot {\n      width: 10px;\n      height: 10px;\n      border-radius: 50%;\n      background: #ef4444;\n    }\n\n    /* BARRE DES SCORES EN DIRECT (TOUS LES JOUEURS + H\u00d4TE) */\n    .leaderboard-strip {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      overflow-x: auto;\n      padding: 6px 4px;\n      background: rgba(255, 255, 255, 0.05);\n      border-radius: 14px;\n      scrollbar-width: none;\n      -webkit-overflow-scrolling: touch;\n    }\n    .leaderboard-strip::-webkit-scrollbar { display: none; }\n    .leaderboard-chip {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      padding: 5px 10px;\n      border-radius: 12px;\n      background: rgba(255, 255, 255, 0.08);\n      font-size: 0.8rem;\n      font-weight: 700;\n      white-space: nowrap;\n      flex-shrink: 0;\n      border: 1px solid rgba(255, 255, 255, 0.1);\n    }\n    .leaderboard-chip.is-host {\n      border-color: #facc15;\n      background: rgba(250, 204, 21, 0.15);\n      color: #facc15;\n    }\n    .leaderboard-chip.is-me {\n      border-color: #38bdf8;\n      background: rgba(56, 189, 248, 0.15);\n      color: #38bdf8;\n    }\n    .chip-name { font-weight: 800; }\n    .chip-score { font-weight: 900; color: #fff; }\n\n    /* 3. LE BUZZER G\u00c9ANT (\u00c9TAT ATTENTE) */\n    .buzzer-area {\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      width: 100%;\n      flex: 1;\n      min-height: 320px;\n    }\n    .buzzer-btn {\n      width: 240px;\n      height: 240px;\n      border-radius: 50%;\n      border: 8px solid rgba(255, 255, 255, 0.2);\n      background: radial-gradient(circle at 35% 35%, #ff5e62, #e11d48 70%);\n      box-shadow: \n        0 15px 35px rgba(225, 29, 72, 0.5),\n        inset 0 -8px 12px rgba(0, 0, 0, 0.4),\n        inset 0 8px 12px rgba(255, 255, 255, 0.4);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      cursor: pointer;\n      transition: transform 0.08s, box-shadow 0.08s;\n    }\n    .buzzer-btn:active {\n      transform: scale(0.92);\n      box-shadow: \n        0 5px 15px rgba(225, 29, 72, 0.7),\n        inset 0 4px 8px rgba(0, 0, 0, 0.6);\n    }\n    .buzzer-text {\n      font-size: 2.3rem;\n      font-weight: 900;\n      letter-spacing: 2px;\n      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);\n    }\n    .buzzer-sub {\n      font-size: 0.85rem;\n      font-weight: 700;\n      opacity: 0.85;\n      text-transform: uppercase;\n      margin-top: 4px;\n    }\n    .status-msg-waiting {\n      color: #94a3b8;\n      font-size: 1rem;\n      font-weight: 700;\n      margin-top: 16px;\n      text-align: center;\n    }\n\n    /* 4. \u00c9TAT LORSQU'UN JOUEUR BUZZE (IDENTIQUE HOSTGAMEVIEW) */\n    .buzzed-container {\n      width: 100%;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      gap: 12px;\n      animation: popIn 0.25s ease-out;\n    }\n    @keyframes popIn {\n      from { transform: scale(0.95); opacity: 0; }\n      to { transform: scale(1); opacity: 1; }\n    }\n\n    .buzz-detected-title {\n      font-size: 1.25rem;\n      font-weight: 900;\n      color: #ef4444;\n      letter-spacing: 2px;\n      text-align: center;\n    }\n\n    /* Carte Joueur Vainqueur */\n    .winner-card {\n      width: 100%;\n      padding: 20px 14px;\n      border-radius: 22px;\n      background: linear-gradient(135deg, #ef4444, #8b5cf6 90%);\n      border: 2px solid rgba(255, 255, 255, 0.3);\n      box-shadow: 0 10px 25px rgba(239, 68, 68, 0.4);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      gap: 6px;\n      text-align: center;\n    }\n    .winner-name {\n      font-size: 2.2rem;\n      font-weight: 900;\n      color: #ffffff;\n      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);\n      word-break: break-word;\n    }\n    .reaction-pill {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(0, 0, 0, 0.35);\n      padding: 6px 14px;\n      border-radius: 12px;\n      font-family: monospace;\n      font-size: 1.25rem;\n      font-weight: 900;\n      color: #38bdf8;\n    }\n\n    /* Carte R\u00e9v\u00e9lation Morceau (Titre + Artiste en grand) */\n    .song-reveal-box {\n      width: 100%;\n      padding: 14px;\n      border-radius: 18px;\n      background: rgba(0, 0, 0, 0.45);\n      border: 1.5px solid rgba(56, 189, 248, 0.4);\n      box-shadow: 0 0 15px rgba(56, 189, 248, 0.2);\n      display: flex;\n      flex-direction: column;\n      gap: 4px;\n      text-align: center;\n    }\n    .song-reveal-header {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      margin-bottom: 2px;\n    }\n    .song-reveal-tag {\n      font-size: 0.72rem;\n      font-weight: 900;\n      color: #38bdf8;\n      letter-spacing: 1px;\n      text-transform: uppercase;\n    }\n    .song-reveal-sub {\n      font-size: 0.68rem;\n      color: rgba(255, 255, 255, 0.6);\n      font-weight: 600;\n    }\n    .song-reveal-cinema {\n      font-size: 1.15rem;\n      font-weight: 900;\n      color: #38bdf8;\n      display: none;\n    }\n    .song-reveal-title {\n      font-size: 1.35rem;\n      font-weight: 900;\n      color: #ffffff;\n      line-height: 1.2;\n      word-break: break-word;\n    }\n    .song-reveal-artist {\n      font-size: 1.05rem;\n      font-weight: 700;\n      color: #facc15;\n      word-break: break-word;\n    }\n\n    /* Section Attribution des Points */\n    .scoring-section {\n      width: 100%;\n      display: flex;\n      flex-direction: column;\n      gap: 10px;\n    }\n    .scoring-prompt {\n      font-size: 0.78rem;\n      font-weight: 900;\n      color: #facc15;\n      letter-spacing: 1px;\n      text-transform: uppercase;\n      text-align: center;\n    }\n    .scoring-grid {\n      display: grid;\n      grid-template-columns: 1fr 1fr 1fr;\n      gap: 8px;\n      width: 100%;\n    }\n    .score-action-btn {\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      padding: 12px 6px;\n      border-radius: 16px;\n      border: none;\n      cursor: pointer;\n      color: #fff;\n      transition: transform 0.08s;\n    }\n    .score-action-btn:active {\n      transform: scale(0.94);\n    }\n    .score-btn-zero {\n      background: rgba(239, 68, 68, 0.9);\n      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);\n    }\n    .score-btn-half {\n      background: #f59e0b;\n      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);\n    }\n    .score-btn-full {\n      background: #10b981;\n      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);\n    }\n    .btn-icon {\n      font-size: 1.3rem;\n      margin-bottom: 2px;\n    }\n    .btn-title {\n      font-size: 1.15rem;\n      font-weight: 900;\n    }\n    .btn-subtitle {\n      font-size: 0.62rem;\n      font-weight: 700;\n      opacity: 0.9;\n      text-align: center;\n      line-height: 1.1;\n      margin-top: 2px;\n    }\n\n    .btn-resume {\n      width: 100%;\n      padding: 12px;\n      border-radius: 14px;\n      border: none;\n      background: linear-gradient(to right, #06b6d4, #2563eb);\n      color: #ffffff;\n      font-size: 0.85rem;\n      font-weight: 800;\n      cursor: pointer;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      gap: 6px;\n      box-shadow: 0 4px 14px rgba(6, 182, 212, 0.35);\n      transition: transform 0.08s;\n    }\n    .btn-resume:active {\n      transform: scale(0.97);\n    }\n    .btn-skip {\n      background: none;\n      border: none;\n      color: #94a3b8;\n      font-size: 0.78rem;\n      font-weight: 600;\n      cursor: pointer;\n      text-align: center;\n      padding: 4px;\n    }\n    .feedback-toast {\n      background: rgba(16, 185, 129, 0.2);\n      border: 1px solid #10b981;\n      color: #10b981;\n      padding: 8px 12px;\n      border-radius: 12px;\n      font-size: 0.85rem;\n      font-weight: 800;\n      text-align: center;\n      margin-top: 4px;\n    }\n\n    /* Modale Choix Pseudo */\n    .modal {\n      position: fixed;\n      inset: 0;\n      background: rgba(11, 15, 25, 0.96);\n      backdrop-filter: blur(12px);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      padding: 24px;\n      z-index: 100;\n    }\n    .modal.hidden { display: none; }\n    .modal-box {\n      width: 100%;\n      max-width: 340px;\n      text-align: center;\n    }\n    .modal-title {\n      font-size: 1.6rem;\n      font-weight: 900;\n      margin-bottom: 6px;\n      color: #38bdf8;\n    }\n    .modal-desc {\n      color: #94a3b8;\n      font-size: 0.9rem;\n      margin-bottom: 20px;\n    }\n    .input-field {\n      width: 100%;\n      background: #1e293b;\n      border: 2px solid #334155;\n      padding: 14px 16px;\n      border-radius: 12px;\n      color: #fff;\n      font-size: 1.1rem;\n      text-align: center;\n      font-weight: bold;\n      outline: none;\n      margin-bottom: 14px;\n    }\n    .input-field:focus { border-color: #38bdf8; }\n    .color-grid {\n      display: flex;\n      justify-content: center;\n      gap: 12px;\n      margin-bottom: 20px;\n    }\n    .color-btn {\n      width: 42px;\n      height: 42px;\n      border-radius: 50%;\n      border: 3px solid transparent;\n      cursor: pointer;\n      transition: transform 0.2s;\n    }\n    .color-btn.active {\n      transform: scale(1.15);\n      border-color: #ffffff;\n      box-shadow: 0 0 15px rgba(255,255,255,0.5);\n    }\n    .btn-join {\n      width: 100%;\n      background: linear-gradient(135deg, #38bdf8, #2563eb);\n      color: #fff;\n      border: none;\n      padding: 16px;\n      border-radius: 14px;\n      font-size: 1.1rem;\n      font-weight: 800;\n      cursor: pointer;\n      box-shadow: 0 10px 20px rgba(37, 99, 235, 0.4);\n    }\n  </style>\n</head>\n<body>\n\n  <div class=\"container\">\n    <!-- BANNI\u00c8RE SMART IPHONE -->\n    <div id=\"ios-app-banner\" style=\"display:none; width: 100%; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 12px; padding: 8px 12px; font-size: 0.82rem; text-align: center; color: #bae6fd;\">\n      \ud83d\udcf1 <strong>Joueur iPhone ?</strong> T\u00e9l\u00e9charge l'application sur l'App Store pour une exp\u00e9rience 100% native !\n    </div>\n\n    <!-- 1. BARRE SUP\u00c9RIEURE IDENTIQUE \u00c0 L'H\u00d4TE -->\n    <div class=\"top-bar\">\n      <span class=\"room-badge\" id=\"room-badge\"><span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ...</span>\n      <div class=\"round-title\" id=\"round-title\">MANCHE #1</div>\n      <div class=\"score-badge\" id=\"my-score-badge\">\ud83c\udfc6 <span id=\"my-score-val\">0 pt</span></div>\n    </div>\n\n    <!-- 2. BARRE LECTEUR DEEZER INT\u00c9GR\u00c9 -->\n    <div class=\"player-bar\">\n      <div class=\"play-icon\">\u25b6</div>\n      <div class=\"track-info\">\n        <div class=\"track-number\" id=\"bar-track-num\">Morceau #1</div>\n        <div class=\"track-status\" id=\"bar-track-status\">Lecteur Deezer</div>\n      </div>\n      <div class=\"player-pill\">\n        <div class=\"player-dot\" id=\"player-dot\"></div>\n        <span id=\"player-label\">Moi</span>\n      </div>\n    </div>\n\n    <!-- CLASSEMENT ET SCORES EN DIRECT (TOUS LES JOUEURS + H\u00d4TE) -->\n    <div class=\"leaderboard-strip\" id=\"leaderboard-strip\">\n      <div class=\"leaderboard-chip is-host\"><span>\ud83d\udc51</span><span class=\"chip-name\">H\u00f4te</span><span class=\"chip-score\">0 pt</span></div>\n    </div>\n\n    <!-- 3. ZONE CENTRALE : ATTENTE (LE BUZZER) -->\n    <div class=\"buzzer-area\" id=\"buzzer-area\">\n      <button class=\"buzzer-btn\" id=\"buzzer-btn\">\n        <span class=\"buzzer-text\">BUZZ !</span>\n        <span class=\"buzzer-sub\">Tape vite !</span>\n      </button>\n      <div class=\"status-msg-waiting\" id=\"status-msg-waiting\">\u00c9coute bien la musique...</div>\n    </div>\n\n    <!-- 4. ZONE CENTRALE : BUZZ D\u00c9TECT\u00c9 (EXACTEMENT COMME L'HOST) -->\n    <div class=\"buzzed-container\" id=\"buzzed-container\" style=\"display: none;\">\n      <div class=\"buzz-detected-title\">\ud83d\udea8 BUZZ D\u00c9TECT\u00c9 ! \ud83d\udea8</div>\n\n      <!-- Carte Vainqueur -->\n      <div class=\"winner-card\" id=\"winner-card\">\n        <div class=\"winner-name\" id=\"winner-name\">Joueur</div>\n        <div class=\"reaction-pill\" id=\"reaction-pill\">\u26a1 0.000 s</div>\n      </div>\n\n      <!-- Compte \u00e0 rebours r\u00e9ponse 5s -->\n      <div class=\"answer-timer-pill\" id=\"answer-timer-pill\" style=\"display: flex; align-items: center; justify-content: center; gap: 8px; background: rgba(0, 0, 0, 0.45); border: 1.5px solid #facc15; color: #facc15; padding: 8px 18px; border-radius: 20px; font-weight: 900; font-size: 0.95rem; width: 100%; text-align: center;\">\n        \u23f1\ufe0f Temps de r\u00e9ponse : <span id=\"answer-timer-seconds\">5</span> s\n      </div>\n\n      <!-- Carte R\u00e9v\u00e9lation Morceau (Titre + Artiste en grand) -->\n      <div class=\"song-reveal-box\" id=\"song-reveal-box\">\n        <div class=\"song-reveal-header\">\n          <span class=\"song-reveal-tag\">\ud83c\udfb5 MORCEAU EN COURS</span>\n          <span class=\"song-reveal-sub\">V\u00e9rifie ta r\u00e9ponse ci-dessous</span>\n        </div>\n        <div class=\"song-reveal-cinema\" id=\"song-cinema\">\ud83c\udfac Franchise</div>\n        <div class=\"song-reveal-title\" id=\"song-title\">Titre de la musique</div>\n        <div class=\"song-reveal-artist\" id=\"song-artist\">Nom de l'artiste</div>\n      </div>\n\n      <!-- Section Auto-\u00e9valuation des Points -->\n      <div class=\"scoring-section\" id=\"scoring-section\">\n        <div class=\"scoring-prompt\" id=\"scoring-prompt\">\ud83d\udc49 C'EST TON TOUR ! METS TES POINTS :</div>\n\n        <div class=\"scoring-grid\" id=\"scoring-grid\">\n          <!-- 0 PT (Faux) -->\n          <button class=\"score-action-btn score-btn-zero\" onclick=\"handleScore(0.0)\">\n            <span class=\"btn-icon\">\u2716</span>\n            <span class=\"btn-title\">0 PT</span>\n            <span class=\"btn-subtitle\">Faux / Rien</span>\n          </button>\n\n          <!-- +0.5 PT (Moiti\u00e9) -->\n          <button class=\"score-action-btn score-btn-half\" onclick=\"handleScore(0.5)\">\n            <span class=\"btn-icon\">\u2605</span>\n            <span class=\"btn-title\">+0,5 PT</span>\n            <span class=\"btn-subtitle\">Artiste ou Titre</span>\n          </button>\n\n          <!-- +1 PT (Tout trouv\u00e9) -->\n          <button class=\"score-action-btn score-btn-full\" onclick=\"handleScore(1.0)\">\n            <span class=\"btn-icon\">\u2714</span>\n            <span class=\"btn-title\">+1 PT</span>\n            <span class=\"btn-subtitle\">Tout trouv\u00e9</span>\n          </button>\n        </div>\n\n        <div class=\"feedback-toast\" id=\"feedback-toast\" style=\"display: none;\"></div>\n\n        <!-- Relancer la musique -->\n        <button class=\"btn-resume\" onclick=\"handleResume()\">\n          <span>\u25b6</span>\n          <span>Relancer la musique (pour trouver le reste)</span>\n        </button>\n\n        <!-- Passer -->\n        <button class=\"btn-skip\" onclick=\"handleNext()\">\n          Passer au morceau suivant sans point\n        </button>\n      </div>\n    </div>\n  </div>\n\n  <!-- Modale Pseudo et Code de Salon -->\n  <div class=\"modal\" id=\"modal-join\">\n    <div class=\"modal-box\">\n      <div class=\"modal-title\">Rejoins la partie ! \ud83c\udfb5</div>\n      <div class=\"modal-desc\">Tape ton pr\u00e9nom pour buzzer en direct avec l'h\u00f4te :</div>\n      \n      <input type=\"text\" class=\"input-field\" id=\"input-room\" placeholder=\"CODE SALON (ex: BLND)\" maxlength=\"6\" style=\"display: none; text-transform: uppercase;\">\n      <input type=\"text\" class=\"input-field\" id=\"input-name\" placeholder=\"Ton pr\u00e9nom ou pseudo\" maxlength=\"15\" autofocus>\n      \n      <div class=\"color-grid\">\n        <button class=\"color-btn active\" data-color=\"#ef4444\" style=\"background: #ef4444;\"></button>\n        <button class=\"color-btn\" data-color=\"#3b82f6\" style=\"background: #3b82f6;\"></button>\n        <button class=\"color-btn\" data-color=\"#10b981\" style=\"background: #10b981;\"></button>\n        <button class=\"color-btn\" data-color=\"#f59e0b\" style=\"background: #f59e0b;\"></button>\n        <button class=\"color-btn\" data-color=\"#8b5cf6\" style=\"background: #8b5cf6;\"></button>\n      </div>\n\n      <button class=\"btn-join\" id=\"btn-join\">ENTRER DANS LA PARTIE</button>\n    </div>\n  </div>\n\n  <script>\n    const urlParams = new URLSearchParams(window.location.search);\n    let pathRoom = '';\n    const pathParts = window.location.pathname.split('/').filter(Boolean);\n    if (pathParts.length >= 2 && pathParts[0] === 'room') {\n      pathRoom = pathParts[1];\n    }\n    let roomCode = (urlParams.get('room') || pathRoom || window.location.hash.replace('#', '') || '').toUpperCase().trim();\n    \n    let myName = localStorage.getItem('bt_cloud_name') || '';\n    let myColor = localStorage.getItem('bt_cloud_color') || '#ef4444';\n    let hasBuzz = false;\n    let hasScoredThisRound = false;\n    let ws = null;\n\n    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {\n      const banner = document.getElementById('ios-app-banner');\n      if (banner) banner.style.display = 'block';\n    }\n\n    const modal = document.getElementById('modal-join');\n    const inputRoom = document.getElementById('input-room');\n    const inputName = document.getElementById('input-name');\n    const btnJoin = document.getElementById('btn-join');\n    const playerDot = document.getElementById('player-dot');\n    const playerLabel = document.getElementById('player-label');\n    const myScoreVal = document.getElementById('my-score-val');\n    const roundTitle = document.getElementById('round-title');\n    const barTrackNum = document.getElementById('bar-track-num');\n    const barTrackStatus = document.getElementById('bar-track-status');\n    const roomBadge = document.getElementById('room-badge');\n    const connDot = document.getElementById('conn-dot');\n\n    const buzzerArea = document.getElementById('buzzer-area');\n    const buzzerBtn = document.getElementById('buzzer-btn');\n    const statusMsgWaiting = document.getElementById('status-msg-waiting');\n    const buzzedContainer = document.getElementById('buzzed-container');\n    const winnerCard = document.getElementById('winner-card');\n    const winnerName = document.getElementById('winner-name');\n    const reactionPill = document.getElementById('reaction-pill');\n    const songCinema = document.getElementById('song-cinema');\n    const songTitle = document.getElementById('song-title');\n    const songArtist = document.getElementById('song-artist');\n    const scoringPrompt = document.getElementById('scoring-prompt');\n    const feedbackToast = document.getElementById('feedback-toast');\n    const colorBtns = document.querySelectorAll('.color-btn');\n\n    if (!roomCode) {\n      inputRoom.style.display = 'block';\n    } else {\n      roomBadge.innerHTML = `<span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ${roomCode}`;\n    }\n\n    if (myName) inputName.value = myName;\n\n    colorBtns.forEach(btn => {\n      btn.addEventListener('click', () => {\n        colorBtns.forEach(b => b.classList.remove('active'));\n        btn.classList.add('active');\n        myColor = btn.getAttribute('data-color');\n      });\n    });\n\n    btnJoin.addEventListener('click', handleJoin);\n    inputName.addEventListener('keyup', (e) => { if (e.key === 'Enter') handleJoin(); });\n\n    function handleJoin() {\n      if (!roomCode) {\n        roomCode = inputRoom.value.toUpperCase().trim();\n      }\n      const name = inputName.value.trim();\n      if (!roomCode || !name) return;\n\n      myName = name;\n      localStorage.setItem('bt_cloud_name', myName);\n      localStorage.setItem('bt_cloud_color', myColor);\n\n      modal.classList.add('hidden');\n      playerLabel.textContent = myName;\n      playerDot.style.background = myColor;\n      buzzerBtn.style.background = `radial-gradient(circle at 35% 35%, ${myColor}, #881337 80%)`;\n      roomBadge.innerHTML = `<span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ${roomCode}`;\n\n      connectWebSocket();\n    }\n\n    function connectWebSocket() {\n      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n      const wsUrl = `${protocol}//${window.location.host}/ws`;\n\n      statusMsgWaiting.textContent = \"Connexion au Cloud...\";\n      \n      try {\n        ws = new WebSocket(wsUrl);\n      } catch (e) {\n        statusMsgWaiting.textContent = \"Erreur de connexion\";\n        return;\n      }\n\n      ws.onopen = () => {\n        connDot.style.background = '#10b981';\n        statusMsgWaiting.textContent = \"\u00c9coute bien la musique...\";\n        \n        ws.send(JSON.stringify({\n          type: 'join',\n          room: roomCode,\n          code: roomCode,\n          name: myName,\n          color: myColor\n        }));\n      };\n\n      ws.onmessage = (event) => {\n        try {\n          const data = JSON.parse(event.data);\n          handleServerMessage(data);\n        } catch (e) {}\n      };\n\n      ws.onclose = () => {\n        connDot.style.background = '#ef4444';\n        statusMsgWaiting.textContent = \"Reconnexion...\";\n        setTimeout(connectWebSocket, 2500);\n      };\n\n      ws.onerror = () => {\n        ws.close();\n      };\n    }\n\n    function triggerBuzz() {\n      if (!myName || hasBuzz || !ws || ws.readyState !== WebSocket.OPEN) return;\n      hasBuzz = true;\n      hasScoredThisRound = false;\n\n      if (navigator.vibrate) {\n        navigator.vibrate([100, 50, 100]);\n      }\n\n      const clientTime = performance.now();\n      ws.send(JSON.stringify({\n        type: 'buzz',\n        room: roomCode,\n        name: myName,\n        clientTime: clientTime\n      }));\n    }\n\n    function handleScore(points) {\n      if (hasScoredThisRound) return;\n      hasScoredThisRound = true;\n\n      if (navigator.vibrate) {\n        navigator.vibrate([100, 50, 100]);\n      }\n\n      feedbackToast.style.display = 'block';\n      const label = points === 1.0 ? '+1 PT' : (points === 0.5 ? '+0.5 PT' : '0 PT');\n      feedbackToast.textContent = `\u2705 Points enregistr\u00e9s (${label}) !`;\n\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({\n          type: 'score_submission',\n          room: roomCode,\n          name: myName,\n          points: points\n        }));\n      }\n    }\n\n    function handleResume() {\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({\n          type: 'resume_music',\n          room: roomCode\n        }));\n      }\n    }\n\n    function handleNext() {\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({\n          type: 'reset',\n          room: roomCode\n        }));\n      }\n    }\n\n    let clientCountdownTimer = null;\n    let clientCountdownVal = 5;\n\n    function startClientAnswerTimer() {\n      clearInterval(clientCountdownTimer);\n      clientCountdownVal = 5;\n      const pill = document.getElementById('answer-timer-pill');\n      const revealBox = document.getElementById('song-reveal-box');\n      const revealSub = document.querySelector('.song-reveal-sub');\n      \n      if (pill) {\n        pill.style.borderColor = '#facc15';\n        pill.style.color = '#facc15';\n        pill.innerHTML = `\u23f1\ufe0f Temps de r\u00e9ponse : <span id=\"answer-timer-seconds\">5</span> s`;\n      }\n      \n      if (revealBox) {\n        revealBox.style.filter = 'blur(10px)';\n        revealBox.style.opacity = '0.35';\n      }\n      if (revealSub) revealSub.textContent = \"\ud83d\udd12 R\u00e9ponse masqu\u00e9e (5s)...\";\n\n      clientCountdownTimer = setInterval(() => {\n        if (clientCountdownVal > 1) {\n          clientCountdownVal--;\n          const s = document.getElementById('answer-timer-seconds');\n          if (s) s.textContent = clientCountdownVal;\n        } else {\n          clearInterval(clientCountdownTimer);\n          clientCountdownTimer = null;\n          if (pill) {\n            pill.style.borderColor = '#10b981';\n            pill.style.color = '#10b981';\n            pill.innerHTML = `\u2705 Temps \u00e9coul\u00e9 ! R\u00e9ponse r\u00e9v\u00e9l\u00e9e`;\n          }\n          if (revealBox) {\n            revealBox.style.filter = 'none';\n            revealBox.style.opacity = '1';\n          }\n          if (revealSub) revealSub.textContent = \"V\u00e9rifie ta r\u00e9ponse ci-dessous\";\n        }\n      }, 1000);\n    }\n\n    function stopClientAnswerTimer() {\n      clearInterval(clientCountdownTimer);\n      clientCountdownTimer = null;\n      const revealBox = document.getElementById('song-reveal-box');\n      if (revealBox) {\n        revealBox.style.filter = 'none';\n        revealBox.style.opacity = '1';\n      }\n    }\n\n    function updateLeaderboard(data) {\n      const strip = document.getElementById('leaderboard-strip');\n      if (!strip) return;\n      \n      let playerList = [];\n      if (Array.isArray(data.players) && data.players.length > 0) {\n        playerList = data.players.map(p => ({\n          name: p.name || p.playerName || 'Joueur',\n          score: Number(p.score || 0),\n          color: p.color || '#38bdf8',\n          isHost: Boolean(p.isHost || (p.name && (p.name.toLowerCase().includes('h\u00f4te') || p.name.toLowerCase().includes('hote'))))\n        }));\n      } else if (data.scores && typeof data.scores === 'object') {\n        playerList = Object.entries(data.scores).filter(([k]) => !['host', 'h\u00f4te', 'hote', 'Moi (Hote)'].includes(k)).map(([name, sc]) => ({\n          name: name,\n          score: Number(sc || 0),\n          color: '#38bdf8',\n          isHost: name.toLowerCase().includes('h\u00f4te') || name.toLowerCase().includes('hote')\n        }));\n      }\n      \n      const hostScore = data.scores ? (data.scores['Moi (H\u00f4te)'] ?? data.scores['Moi (Hote)'] ?? data.scores['host'] ?? data.scores['H\u00f4te']) : null;\n      if (hostScore !== null && !playerList.some(p => p.isHost)) {\n        playerList.unshift({\n          name: 'Moi (H\u00f4te)',\n          score: Number(hostScore),\n          color: '#ec4899',\n          isHost: true\n        });\n      }\n      \n      if (playerList.length === 0) return;\n      \n      playerList.sort((a, b) => b.score - a.score);\n      \n      strip.innerHTML = playerList.map((p, idx) => {\n        const isMe = myName && p.name.trim().toLowerCase() === myName.trim().toLowerCase();\n        const scoreStr = (p.score % 1 === 0 ? p.score : p.score.toFixed(1)) + ' pt' + (p.score > 1 ? 's' : '');\n        const crown = p.isHost ? '\ud83d\udc51 ' : (idx === 0 ? '\ud83e\udd47 ' : (idx === 1 ? '\ud83e\udd48 ' : (idx === 2 ? '\ud83e\udd49 ' : '')));\n        const label = isMe ? `${p.name} (Toi)` : p.name;\n        const cls = p.isHost ? 'leaderboard-chip is-host' : (isMe ? 'leaderboard-chip is-me' : 'leaderboard-chip');\n        return `<div class=\"${cls}\">\n          <span>${crown}</span>\n          <span class=\"chip-name\">${label}</span>\n          <span class=\"chip-score\">${scoreStr}</span>\n        </div>`;\n      }).join('');\n    }\n\n    function handleServerMessage(data) {\n      if (!data) return;\n\n      // Met \u00e0 jour le classement en direct\n      updateLeaderboard(data);\n\n      if (data.type === 'state' || data.type === 'room_state' || data.type === 'buzzer_pressed') {\n        // Manche & Playlist\n        if (data.roundNumber) {\n          roundTitle.textContent = `MANCHE #${data.roundNumber}`;\n          barTrackNum.textContent = `Morceau #${data.roundNumber}`;\n        }\n        if (data.playlistTitle) {\n          barTrackStatus.textContent = (data.state === 'buzzed' ? \"En pause (Buzz) \u2022 \" : (data.isPlaying ? \"Lecture \u2022 \" : \"En pause \u2022 \")) + data.playlistTitle;\n        }\n\n        // Mon Score personnel\n        if (data.scores && data.scores[myName] !== undefined) {\n          const s = data.scores[myName];\n          myScoreVal.textContent = (s % 1 === 0 ? s : s.toFixed(1)) + ' pt' + (s > 1 ? 's' : '');\n        }\n\n        if (data.state === 'waiting' || data.type === 'reset') {\n          hasBuzz = false;\n          hasScoredThisRound = false;\n          stopClientAnswerTimer();\n          buzzerArea.style.display = 'flex';\n          buzzedContainer.style.display = 'none';\n          feedbackToast.style.display = 'none';\n          buzzerBtn.style.opacity = '1';\n          buzzerBtn.style.pointerEvents = 'auto';\n          buzzerBtn.querySelector('.buzzer-text').textContent = 'BUZZ !';\n          buzzerBtn.querySelector('.buzzer-sub').textContent = 'Tape vite !';\n          statusMsgWaiting.textContent = \"\u00c9coute bien la musique...\";\n        } else if (data.state === 'buzzed' || data.type === 'buzzer_pressed') {\n          buzzerArea.style.display = 'none';\n          buzzedContainer.style.display = 'flex';\n\n          const winner = (data.winner && data.winner.playerName) || data.winner || (data.winnerDict && data.winnerDict.playerName) || 'Quelqu\\'un';\n          const isMe = (myName && winner.trim().toLowerCase() === myName.trim().toLowerCase());\n          const scoringGrid = document.getElementById('scoring-grid');\n          const buzzDetectedTitle = document.querySelector('.buzz-detected-title');\n\n          if (isMe) {\n            // CE JOUEUR EST LE GAGNANT DU BUZZ\n            if (buzzDetectedTitle) {\n              buzzDetectedTitle.textContent = \"\ud83d\udc51 C'EST TOI LE PLUS RAPIDE ! \ud83d\udc51\";\n              buzzDetectedTitle.style.color = \"#facc15\";\n            }\n            winnerName.textContent = \"Tu as buzz\u00e9 en premier !\";\n            winnerCard.style.background = `linear-gradient(135deg, ${myColor}, #8b5cf6 90%)`;\n            winnerCard.style.border = \"2px solid #facc15\";\n            scoringPrompt.textContent = \"\ud83d\udc49 C'EST TON TOUR ! METS TES POINTS :\";\n            if (scoringGrid) scoringGrid.style.display = 'grid';\n          } else {\n            // UN AUTRE JOUEUR A \u00c9T\u00c9 PLUS RAPIDE\n            if (buzzDetectedTitle) {\n              buzzDetectedTitle.textContent = \"\ud83d\udea8 TROP TARD ! \ud83d\udea8\";\n              buzzDetectedTitle.style.color = \"#ef4444\";\n            }\n            winnerName.textContent = `${winner.toUpperCase()} a buzz\u00e9 le premier !`;\n            winnerCard.style.background = \"linear-gradient(135deg, #1e293b, #334155 90%)\";\n            winnerCard.style.border = \"2px solid rgba(255, 255, 255, 0.15)\";\n            scoringPrompt.textContent = `\ud83d\udc49 C'est ${winner} qui a la main pour r\u00e9pondre !`;\n            if (scoringGrid) scoringGrid.style.display = 'none';\n          }\n\n          const rawReaction = data.reactionTime ?? (typeof data.winner === 'object' ? data.winner?.reactionTime : null) ?? (data.reactionMs ? (data.reactionMs / 1000) : null);\n          reactionPill.textContent = rawReaction ? `\u26a1 ${Number(rawReaction).toFixed(2)} s` : '\u26a1 Buzzer';\n\n          if (data.track) {\n            songTitle.textContent = data.track.title || \"Titre inconnu\";\n            songArtist.textContent = data.track.artist || \"\";\n            if (data.track.isCinema && data.track.franchise) {\n              songCinema.style.display = 'block';\n              songCinema.textContent = \"\ud83c\udfac \" + data.track.franchise;\n            } else {\n              songCinema.style.display = 'none';\n            }\n          }\n\n          if (!clientCountdownTimer) {\n            startClientAnswerTimer();\n          }\n        }\n      } else if (data.type === 'scores' || data.type === 'scores_update' || data.type === 'room_updated') {\n        if (data.scores && data.scores[myName] !== undefined) {\n          const s = data.scores[myName];\n          myScoreVal.textContent = (s % 1 === 0 ? s : s.toFixed(1)) + ' pt' + (s > 1 ? 's' : '');\n        }\n      }\n    }\n\n    buzzerBtn.addEventListener('click', triggerBuzz);\n    buzzerBtn.addEventListener('touchstart', (e) => {\n      e.preventDefault();\n      triggerBuzz();\n    }, { passive: false });\n  </script>\n</body>\n</html>\n";
