const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Stockage en m√©moire vive des salons de Blind Test
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
  // CORS permissif
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

  // 2. Politique de confidentialit√© requise par Apple App Store
  if (url.pathname === '/privacy' || url.pathname === '/politique-de-confidentialite') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Politique de Confidentialit√© - Blind Test entre amis</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1e293b;background:#f8fafc;}h1{color:#0f172a;}h2{margin-top:24px;color:#334155;}</style></head><body><h1>Politique de Confidentialit√©</h1><p>Derni√®re mise √† jour : Septembre 2026</p><h2>1. Collecte des Donn√©es</h2><p>L'application <strong>Blind Test entre amis</strong> respecte la vie priv√©e de ses utilisateurs. Aucune donn√©e personnelle nominative, bancaire ou de localisation n'est collect√©e, vendue ou transmise √† des tiers.</p><h2>2. Donn√©es en session de jeu</h2><p>Les pseudonymes saisis pour rejoindre un salon de jeu sont strictement √©ph√©m√®res, stock√©s temporairement en m√©moire vive pour le calcul des scores de la partie, et sont automatiquement supprim√©s √† la fermeture du salon.</p><h2>3. Autorisations requises</h2><p>L'application utilise uniquement le r√©seau local et Internet pour permettre la communication en temps r√©el entre les smartphones des joueurs et l'h√¥te.</p><h2>4. Contact</h2><p>Pour toute question : achille.aubrun@gmail.com</p></body></html>`);
    return;
  }

  // 3. Page Support & Assistance requise par Apple App Store
  if (url.pathname === '/support') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Support - Blind Test entre amis</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1e293b;background:#f8fafc;}h1{color:#0f172a;}</style></head><body><h1>Support & Assistance</h1><p>Une question ou un probl√®me concernant l'application <strong>Blind Test entre amis</strong> ?</p><p>Contactez le support par email : <a href="mailto:achille.aubrun@gmail.com">achille.aubrun@gmail.com</a></p><p>Nous vous r√©pondrons dans les plus brefs d√©lais !</p></body></html>`);
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
        lockedPlayers: new Set(),
        currentTrack: null
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
      res.end(JSON.stringify({ code, players: playersList, currentTrack: room.currentTrack }));
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
      lockedPlayers: new Set(),
      currentTrack: null,
      scoreAwardedThisBuzz: false
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
  const roomCode = (data.code || data.room || ws.roomCode || '').toUpperCase().trim();

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
          console.log(`[Joueur] ${name} reconnect√© au salon ${roomCode} (score: ${existing.score})`);
        } else {
          room.players.set(name, { name, score: 0.0, color: data.color || '#38bdf8' });
          console.log(`[Joueur] ${name} a rejoint le salon ${roomCode}`);
        }
        ws.send(JSON.stringify({ type: 'join_confirmed', room: roomCode, code: roomCode, name }));
      }

      // Diffusion de l'√©tat du salon et du morceau en cours
      const playersList = Array.from(room.players.values());
      broadcastToRoom(room, {
        type: 'room_state',
        room: {
          code: roomCode,
          players: playersList
        },
        players: playersList,
        track: room.currentTrack || null
      });
      break;
    }

    // 2. Un joueur ou l'h√¥te buzze !
    case 'buzz': {
      const name = (data.playerName || data.name || ws.playerName || 'Anonyme').trim();
      let reactionMs = Number(data.reactionMs !== undefined ? data.reactionMs : (data.clientTime || 0));
      if (reactionMs > 32000 || reactionMs < 0 || isNaN(reactionMs)) {
        reactionMs = 0;
      }
      const reactionSec = reactionMs > 0 ? Number((reactionMs / 1000).toFixed(2)) : 0;
      const normalizedName = name.toLowerCase();

      // S√©curit√© anti-blocage : si un vainqueur pr√©c√©dent date de plus de 8s, on r√©arme automatiquement
      if (room.currentWinner !== null && room.winnerTimestamp && (Date.now() - room.winnerTimestamp > 8000)) {
        console.log(`[Auto-Reset] Ancien vainqueur ${room.currentWinner} expir√© (>8s)`);
        room.currentWinner = null;
        room.scoreAwardedThisBuzz = false;
      }

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

      room.currentWinner = name;
      room.winnerTimestamp = Date.now();
      room.scoreAwardedThisBuzz = false;
      room.lockedPlayers.add(normalizedName);
      console.log(`[Buzz Valid√© !] üëë ${name} est le vainqueur unique dans le salon ${roomCode} (${reactionMs} ms)`);
      
      const payload = {
        type: 'buzzer_pressed',
        room: roomCode,
        code: roomCode,
        name: name,
        playerName: name,
        reactionMs: reactionMs,
        reactionTime: reactionSec,
        winner: {
          name: name,
          playerName: name,
          reactionMs: reactionMs,
          reactionTime: reactionSec,
          timestamp: new Date().toISOString()
        },
        track: room.currentTrack || null,
        songTitle: (room.currentTrack && room.currentTrack.songTitle) || '',
        title: (room.currentTrack && room.currentTrack.title) || '',
        artist: (room.currentTrack && room.currentTrack.artist) || '',
        franchise: (room.currentTrack && room.currentTrack.franchise) || '',
        isCinema: (room.currentTrack && room.currentTrack.isCinema) || false
      };
      broadcastToRoom(room, payload);
      broadcastToRoom(room, { ...payload, type: 'buzz' });
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN && !room.clients.has(room.hostWs)) {
        room.hostWs.send(JSON.stringify(payload));
      }
      break;
    }

    // 3. Mise √† jour du morceau (Deezer / Disney)
    case 'track_update':
    case 'start_round': {
      const title = (data.track && data.track.title) || data.title || data.songTitle || 'Morceau';
      const artist = (data.track && data.track.artist) || data.artist || '';
      const franchise = (data.track && (data.track.franchise || data.track.movieFranchise)) || data.franchise || data.movieFranchise || '';
      const isCinema = Boolean((data.track && data.track.isCinema) || franchise);
      const round = data.round || data.roundNumber || 1;
      const playlist = data.playlist || data.playlistTitle || '';

      room.currentWinner = null;
      room.scoreAwardedThisBuzz = false;
      room.lockedPlayers.clear();
      room.currentTrack = {
        title: title,
        artist: artist,
        franchise: franchise,
        movieFranchise: franchise,
        isCinema: isCinema,
        songTitle: data.title || data.songTitle || title,
        round: round,
        roundNumber: round,
        playlist: playlist,
        playlistTitle: playlist
      };

      data.track = room.currentTrack;
      data.franchise = franchise;
      data.movieFranchise = franchise;
      data.isCinema = isCinema;
      console.log(`[Musique] üéµ Nouvelle manche #${round} dans le salon ${roomCode} : ${room.currentTrack.songTitle} (${artist})`);
      broadcastToRoom(room, data);
      break;
    }

    // 4. Attribution d'un score (0, 0.5, 1 pt)
    case 'score_submission':
    case 'submit_score':
    case 'score': {
      const name = (data.playerName || data.name || ws.playerName || '').trim();
      const pts = Number(data.points ?? 0);

      // Protection stricte anti-doublon par buzz :
      if (room.scoreAwardedThisBuzz) {
        console.log(`[Score Ignor√©] ‚õîÔ∏è Score d√©j√† attribu√© pour ce buzz (${name})`);
        return;
      }
      room.scoreAwardedThisBuzz = true;
      room.currentWinner = null;

      if (name) {
        if (room.players.has(name)) {
          const p = room.players.get(name);
          p.score = Math.max(0, p.score + pts);
        } else {
          room.players.set(name, { name, score: Math.max(0, pts), color: '#38bdf8' });
        }
      }
      console.log(`[Score] üèÜ ${name} : ${pts} pt(s) dans le salon ${roomCode}`);
      
      const playersList = Array.from(room.players.values());
      const scoresMap = {};
      for (const p of playersList) {
        scoresMap[p.name] = p.score;
      }

      const scorePayload = {
        type: 'score_submission',
        room: roomCode,
        code: roomCode,
        name: name,
        playerName: name,
        points: pts
      };

      // Relais imm√©diat √† l'h√¥te pour relancer automatiquement la musique
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(scorePayload));
      }
      for (const client of room.clients) {
        if (client.isHost && client !== room.hostWs && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(scorePayload));
        }
      }

      broadcastToRoom(room, {
        type: 'score_updated',
        room: roomCode,
        code: roomCode,
        name: name,
        playerName: name,
        points: pts,
        scores: scoresMap,
        players: playersList
      });
      broadcastToRoom(room, {
        type: 'scores_update',
        room: roomCode,
        code: roomCode,
        scores: scoresMap,
        players: playersList
      });
      break;
    }

    // 5. Mise √† jour compl√®te des scores par l'h√¥te
    case 'scores_update':
    case 'scores': {
      if (Array.isArray(data.players)) {
        for (const p of data.players) {
          const pName = (p.name || p.playerName || '').trim();
          if (pName) {
            const pScore = Number(p.score || 0);
            const pColor = p.color || '#38bdf8';
            room.players.set(pName, { name: pName, score: pScore, color: pColor, isHost: Boolean(p.isHost) });
          }
        }
      }
      broadcastToRoom(room, data);
      break;
    }

    // 5b. √âjection d'un joueur par l'h√¥te
    case 'kick_player':
    case 'remove_player': {
      const name = (data.name || data.playerName || '').trim();
      if (name && room.players.has(name)) {
        room.players.delete(name);
        const playersList = Array.from(room.players.values());
        broadcastToRoom(room, {
          type: 'room_state',
          room: { code: roomCode, players: playersList },
          players: playersList,
          track: room.currentTrack || null
        });
      }
      break;
    }

    // 6. R√©armement / Reset des buzzers pour le morceau suivant ou relance
    case 'reset': {
      console.log(`[Reset] üîÑ R√©armement du salon ${roomCode}`);
      room.currentWinner = null;
      room.scoreAwardedThisBuzz = false;
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      break;
    }

    // 7. Commandes musicales du joueur vers l'h√¥te
    case 'resume_music': {
      console.log(`[Relance Musique] ‚ñ∂Ô∏è Demand√©e par ${ws.playerName || 'joueur'} dans le salon ${roomCode}`);
      room.currentWinner = null;
      room.scoreAwardedThisBuzz = false;
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(data));
      }
      for (const client of room.clients) {
        if (client.isHost && client !== room.hostWs && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      }
      break;
    }

    case 'next_track': {
      console.log(`[Morceau Suivant] ‚è≠Ô∏è Demand√© par ${ws.playerName || 'joueur'} dans le salon ${roomCode}`);
      room.currentWinner = null;
      room.scoreAwardedThisBuzz = false;
      room.lockedPlayers.clear();
      broadcastToRoom(room, { type: 'reset', room: roomCode, code: roomCode });
      let sentToHost = false;
      if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
        room.hostWs.send(JSON.stringify(data));
        sentToHost = true;
      }
      for (const client of room.clients) {
        if (client.isHost && client !== room.hostWs && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
          sentToHost = true;
        }
      }
      if (!sentToHost) {
        console.log(`[Morceau Suivant] ‚ö†Ô∏è Attention : aucun h√¥te actif trouv√© pour le salon ${roomCode}`);
      }
      break;
    }

    case 'track_countdown': {
      broadcastToRoom(room, data);
      break;
    }

    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    }

    default: {
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
    console.log(`[Joueur] D√©connexion temporaire de ${ws.playerName} dans le salon ${ws.roomCode} (score conserv√©)`);
  }

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
const EMBEDDED_HTML = "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no\">\n  <title>\ud83d\udd14 Mon Buzzer - Blind Test entre amis</title>\n  <style>\n    * {\n      box-sizing: border-box;\n      margin: 0;\n      padding: 0;\n      user-select: none;\n      -webkit-user-select: none;\n      -webkit-tap-highlight-color: transparent;\n    }\n    body {\n      background: radial-gradient(circle at 15% 15%, rgba(168, 85, 247, 0.18) 0%, transparent 45%),\n                  radial-gradient(circle at 85% 85%, rgba(0, 242, 254, 0.16) 0%, transparent 45%),\n                  radial-gradient(circle at 50% 50%, rgba(255, 46, 147, 0.08) 0%, transparent 60%),\n                  #0b0f19;\n      color: #ffffff;\n      font-family: -apple-system, BlinkMacSystemFont, \"SF Pro Display\", \"Segoe UI\", Roboto, sans-serif;\n      min-height: 100vh;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: space-between;\n      padding: 12px 16px 24px 16px;\n      overflow-x: hidden;\n      overflow-y: auto;\n    }\n\n    .container {\n      width: 100%;\n      max-width: 440px;\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      gap: 12px;\n      flex: 1;\n    }\n\n    /* 1. BARRE SUP\u00c9RIEURE IDENTIQUE \u00c0 L'H\u00d4TE */\n    .top-bar {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      padding: 4px 0;\n    }\n    .room-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(56, 189, 248, 0.15);\n      color: #38bdf8;\n      padding: 6px 12px;\n      border-radius: 12px;\n      font-size: 0.78rem;\n      font-weight: 800;\n      letter-spacing: 1px;\n      border: 1px solid rgba(56, 189, 248, 0.3);\n    }\n    .connection-dot {\n      width: 8px;\n      height: 8px;\n      border-radius: 50%;\n      background: #10b981;\n      box-shadow: 0 0 8px #10b981;\n    }\n    .round-title {\n      font-size: 1.15rem;\n      font-weight: 900;\n      background: linear-gradient(135deg, #fbbf24, #f59e0b);\n      -webkit-background-clip: text;\n      -webkit-text-fill-color: transparent;\n      letter-spacing: 0.5px;\n      text-transform: uppercase;\n    }\n    .score-badge {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(250, 204, 21, 0.12);\n      border: 1px solid rgba(250, 204, 21, 0.3);\n      padding: 6px 14px;\n      border-radius: 20px;\n      font-size: 0.95rem;\n      font-weight: 900;\n      color: #facc15;\n    }\n\n    /* 2. BARRE LECTEUR DEEZER INT\u00c9GR\u00c9 */\n    .player-bar {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      gap: 12px;\n      background: rgba(255, 255, 255, 0.07);\n      border: 1px solid rgba(255, 255, 255, 0.1);\n      border-radius: 18px;\n      padding: 10px 14px;\n    }\n    .play-icon {\n      width: 36px;\n      height: 36px;\n      border-radius: 50%;\n      background: linear-gradient(135deg, #06b6d4, #3b82f6);\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      font-size: 0.95rem;\n      color: #fff;\n      flex-shrink: 0;\n      box-shadow: 0 4px 12px rgba(6, 182, 212, 0.35);\n    }\n    .track-info {\n      display: flex;\n      flex-direction: column;\n      flex: 1;\n      min-width: 0;\n    }\n    .track-number {\n      font-size: 0.9rem;\n      font-weight: 800;\n      color: #ffffff;\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n    }\n    .track-status {\n      font-size: 0.75rem;\n      color: #94a3b8;\n      white-space: nowrap;\n      overflow: hidden;\n      text-overflow: ellipsis;\n    }\n    .player-pill {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      background: rgba(255, 255, 255, 0.1);\n      padding: 5px 12px;\n      border-radius: 14px;\n      font-size: 0.82rem;\n      font-weight: 700;\n      flex-shrink: 0;\n    }\n    .player-dot {\n      width: 10px;\n      height: 10px;\n      border-radius: 50%;\n      background: #ef4444;\n    }\n\n    /* CLASSEMENT EN DIRECT (TOUS LES JOUEURS + H\u00d4TE) */\n    .leaderboard-strip {\n      width: 100%;\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      overflow-x: auto;\n      padding: 6px 2px;\n      scrollbar-width: none;\n      -webkit-overflow-scrolling: touch;\n    }\n    .leaderboard-strip::-webkit-scrollbar { display: none; }\n    .leaderboard-chip {\n      display: inline-flex;\n      align-items: center;\n      gap: 6px;\n      padding: 6px 12px;\n      border-radius: 14px;\n      background: rgba(255, 255, 255, 0.07);\n      font-size: 0.82rem;\n      font-weight: 700;\n      white-space: nowrap;\n      flex-shrink: 0;\n      border: 1px solid rgba(255, 255, 255, 0.12);\n    }\n    .leaderboard-chip.is-host {\n      border-color: #facc15;\n      background: rgba(250, 204, 21, 0.15);\n      color: #facc15;\n    }\n    .leaderboard-chip.is-me {\n      border-color: #38bdf8;\n      background: rgba(56, 189, 248, 0.15);\n      color: #38bdf8;\n    }\n    .chip-name { font-weight: 800; }\n    .chip-score { font-weight: 900; color: #fff; }\n\n    /* COMPTE \u00c0 REBOURS 30s BANNER */\n    .countdown-banner {\n      width: 100%;\n      display: none;\n      align-items: center;\n      justify-content: center;\n      gap: 8px;\n      background: #ef4444;\n      color: #fff;\n      padding: 8px 14px;\n      border-radius: 12px;\n      font-weight: 900;\n      font-size: 0.9rem;\n      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.5);\n      animation: pulse 1s infinite alternate;\n    }\n    @keyframes pulse {\n      from { transform: scale(1); }\n      to { transform: scale(1.02); }\n    }\n\n    /* 3. LE BUZZER MODERNE \u00c9PUR\u00c9 \u2014 REPRODUCTION FID\u00c8LE DE L'APP IOS */\n    .buzzer-area {\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      width: 100%;\n      flex: 1;\n      min-height: 340px;\n      position: relative;\n    }\n    .buzzer-wrapper {\n      position: relative;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      width: 270px;\n      height: 270px;\n    }\n    .buzzer-glow {\n      position: absolute;\n      width: 270px;\n      height: 270px;\n      border-radius: 50%;\n      background: radial-gradient(circle, rgba(255, 46, 147, 0.35) 0%, rgba(168, 85, 247, 0.2) 40%, rgba(0, 242, 254, 0.12) 60%, transparent 75%);\n      animation: neonPulse 2s ease-in-out infinite alternate;\n      pointer-events: none;\n      z-index: 1;\n    }\n    @keyframes neonPulse {\n      0% { transform: scale(0.96); opacity: 0.65; }\n      100% { transform: scale(1.05); opacity: 1; }\n    }\n    .buzzer-base {\n      position: relative;\n      width: 226px;\n      height: 226px;\n      border-radius: 50%;\n      background: #0b0f19;\n      box-shadow: \n        0 14px 40px rgba(0, 0, 0, 0.75),\n        0 0 25px rgba(0, 242, 254, 0.35),\n        0 0 35px rgba(255, 46, 147, 0.25);\n      border: 3px solid transparent;\n      background-image: linear-gradient(#0b0f19, #0b0f19), linear-gradient(135deg, #00f2fe, #ff2e93, #a855f7);\n      background-origin: border-box;\n      background-clip: padding-box, border-box;\n      display: flex;\n      align-items: center;\n      justify-content: center;\n      z-index: 2;\n    }\n    .buzzer-btn {\n      width: 206px;\n      height: 206px;\n      border-radius: 50%;\n      border: 2px solid rgba(255, 255, 255, 0.5);\n      background: radial-gradient(circle at 40% 30%, #ff5277 0%, #dc143c 55%, #880e28 95%);\n      box-shadow: \n        0 14px 35px rgba(220, 20, 60, 0.55),\n        inset 0 3px 8px rgba(255, 255, 255, 0.75),\n        inset 0 -5px 12px rgba(0, 0, 0, 0.7);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      cursor: pointer;\n      position: relative;\n      overflow: hidden;\n      transition: transform 0.12s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.12s ease, filter 0.15s ease;\n      touch-action: manipulation;\n      user-select: none;\n      -webkit-user-select: none;\n      -webkit-tap-highlight-color: transparent;\n      outline: none;\n    }\n    /* Reflet sp\u00e9culaire en verre bomb\u00e9 (Effet Apple Glass) */\n    .buzzer-btn::after {\n      content: '';\n      position: absolute;\n      top: 10px;\n      left: 28px;\n      right: 28px;\n      height: 55px;\n      border-radius: 50% / 60%;\n      background: linear-gradient(to bottom, rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0.05));\n      pointer-events: none;\n    }\n    .buzzer-btn:active:not(:disabled) {\n      transform: scale(0.92);\n      box-shadow: \n        0 6px 18px rgba(220, 20, 60, 0.4),\n        inset 0 2px 5px rgba(255, 255, 255, 0.5),\n        inset 0 -3px 8px rgba(0, 0, 0, 0.8);\n    }\n    .buzzer-btn.is-locked {\n      background: radial-gradient(circle at 40% 30%, #475569 0%, #1e293b 70%, #0f172a 100%) !important;\n      border-color: rgba(255, 255, 255, 0.15) !important;\n      box-shadow: inset 0 4px 10px rgba(0, 0, 0, 0.6) !important;\n      cursor: not-allowed;\n      transform: scale(0.96);\n      opacity: 0.75;\n    }\n    .buzzer-btn.is-locked::after {\n      display: none;\n    }\n    .buzzer-icon {\n      display: none;\n      font-size: 2.2rem;\n      line-height: 1;\n      margin-bottom: 6px;\n      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));\n    }\n    .buzzer-text {\n      font-size: 2.6rem;\n      font-weight: 900;\n      color: #ffffff;\n      letter-spacing: 4px;\n      margin-right: -4px;\n      text-transform: uppercase;\n      text-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);\n      line-height: 1;\n      text-align: center;\n      margin-top: 4px;\n    }\n    .buzzer-sub {\n      display: none !important;\n    }\n    .status-msg-waiting {\n      color: #94a3b8;\n      font-size: 0.95rem;\n      font-weight: 700;\n      margin-top: 14px;\n      text-align: center;\n    }\n\n    /* 4. \u00c9TAT LORSQU'UN JOUEUR BUZZE */\n    .buzzed-container {\n      width: 100%;\n      display: none;\n      flex-direction: column;\n      align-items: center;\n      gap: 12px;\n      animation: popIn 0.25s ease-out;\n    }\n    @keyframes popIn {\n      from { transform: scale(0.95); opacity: 0; }\n      to { transform: scale(1); opacity: 1; }\n    }\n\n    .buzz-detected-title {\n      font-size: 1.25rem;\n      font-weight: 900;\n      color: #ef4444;\n      letter-spacing: 1.5px;\n      text-align: center;\n    }\n\n    /* Carte Joueur Vainqueur */\n    .winner-card {\n      width: 100%;\n      padding: 20px 14px;\n      border-radius: 22px;\n      background: linear-gradient(135deg, #ef4444, #8b5cf6 90%);\n      border: 2px solid rgba(255, 255, 255, 0.3);\n      box-shadow: 0 10px 25px rgba(239, 68, 68, 0.4);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      gap: 6px;\n      text-align: center;\n    }\n    .winner-badge-top {\n      display: inline-flex;\n      align-items: center;\n      gap: 8px;\n      padding: 6px 14px;\n      border-radius: 14px;\n      background: rgba(239, 68, 68, 0.15);\n      border: 1px solid rgba(239, 68, 68, 0.4);\n      margin-bottom: 2px;\n    }\n    .winner-badge-dot {\n      width: 10px;\n      height: 10px;\n      border-radius: 50%;\n      background: #ef4444;\n      box-shadow: 0 0 8px #ef4444;\n    }\n    .winner-name-label {\n      font-size: 0.95rem;\n      font-weight: 900;\n      color: #ef4444;\n      letter-spacing: 1.2px;\n      text-transform: uppercase;\n    }\n    .reaction-pill {\n      display: inline-flex;\n      align-items: center;\n      gap: 4px;\n      background: rgba(255, 255, 255, 0.12);\n      padding: 3px 8px;\n      border-radius: 8px;\n      font-family: monospace;\n      font-size: 0.8rem;\n      font-weight: 900;\n      color: #ffffff;\n    }\n\n    /* Pilule Compte \u00e0 rebours r\u00e9ponse 5s \u2014 GRAND FORMAT */\n    .answer-timer-pill {\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      gap: 3px;\n      background: rgba(0, 0, 0, 0.55);\n      border: 1.5px solid #facc15;\n      color: #facc15;\n      padding: 8px 18px;\n      border-radius: 14px;\n      width: 100%;\n      text-align: center;\n      transition: all 0.25s;\n    }\n    .answer-timer-num {\n      font-size: 1.8rem;\n      font-weight: 900;\n      line-height: 1.1;\n      letter-spacing: 1px;\n    }\n    .answer-timer-sub {\n      font-size: 0.68rem;\n      font-weight: 900;\n      letter-spacing: 1.2px;\n      text-transform: uppercase;\n      opacity: 0.9;\n    }\n\n    /* Carte R\u00e9v\u00e9lation Morceau (Titre + Artiste en grand) */\n    .song-reveal-box {\n      width: 100%;\n      padding: 14px;\n      border-radius: 18px;\n      background: rgba(0, 0, 0, 0.55);\n      border: 1.5px solid rgba(56, 189, 248, 0.4);\n      box-shadow: 0 0 15px rgba(56, 189, 248, 0.2);\n      display: flex;\n      flex-direction: column;\n      gap: 6px;\n      text-align: center;\n      position: relative;\n      overflow: hidden;\n      transition: filter 0.3s, opacity 0.3s;\n    }\n    .song-reveal-header {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      margin-bottom: 2px;\n    }\n    .song-reveal-tag {\n      font-size: 0.72rem;\n      font-weight: 900;\n      color: #38bdf8;\n      letter-spacing: 1px;\n      text-transform: uppercase;\n    }\n    .btn-reveal-now {\n      background: rgba(56, 189, 248, 0.18);\n      border: 1px solid rgba(56, 189, 248, 0.4);\n      color: #38bdf8;\n      padding: 4px 10px;\n      border-radius: 10px;\n      font-size: 0.72rem;\n      font-weight: 800;\n      cursor: pointer;\n    }\n    .song-reveal-cinema {\n      display: none;\n      align-items: center;\n      justify-content: center;\n      gap: 6px;\n      font-size: 1.35rem;\n      font-weight: 900;\n      color: #38bdf8;\n      text-shadow: 0 0 12px rgba(56, 189, 248, 0.7);\n      letter-spacing: 0.8px;\n      text-transform: uppercase;\n      margin-bottom: 2px;\n      line-height: 1.2;\n    }\n    .song-reveal-title {\n      font-size: 1.4rem;\n      font-weight: 900;\n      color: #ffffff;\n      line-height: 1.25;\n      word-break: break-word;\n    }\n    .song-reveal-artist {\n      font-size: 1.05rem;\n      font-weight: 700;\n      color: #facc15;\n      word-break: break-word;\n    }\n\n    /* Section Attribution des Points */\n    .scoring-section {\n      width: 100%;\n      display: flex;\n      flex-direction: column;\n      gap: 10px;\n    }\n    .scoring-prompt {\n      font-size: 0.82rem;\n      font-weight: 900;\n      color: #facc15;\n      letter-spacing: 1px;\n      text-transform: uppercase;\n      text-align: center;\n    }\n    .scoring-grid {\n      display: grid;\n      grid-template-columns: 1fr 1fr 1fr;\n      gap: 8px;\n      width: 100%;\n    }\n    .score-action-btn {\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      padding: 12px 6px;\n      border-radius: 16px;\n      border: none;\n      cursor: pointer;\n      color: #fff;\n      transition: transform 0.08s, opacity 0.2s;\n    }\n    .score-action-btn:active:not(:disabled) {\n      transform: scale(0.94);\n    }\n    .score-action-btn:disabled {\n      opacity: 0.4;\n      cursor: not-allowed;\n    }\n    .score-btn-zero {\n      background: rgba(239, 68, 68, 0.9);\n      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.35);\n    }\n    .score-btn-half {\n      background: #f59e0b;\n      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);\n    }\n    .score-btn-full {\n      background: #10b981;\n      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);\n    }\n    .btn-icon {\n      font-size: 1.3rem;\n      margin-bottom: 2px;\n    }\n    .btn-title {\n      font-size: 1.15rem;\n      font-weight: 900;\n    }\n    .btn-subtitle {\n      font-size: 0.62rem;\n      font-weight: 700;\n      opacity: 0.9;\n      text-align: center;\n      line-height: 1.1;\n      margin-top: 2px;\n    }\n\n    .btn-skip {\n      width: 100%;\n      padding: 13px;\n      border-radius: 14px;\n      border: 1px solid rgba(255, 255, 255, 0.25);\n      background: linear-gradient(135deg, #06b6d4, #8b5cf6);\n      color: #ffffff;\n      font-size: 0.92rem;\n      font-weight: 900;\n      letter-spacing: 0.6px;\n      text-transform: uppercase;\n      cursor: pointer;\n      text-align: center;\n      box-shadow: 0 4px 14px rgba(139, 92, 246, 0.35);\n      transition: transform 0.08s;\n      margin-top: 6px;\n      display: none;\n    }\n    .btn-skip:active {\n      transform: scale(0.97);\n    }\n    .btn-resume {\n      width: 100%;\n      padding: 10px;\n      border-radius: 12px;\n      border: 1px solid rgba(255, 255, 255, 0.15);\n      background: rgba(255, 255, 255, 0.08);\n      color: #e2e8f0;\n      font-size: 0.8rem;\n      font-weight: 700;\n      cursor: pointer;\n      display: none;\n      align-items: center;\n      justify-content: center;\n      gap: 6px;\n      transition: transform 0.08s;\n      margin-top: 4px;\n    }\n    .btn-resume:active {\n      transform: scale(0.97);\n    }\n\n    /* Toast Notification Flottant */\n    .toast-container {\n      position: fixed;\n      bottom: 20px;\n      left: 50%;\n      transform: translateX(-50%);\n      z-index: 999;\n      display: none;\n      max-width: 90%;\n      background: rgba(16, 185, 129, 0.95);\n      color: #ffffff;\n      padding: 10px 20px;\n      border-radius: 20px;\n      font-size: 0.9rem;\n      font-weight: 800;\n      text-align: center;\n      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);\n      animation: floatUp 0.3s ease-out;\n    }\n    @keyframes floatUp {\n      from { opacity: 0; transform: translate(-50%, 15px); }\n      to { opacity: 1; transform: translate(-50%, 0); }\n    }\n\n    /* Modale Choix Pseudo */\n    .modal {\n      position: fixed;\n      inset: 0;\n      background: rgba(11, 15, 25, 0.96);\n      backdrop-filter: blur(12px);\n      display: flex;\n      flex-direction: column;\n      align-items: center;\n      justify-content: center;\n      padding: 24px;\n      z-index: 100;\n    }\n    .modal.hidden { display: none; }\n    .modal-box {\n      width: 100%;\n      max-width: 340px;\n      text-align: center;\n    }\n    .modal-title {\n      font-size: 1.6rem;\n      font-weight: 900;\n      margin-bottom: 6px;\n      color: #38bdf8;\n    }\n    .modal-desc {\n      color: #94a3b8;\n      font-size: 0.9rem;\n      margin-bottom: 20px;\n    }\n    .input-field {\n      width: 100%;\n      background: #1e293b;\n      border: 2px solid #334155;\n      padding: 14px 16px;\n      border-radius: 12px;\n      color: #fff;\n      font-size: 1.1rem;\n      text-align: center;\n      font-weight: bold;\n      outline: none;\n      margin-bottom: 14px;\n    }\n    .input-field:focus { border-color: #38bdf8; }\n    .color-grid {\n      display: flex;\n      justify-content: center;\n      gap: 12px;\n      margin-bottom: 20px;\n    }\n    .color-btn {\n      width: 42px;\n      height: 42px;\n      border-radius: 50%;\n      border: 3px solid transparent;\n      cursor: pointer;\n      transition: transform 0.2s;\n    }\n    .color-btn.active {\n      transform: scale(1.15);\n      border-color: #ffffff;\n      box-shadow: 0 0 15px rgba(255,255,255,0.5);\n    }\n    .btn-join {\n      width: 100%;\n      background: linear-gradient(135deg, #38bdf8, #2563eb);\n      color: #fff;\n      border: none;\n      padding: 16px;\n      border-radius: 14px;\n      font-size: 1.1rem;\n      font-weight: 800;\n      cursor: pointer;\n      box-shadow: 0 10px 20px rgba(37, 99, 235, 0.4);\n    }\n  </style>\n</head>\n<body>\n\n  <div class=\"container\">\n    <!-- BANNI\u00c8RE SMART IPHONE -->\n    <div id=\"ios-app-banner\" style=\"display:none; width: 100%; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 12px; padding: 8px 12px; font-size: 0.82rem; text-align: center; color: #bae6fd;\">\n      \ud83d\udcf1 <strong>Joueur iPhone ?</strong> T\u00e9l\u00e9charge l'application sur l'App Store pour une exp\u00e9rience 100% native !\n    </div>\n\n    <!-- 1. BARRE SUP\u00c9RIEURE IDENTIQUE \u00c0 L'H\u00d4TE -->\n    <div class=\"top-bar\">\n      <span class=\"room-badge\" id=\"room-badge\"><span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ...</span>\n      <div class=\"round-title\" id=\"round-title\">MANCHE #1</div>\n      <div class=\"score-badge\" id=\"my-score-badge\">\ud83c\udfc6 <span id=\"my-score-val\">0 pt</span></div>\n    </div>\n\n    <!-- 2. BARRE LECTEUR DEEZER INT\u00c9GR\u00c9 -->\n    <div class=\"player-bar\">\n      <div class=\"play-icon\">\u25b6</div>\n      <div class=\"track-info\">\n        <div class=\"track-number\" id=\"bar-track-num\">Morceau #1</div>\n        <div class=\"track-status\" id=\"bar-track-status\">Lecteur Deezer</div>\n      </div>\n      <div class=\"player-pill\">\n        <div class=\"player-dot\" id=\"player-dot\"></div>\n        <span id=\"player-label\">Moi</span>\n      </div>\n    </div>\n\n    <!-- CLASSEMENT ET SCORES EN DIRECT (TOUS LES JOUEURS + H\u00d4TE) -->\n    <div class=\"leaderboard-strip\" id=\"leaderboard-strip\">\n      <div class=\"leaderboard-chip is-host\"><span>\ud83d\udc51</span><span class=\"chip-name\">H\u00f4te</span><span class=\"chip-score\">0 pt</span></div>\n    </div>\n\n    <!-- BANNER D\u00c9COMPTE 30s FIN DE MORCEAU -->\n    <div class=\"countdown-banner\" id=\"countdown-banner\">\n      \u23f3 FIN DU MORCEAU DANS : <span id=\"countdown-sec\">5</span> s !\n    </div>\n\n    <!-- 3. ZONE CENTRALE : ATTENTE (LE BUZZER MODERNE ARCADE COMME L'H\u00d4TE) -->\n    <div class=\"buzzer-area\" id=\"buzzer-area\">\n      <div class=\"buzzer-wrapper\">\n        <div class=\"buzzer-glow\" id=\"buzzer-glow\"></div>\n        <div class=\"buzzer-base\">\n          <button class=\"buzzer-btn\" id=\"buzzer-btn\">\n            <span class=\"buzzer-icon\" id=\"buzzer-icon\"></span>\n            <span class=\"buzzer-text\" id=\"buzzer-text\">BUZZ</span>\n          </button>\n        </div>\n        <div class=\"buzzer-equalizer\" id=\"buzzer-equalizer\">\n          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>\n        </div>\n      </div>\n      <div class=\"status-msg-waiting\" id=\"status-msg-waiting\">\u00c9coute bien la musique...</div>\n    </div>\n\n    <!-- 4. ZONE CENTRALE : BUZZ D\u00c9TECT\u00c9 -->\n    <div class=\"buzzed-container\" id=\"buzzed-container\">\n      <div class=\"buzz-detected-title\" id=\"buzz-detected-title\" style=\"display: none;\"></div>\n\n      <!-- Badge Vainqueur \u00e9pur\u00e9 en haut (comme sur l'app h\u00f4te) -->\n      <div class=\"winner-badge-top\" id=\"winner-badge-top\">\n        <span class=\"winner-badge-dot\" id=\"winner-badge-dot\"></span>\n        <span class=\"winner-name-label\" id=\"winner-name\">JOUEUR</span>\n        <span class=\"reaction-pill\" id=\"reaction-pill\">\u26a1 0.00 s</span>\n      </div>\n\n      <!-- Compte \u00e0 rebours r\u00e9ponse 5s -->\n      <div class=\"answer-timer-pill\" id=\"answer-timer-pill\">\n        <div class=\"answer-timer-num\"><span id=\"answer-timer-seconds\">5</span> s</div>\n        <div class=\"answer-timer-sub\">POUR R\u00c9PONDRE</div>\n      </div>\n\n      <!-- Carte R\u00e9v\u00e9lation Morceau (Titre + Artiste en grand) -->\n      <div class=\"song-reveal-box\" id=\"song-reveal-box\">\n        <div class=\"song-reveal-header\">\n          <span class=\"song-reveal-tag\" id=\"song-reveal-tag\">\ud83d\udd12 R\u00c9PONSE DU MORCEAU</span>\n          <button class=\"btn-reveal-now\" id=\"btn-reveal-now\" onclick=\"revealAnswerNow(true)\">\ud83d\udc41\ufe0f D\u00c9VOILER MAINTENANT</button>\n        </div>\n        <div class=\"song-reveal-cinema\" id=\"song-cinema\"></div>\n        <div class=\"song-reveal-title\" id=\"song-title\">R\u00e9ponse masqu\u00e9e...</div>\n        <div class=\"song-reveal-artist\" id=\"song-artist\">D\u00e9voilement automatique dans 5 s</div>\n      </div>\n\n      <!-- Section Auto-\u00e9valuation des Points (simplifi\u00e9e, sans boutons parasites) -->\n      <div class=\"scoring-section\" id=\"scoring-section\">\n        <div class=\"scoring-prompt\" id=\"scoring-prompt\">VALIDE TES POINTS :</div>\n\n        <div class=\"scoring-grid\" id=\"scoring-grid\">\n          <!-- 0 PT (Faux) -->\n          <button class=\"score-action-btn score-btn-zero\" id=\"score-btn-0\" onclick=\"handleScore(0.0)\">\n            <span class=\"btn-icon\">\u2716</span>\n            <span class=\"btn-title\">0 PT</span>\n            <span class=\"btn-subtitle\">Faux</span>\n          </button>\n\n          <!-- +0.5 PT (Moiti\u00e9) -->\n          <button class=\"score-action-btn score-btn-half\" id=\"score-btn-half\" onclick=\"handleScore(0.5)\">\n            <span class=\"btn-icon\">\u2605</span>\n            <span class=\"btn-title\">+0,5 PT</span>\n            <span class=\"btn-subtitle\">Moiti\u00e9</span>\n          </button>\n\n          <!-- +1 PT (Tout trouv\u00e9) -->\n          <button class=\"score-action-btn score-btn-full\" id=\"score-btn-1\" onclick=\"handleScore(1.0)\">\n            <span class=\"btn-icon\">\u2714</span>\n            <span class=\"btn-title\">+1 PT</span>\n            <span class=\"btn-subtitle\">Trouv\u00e9</span>\n          </button>\n        </div>\n\n        <!-- Passer au morceau suivant ou Relancer -->\n        <button class=\"btn-skip\" id=\"btn-skip\" onclick=\"handleNext()\">\n          MORCEAU SUIVANT \u23ed\n        </button>\n        <button class=\"btn-resume\" id=\"btn-resume\" onclick=\"handleResume()\">\n          <span>\u25b6</span>\n          <span>Relancer la musique (pour les autres)</span>\n        </button>\n      </div>\n    </div>\n  </div>\n\n  <!-- Notification Toast Flottante -->\n  <div class=\"toast-container\" id=\"toast-container\"></div>\n\n  <!-- Modale Pseudo et Code de Salon -->\n  <div class=\"modal\" id=\"modal-join\">\n    <div class=\"modal-box\">\n      <div class=\"modal-title\">Rejoins la partie ! \ud83c\udfb5</div>\n      <div class=\"modal-desc\">Tape ton pr\u00e9nom pour buzzer en direct avec l'h\u00f4te :</div>\n      \n      <input type=\"text\" class=\"input-field\" id=\"input-room\" placeholder=\"CODE SALON (ex: BLND)\" maxlength=\"6\" style=\"display: none; text-transform: uppercase;\">\n      <input type=\"text\" class=\"input-field\" id=\"input-name\" placeholder=\"Ton pr\u00e9nom ou pseudo\" maxlength=\"15\" autofocus>\n      \n      <div class=\"color-grid\">\n        <button class=\"color-btn active\" data-color=\"#ef4444\" style=\"background: #ef4444;\"></button>\n        <button class=\"color-btn\" data-color=\"#3b82f6\" style=\"background: #3b82f6;\"></button>\n        <button class=\"color-btn\" data-color=\"#10b981\" style=\"background: #10b981;\"></button>\n        <button class=\"color-btn\" data-color=\"#f59e0b\" style=\"background: #f59e0b;\"></button>\n        <button class=\"color-btn\" data-color=\"#8b5cf6\" style=\"background: #8b5cf6;\"></button>\n      </div>\n\n      <button type=\"button\" class=\"btn-join\" id=\"btn-join\">REJOINDRE LA PARTIE</button>\n    </div>\n  </div>\n\n  <script>\n    const urlParams = new URLSearchParams(window.location.search);\n    let pathRoom = '';\n    const pathParts = window.location.pathname.split('/').filter(Boolean);\n    if (pathParts.length >= 2 && pathParts[0] === 'room') {\n      pathRoom = pathParts[1];\n    } else if (pathParts.length === 1 && pathParts[0] !== 'buzzer' && pathParts[0] !== 'play') {\n      pathRoom = pathParts[0];\n    }\n    let roomCode = (urlParams.get('room') || urlParams.get('code') || urlParams.get('salon') || pathRoom || window.location.hash.replace('#', '') || '').toUpperCase().trim();\n    \n    let myName = localStorage.getItem('bt_cloud_name') || '';\n    let myColor = localStorage.getItem('bt_cloud_color') || '#ef4444';\n    let hasBuzz = false;\n    let hasScoredThisRound = false;\n    let isLockedForThisTrack = false;\n    let ws = null;\n    let myCurrentScore = 0.0;\n    let songStartEpoch = Date.now();\n\n    let currentTrack = {\n      title: 'Blind Test',\n      artist: 'Musique en cours',\n      franchise: '',\n      isCinema: false,\n      round: 1\n    };\n\n    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {\n      const banner = document.getElementById('ios-app-banner');\n      if (banner) banner.style.display = 'block';\n    }\n\n    const modal = document.getElementById('modal-join');\n    const inputRoom = document.getElementById('input-room');\n    const inputName = document.getElementById('input-name');\n    const btnJoin = document.getElementById('btn-join');\n    const playerDot = document.getElementById('player-dot');\n    const playerLabel = document.getElementById('player-label');\n    const myScoreVal = document.getElementById('my-score-val');\n    const roundTitle = document.getElementById('round-title');\n    const barTrackNum = document.getElementById('bar-track-num');\n    const barTrackStatus = document.getElementById('bar-track-status');\n    const roomBadge = document.getElementById('room-badge');\n    const connDot = document.getElementById('conn-dot');\n    const countdownBanner = document.getElementById('countdown-banner');\n    const countdownSec = document.getElementById('countdown-sec');\n\n    const buzzerArea = document.getElementById('buzzer-area');\n    const buzzerBtn = document.getElementById('buzzer-btn');\n    const statusMsgWaiting = document.getElementById('status-msg-waiting');\n    const buzzedContainer = document.getElementById('buzzed-container');\n    const buzzDetectedTitle = document.getElementById('buzz-detected-title');\n    const winnerCard = document.getElementById('winner-card');\n    const winnerName = document.getElementById('winner-name');\n    const reactionPill = document.getElementById('reaction-pill');\n    const answerTimerPill = document.getElementById('answer-timer-pill');\n    const songRevealBox = document.getElementById('song-reveal-box');\n    const songCinema = document.getElementById('song-cinema');\n    const songTitle = document.getElementById('song-title');\n    const songArtist = document.getElementById('song-artist');\n    const scoringPrompt = document.getElementById('scoring-prompt');\n    const scoringGrid = document.getElementById('scoring-grid');\n    const btnRevealNow = document.getElementById('btn-reveal-now');\n    const toastContainer = document.getElementById('toast-container');\n    const colorBtns = document.querySelectorAll('.color-btn');\n\n    if (!roomCode) {\n      inputRoom.style.display = 'block';\n    } else {\n      roomBadge.innerHTML = `<span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ${roomCode}`;\n    }\n\n    if (myName) inputName.value = myName;\n\n    colorBtns.forEach(btn => {\n      btn.addEventListener('click', () => {\n        colorBtns.forEach(b => b.classList.remove('active'));\n        btn.classList.add('active');\n        myColor = btn.getAttribute('data-color');\n      });\n    });\n\n    btnJoin.addEventListener('click', handleJoin);\n    btnJoin.addEventListener('touchend', (e) => {\n      e.preventDefault();\n      handleJoin();\n    });\n    inputName.addEventListener('keyup', (e) => { if (e.key === 'Enter') handleJoin(); });\n    inputRoom.addEventListener('keyup', (e) => { if (e.key === 'Enter') handleJoin(); });\n\n    function handleJoin() {\n      if (!roomCode) {\n        roomCode = inputRoom.value.toUpperCase().trim();\n      }\n      if (!roomCode) {\n        inputRoom.style.display = 'block';\n        inputRoom.focus();\n        inputRoom.style.borderColor = '#ef4444';\n        showToast('\u26a0\ufe0f Entre le code du salon affich\u00e9 sur l\u2019\u00e9cran h\u00f4te');\n        return;\n      }\n\n      let name = inputName.value.trim();\n      if (!name) {\n        name = \"Joueur \" + Math.floor(10 + Math.random() * 90);\n        inputName.value = name;\n      }\n\n      myName = name;\n      localStorage.setItem('bt_cloud_name', myName);\n      localStorage.setItem('bt_cloud_color', myColor);\n\n      modal.classList.add('hidden');\n      modal.style.display = 'none';\n      playerLabel.textContent = myName;\n      playerDot.style.background = myColor;\n      roomBadge.innerHTML = `<span class=\"connection-dot\" id=\"conn-dot\"></span>SALON ${roomCode}`;\n\n      connectWebSocket();\n    }\n\n    function connectWebSocket() {\n      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n      const wsUrl = `${protocol}//${window.location.host}/ws`;\n\n      statusMsgWaiting.textContent = \"Connexion au Cloud...\";\n      \n      try {\n        ws = new WebSocket(wsUrl);\n      } catch (e) {\n        statusMsgWaiting.textContent = \"Erreur de connexion\";\n        return;\n      }\n\n      ws.onopen = () => {\n        connDot.style.background = '#10b981';\n        statusMsgWaiting.textContent = \"\u00c9coute bien la musique...\";\n        \n        ws.send(JSON.stringify({\n          type: 'join',\n          room: roomCode,\n          code: roomCode,\n          name: myName,\n          playerName: myName,\n          color: myColor\n        }));\n      };\n\n      ws.onmessage = (event) => {\n        try {\n          const data = JSON.parse(event.data);\n          handleServerMessage(data);\n        } catch (e) {}\n      };\n\n      ws.onclose = () => {\n        connDot.style.background = '#ef4444';\n        statusMsgWaiting.textContent = \"Reconnexion...\";\n        setTimeout(connectWebSocket, 2000);\n      };\n\n      ws.onerror = () => {\n        ws.close();\n      };\n    }\n\n    function triggerBuzz() {\n      if (!ws || ws.readyState !== WebSocket.OPEN) {\n        showToast('\u26a0\ufe0f Reconnexion au serveur en cours...');\n        connectWebSocket();\n        return;\n      }\n      if (isLockedForThisTrack) {\n        showToast('Tu as d\u00e9j\u00e0 buzz\u00e9 sur ce morceau !');\n        return;\n      }\n      if (hasBuzz) return;\n      hasBuzz = true;\n      hasScoredThisRound = false;\n\n      if (navigator.vibrate) {\n        navigator.vibrate([100, 50, 100]);\n      }\n\n      // Calcul pr\u00e9cis du temps de r\u00e9action depuis le d\u00e9but de la manche\n      const elapsedMs = Math.max(120, Date.now() - songStartEpoch);\n      const reactionSec = Math.min(30.0, elapsedMs / 1000.0);\n      const reactionMs = Math.round(reactionSec * 1000);\n\n      const payload = {\n        type: 'buzz',\n        room: roomCode,\n        code: roomCode,\n        name: myName,\n        playerName: myName,\n        reactionMs: reactionMs,\n        reactionTime: reactionSec,\n        clientTime: reactionMs\n      };\n      ws.send(JSON.stringify(payload));\n\n      // S\u00e9curit\u00e9 anti-blocage local : si aucune confirmation du serveur sous 2s, on r\u00e9arme\n      setTimeout(() => {\n        if (buzzerArea && buzzerArea.style.display !== 'none') {\n          hasBuzz = false;\n        }\n      }, 2000);\n    }\n\n    function detectFranchise(rawTitle, rawArtist, rawAlbum, rawFranchise) {\n      if (rawFranchise && rawFranchise.trim().length > 0 && rawFranchise.trim().toLowerCase() !== 'blind test') {\n        return rawFranchise.trim();\n      }\n      const combined = `${rawTitle || ''} ${rawArtist || ''} ${rawAlbum || ''}`.toLowerCase();\n\n      // Disney & Films d'animation cultes\n      if (combined.includes('roi lion') || combined.includes('lion king') || combined.includes('hakuna matata') || combined.includes('histoire de la vie') || combined.includes('circle of life') || combined.includes('je voudrais d\u00e9j\u00e0 \u00eatre roi') || combined.includes(\"l'amour brille sous les \u00e9toiles\")) return 'Le Roi Lion';\n      if (combined.includes('reine des neiges') || combined.includes('frozen') || combined.includes('lib\u00e9r\u00e9e, d\u00e9livr\u00e9e') || combined.includes('bonhomme de neige') || combined.includes('le renouveau') || combined.includes('dans un autre monde')) return 'La Reine des Neiges';\n      if (combined.includes('aladdin') || combined.includes('ce r\u00eave bleu') || combined.includes('prince ali') || combined.includes('nuits d\\'arabie') || combined.includes('ami comme moi') || combined.includes('friend like me')) return 'Aladdin';\n      if (combined.includes('petite sir\u00e8ne') || combined.includes('petite sirene') || combined.includes('little mermaid') || combined.includes('sous l\\'oc\u00e9an') || combined.includes('partir l\u00e0-bas') || combined.includes('under the sea') || combined.includes('embrasse-la')) return 'La Petite Sir\u00e8ne';\n      if (combined.includes('belle et la b\u00eate') || combined.includes('belle et la bete') || combined.includes('beauty and the beast') || combined.includes('histoire \u00e9ternelle') || combined.includes('c\\'est la f\u00eate') || combined.includes('be our guest')) return 'La Belle et la B\u00eate';\n      if (combined.includes('mulan') || combined.includes('comme un homme') || combined.includes('r\u00e9flexion') || combined.includes('reflection')) return 'Mulan';\n      if (combined.includes('tarzan') || combined.includes('entre deux mondes') || combined.includes('enfant de l\\'homme') || combined.includes('strangers like me') || combined.includes('son of man')) return 'Tarzan';\n      if (combined.includes('hercule') || combined.includes('hercules') || combined.includes('de z\u00e9ro en h\u00e9ros') || combined.includes('jamais je n\\'avouerai') || combined.includes('le monde qui est le mien')) return 'Hercule';\n      if (combined.includes('raiponce') || combined.includes('tangled') || combined.includes('o\u00f9 est la vraie vie') || combined.includes('j\\'ai un r\u00eave') || combined.includes('je veux y croire')) return 'Raiponce';\n      if (combined.includes('vaiana') || combined.includes('moana') || combined.includes('bleu lumi\u00e8re') || combined.includes('pour les hommes') || combined.includes('how far i\\'ll go')) return 'Vaiana';\n      if (combined.includes('encanto') || combined.includes('ne parlons pas de bruno') || combined.includes('famille madrigal')) return 'Encanto';\n      if (combined.includes('coco') || combined.includes('un poco loco') || combined.includes('ne m\\'oublie pas')) return 'Coco';\n      if (combined.includes('zootopie') || combined.includes('zootopia') || combined.includes('try everything')) return 'Zootopie';\n      if (combined.includes('pocahontas') || combined.includes('l\\'air du vent') || combined.includes('des sauvages')) return 'Pocahontas';\n      if (combined.includes('peter pan') || combined.includes('tu t\\'envoles')) return 'Peter Pan';\n      if (combined.includes('aristochats') || combined.includes('aristocats') || combined.includes('tout le monde veut devenir un cat')) return 'Les Aristochats';\n      if (combined.includes('livre de la jungle') || combined.includes('jungle book') || combined.includes('il en faut peu pour \u00eatre heureux') || combined.includes('\u00eatre un homme comme vous')) return 'Le Livre de la Jungle';\n      if (combined.includes('cendrillon') || combined.includes('cinderella') || combined.includes('bibbidi') || combined.includes('tendre r\u00eave')) return 'Cendrillon';\n      if (combined.includes('blanche neige') || combined.includes('snow white') || combined.includes('un jour mon prince viendra') || combined.includes('heigh-ho')) return 'Blanche-Neige et les Sept Nains';\n      if (combined.includes('belle au bois dormant') || combined.includes('sleeping beauty')) return 'La Belle au Bois Dormant';\n      if (combined.includes('pinocchio') || combined.includes('bonne \u00e9toile')) return 'Pinocchio';\n      if (combined.includes('dumbo')) return 'Dumbo';\n      if (combined.includes('bambi')) return 'Bambi';\n      if (combined.includes('lilo') || combined.includes('stitch')) return 'Lilo & Stitch';\n      if (combined.includes('fr\u00e8re des ours') || combined.includes('brother bear')) return 'Fr\u00e8re des Ours';\n      if (combined.includes('\u00e9trange no\u00ebl') || combined.includes('nightmare before christmas') || combined.includes('bienvenue \u00e0 halloween')) return 'L\\'\u00c9trange No\u00ebl de Monsieur Jack';\n      if (combined.includes('princesse et la grenouille') || combined.includes('princess and the frog') || combined.includes('au bout du r\u00eave')) return 'La Princesse et la Grenouille';\n      if (combined.includes('toy story') || combined.includes('je suis ton ami') || combined.includes('you\\'ve got a friend in me')) return 'Toy Story';\n      if (combined.includes('shrek') || combined.includes('all star') || combined.includes('accidentally in love') || combined.includes('i\\'m a believer')) return 'Shrek';\n      if (combined.includes('nemo') || combined.includes('dory')) return 'Le Monde de Nemo';\n      if (combined.includes('ratatouille') || combined.includes('le festin')) return 'Ratatouille';\n      if (combined.includes('indestructibles') || combined.includes('incredibles')) return 'Les Indestructibles';\n      if (combined.includes('monstres & cie') || combined.includes('monstres et cie') || combined.includes('monsters inc') || combined.includes('monsters, inc')) return 'Monstres et Cie';\n      if (combined.includes('cars') || combined.includes('life is a highway')) return 'Cars';\n      if (combined.includes('l\u00e0-haut') || combined.includes('la-haut') || combined.includes('married life')) return 'L\u00e0-Haut';\n      if (combined.includes('wall-e') || combined.includes('walle')) return 'WALL-E';\n      if (combined.includes('vice-versa') || combined.includes('inside out')) return 'Vice-Versa';\n      if (combined.includes('madagascar') || combined.includes('i like to move it')) return 'Madagascar';\n      if (combined.includes('\u00e2ge de glace') || combined.includes('age de glace') || combined.includes('ice age')) return 'L\\'\u00c2ge de Glace';\n      if (combined.includes('dragons') || combined.includes('how to train your dragon')) return 'Dragons';\n      if (combined.includes('kung fu panda')) return 'Kung Fu Panda';\n      if (combined.includes('moi, moche et m\u00e9chant') || combined.includes('despicable me') || combined.includes('minions')) return 'Moi, Moche et M\u00e9chant';\n\n      return '';\n    }\n\n    function handleScore(points) {\n      if (hasScoredThisRound) return;\n      hasScoredThisRound = true;\n      isLockedForThisTrack = true;\n\n      if (navigator.vibrate) {\n        navigator.vibrate([100, 50, 100]);\n      }\n\n      // D\u00e9sactiver les boutons de score pour \u00e9viter le double-clic\n      const btn0 = document.getElementById('score-btn-0');\n      const btnHalf = document.getElementById('score-btn-half');\n      const btn1 = document.getElementById('score-btn-1');\n      if (btn0) btn0.disabled = true;\n      if (btnHalf) btnHalf.disabled = true;\n      if (btn1) btn1.disabled = true;\n\n      // Mise \u00e0 jour optimiste imm\u00e9diate de mon score personnel\n      myCurrentScore += points;\n      myScoreVal.textContent = (myCurrentScore % 1 === 0 ? myCurrentScore : myCurrentScore.toFixed(1)) + ' pt' + (myCurrentScore > 1 ? 's' : '');\n\n      const label = points === 1.0 ? '+1 PT' : (points === 0.5 ? '+0,5 PT' : '0 PT');\n      showToast(points > 0 ? `\u2705 Points valid\u00e9s (${label}) !` : `\u274c R\u00e9ponse fausse (0 PT)`);\n\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        const payload = {\n          type: 'score_submission',\n          room: roomCode,\n          code: roomCode,\n          name: myName,\n          playerName: myName,\n          points: points\n        };\n        ws.send(JSON.stringify(payload));\n\n        // Relance automatique imm\u00e9diate de la musique sur l'h\u00f4te iPhone\n        setTimeout(() => {\n          if (ws && ws.readyState === WebSocket.OPEN) {\n            ws.send(JSON.stringify({\n              type: 'resume_music',\n              room: roomCode,\n              code: roomCode,\n              playerName: myName\n            }));\n          }\n        }, 250);\n      }\n\n      // Retour automatique \u00e0 l'\u00e9cran d'attente apr\u00e8s validation du score\n      setTimeout(() => {\n        resetToWaitingScreen();\n      }, 1200);\n    }\n\n    function handleNext() {\n      showToast(\"\u23ed Morceau suivant...\");\n      resetToWaitingScreen();\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({\n          type: 'next_track',\n          room: roomCode,\n          code: roomCode,\n          playerName: myName\n        }));\n      }\n    }\n\n    function handleResume() {\n      showToast(\"\u25b6\ufe0f Relance de la musique...\");\n      resetToWaitingScreen();\n      if (ws && ws.readyState === WebSocket.OPEN) {\n        ws.send(JSON.stringify({\n          type: 'resume_music',\n          room: roomCode,\n          code: roomCode,\n          playerName: myName\n        }));\n      }\n    }\n\n    let clientCountdownTimer = null;\n    let clientCountdownVal = 5;\n\n    function startClientAnswerTimer(isMe, winner) {\n      clearInterval(clientCountdownTimer);\n      clientCountdownVal = 5;\n\n      answerTimerPill.style.borderColor = '#facc15';\n      answerTimerPill.style.color = '#facc15';\n      answerTimerPill.innerHTML = `\n        <div class=\"answer-timer-num\"><span id=\"answer-timer-seconds\">5</span> s</div>\n        <div class=\"answer-timer-sub\">POUR R\u00c9PONDRE</div>\n      `;\n\n      const songRevealTag = document.getElementById('song-reveal-tag');\n      const sCinema = document.getElementById('song-cinema');\n\n      if (isMe) {\n        // C'EST MOI QUI AI BUZZ\u00c9 : R\u00e9ponse masqu\u00e9e avec compte \u00e0 rebours de 5s et bouton de d\u00e9voilement imm\u00e9diat\n        if (songRevealTag) songRevealTag.textContent = '\ud83d\udd12 R\u00c9PONSE DU MORCEAU';\n        if (sCinema) sCinema.style.display = 'none';\n        songTitle.textContent = 'R\u00e9ponse masqu\u00e9e...';\n        songArtist.textContent = 'D\u00e9voilement automatique dans 5 s';\n        songTitle.style.color = 'rgba(255, 255, 255, 0.4)';\n        songArtist.style.color = 'rgba(255, 255, 255, 0.4)';\n        if (btnRevealNow) btnRevealNow.style.display = 'inline-block';\n      } else {\n        // CE N'EST PAS MOI QUI AI BUZZ\u00c9 : R\u00e9ponse STRICTEMENT MASQU\u00c9E pour ne pas tricher !\n        if (songRevealTag) songRevealTag.textContent = '\ud83d\udd12 R\u00c9PONSE MASQU\u00c9E POUR TOI';\n        if (sCinema) sCinema.style.display = 'none';\n        songTitle.textContent = 'R\u00e9ponse masqu\u00e9e pour toi';\n        songArtist.textContent = `Seul ${winner} a la r\u00e9ponse affich\u00e9e. Reste attentif si sa r\u00e9ponse est fausse !`;\n        songTitle.style.color = 'rgba(255, 255, 255, 0.8)';\n        songArtist.style.color = 'rgba(255, 255, 255, 0.5)';\n        if (btnRevealNow) btnRevealNow.style.display = 'none';\n      }\n\n      clientCountdownTimer = setInterval(() => {\n        if (clientCountdownVal > 1) {\n          clientCountdownVal--;\n          const s = document.getElementById('answer-timer-seconds');\n          if (s) s.textContent = clientCountdownVal;\n          if (isMe) {\n            songArtist.textContent = `D\u00e9voilement automatique dans ${clientCountdownVal} s`;\n          }\n        } else {\n          revealAnswerNow(isMe);\n        }\n      }, 1000);\n    }\n\n    function revealAnswerNow(isMe) {\n      clearInterval(clientCountdownTimer);\n      clientCountdownTimer = null;\n\n      answerTimerPill.style.borderColor = '#10b981';\n      answerTimerPill.style.color = '#10b981';\n      answerTimerPill.innerHTML = `\n        <div class=\"answer-timer-num\" style=\"font-size: 1.35rem;\">\u2705 TEMPS R\u00c9PONSE \u00c9COUL\u00c9</div>\n        <div class=\"answer-timer-sub\" style=\"color: #10b981;\">${isMe ? 'R\u00c9PONSE D\u00c9VOIL\u00c9E' : 'TEMPS DE R\u00c9PONSE TERMIN\u00c9'}</div>\n      `;\n\n      if (btnRevealNow) btnRevealNow.style.display = 'none';\n\n      // R\u00e9v\u00e9lation UNIQUEMENT si c'est moi qui ai buzz\u00e9 ! Pour les autres joueurs, la r\u00e9ponse reste masqu\u00e9e !\n      if (isMe) {\n        const songRevealTag = document.getElementById('song-reveal-tag');\n        const sCinema = document.getElementById('song-cinema');\n        if (songRevealTag) songRevealTag.textContent = '\ud83c\udfb5 R\u00c9PONSE DU MORCEAU';\n\n        if (currentTrack.franchise) {\n          // Affichage Film / Disney / Animation en grand et en vedette !\n          if (sCinema) {\n            sCinema.style.display = 'flex';\n            sCinema.textContent = `\ud83c\udfac ${currentTrack.franchise.toUpperCase()}`;\n          }\n          songTitle.textContent = `Chanson : ${currentTrack.title || 'Blind Test'}`;\n          songTitle.style.color = '#facc15';\n          songArtist.textContent = currentTrack.artist || '';\n          songArtist.style.color = 'rgba(255, 255, 255, 0.7)';\n        } else {\n          // Musique standard\n          if (sCinema) sCinema.style.display = 'none';\n          songTitle.textContent = currentTrack.title || 'Blind Test';\n          songArtist.textContent = currentTrack.artist || 'Musique en cours';\n          songTitle.style.color = '#38bdf8';\n          songArtist.style.color = '#c084fc';\n        }\n      }\n    }\n\n    function stopClientAnswerTimer() {\n      clearInterval(clientCountdownTimer);\n      clientCountdownTimer = null;\n    }\n\n    function showToast(msg) {\n      toastContainer.textContent = msg;\n      toastContainer.style.display = 'block';\n      setTimeout(() => {\n        toastContainer.style.display = 'none';\n      }, 3500);\n    }\n\n    function updateLeaderboard(data) {\n      const strip = document.getElementById('leaderboard-strip');\n      if (!strip) return;\n      \n      let playerList = [];\n      if (Array.isArray(data.players) && data.players.length > 0) {\n        playerList = data.players.map(p => ({\n          name: p.name || p.playerName || 'Joueur',\n          score: Number(p.score || 0),\n          color: p.color || '#38bdf8',\n          isHost: Boolean(p.isHost || (p.name && (p.name.toLowerCase().includes('h\u00f4te') || p.name.toLowerCase().includes('hote'))))\n        }));\n      } else if (data.scores && typeof data.scores === 'object') {\n        playerList = Object.entries(data.scores).filter(([k]) => !['host', 'h\u00f4te', 'hote', 'Moi (Hote)', 'Moi (H\u00f4te)'].includes(k)).map(([name, sc]) => ({\n          name: name,\n          score: Number(sc || 0),\n          color: '#38bdf8',\n          isHost: name.toLowerCase().includes('h\u00f4te') || name.toLowerCase().includes('hote')\n        }));\n      }\n      \n      const hostScore = data.scores ? (data.scores['Moi (H\u00f4te)'] ?? data.scores['Moi (Hote)'] ?? data.scores['host'] ?? data.scores['h\u00f4te']) : null;\n      if (hostScore !== null && !playerList.some(p => p.isHost)) {\n        playerList.unshift({\n          name: 'Moi (H\u00f4te)',\n          score: Number(hostScore),\n          color: '#ec4899',\n          isHost: true\n        });\n      }\n      \n      if (playerList.length === 0) return;\n      \n      // Synchronisation imm\u00e9diate de mon score personnel\n      if (myName) {\n        const me = playerList.find(p => p.name.trim().toLowerCase() === myName.trim().toLowerCase());\n        if (me) {\n          myCurrentScore = me.score;\n          myScoreVal.textContent = (me.score % 1 === 0 ? me.score : me.score.toFixed(1)) + ' pt' + (me.score > 1 ? 's' : '');\n        }\n      }\n      \n      playerList.sort((a, b) => b.score - a.score);\n      \n      strip.innerHTML = playerList.map((p, idx) => {\n        const isMe = myName && p.name.trim().toLowerCase() === myName.trim().toLowerCase();\n        const scoreStr = (p.score % 1 === 0 ? p.score : p.score.toFixed(1)) + ' pt' + (p.score > 1 ? 's' : '');\n        const crown = p.isHost ? '\ud83d\udc51 ' : (idx === 0 ? '\ud83e\udd47 ' : (idx === 1 ? '\ud83e\udd48 ' : (idx === 2 ? '\ud83e\udd49 ' : '')));\n        const label = isMe ? `${p.name} (Toi)` : p.name;\n        const cls = p.isHost ? 'leaderboard-chip is-host' : (isMe ? 'leaderboard-chip is-me' : 'leaderboard-chip');\n        return `<div class=\"${cls}\">\n          <span>${crown}</span>\n          <span class=\"chip-name\">${label}</span>\n          <span class=\"chip-score\">${scoreStr}</span>\n        </div>`;\n      }).join('');\n    }\n\n    function resetToWaitingScreen() {\n      hasBuzz = false;\n      hasScoredThisRound = false;\n      stopClientAnswerTimer();\n\n      buzzerArea.style.display = 'flex';\n      buzzedContainer.style.display = 'none';\n      // R\u00e9initialiser les \u00e9l\u00e9ments de r\u00e9ponse pour le prochain buzz\n      const sCinema = document.getElementById('song-cinema');\n      if (sCinema) sCinema.style.display = 'none';\n      const songRevealTag = document.getElementById('song-reveal-tag');\n      if (songRevealTag) songRevealTag.textContent = '\ud83d\udd12 R\u00c9PONSE DU MORCEAU';\n      songTitle.textContent = 'R\u00e9ponse masqu\u00e9e...';\n      songArtist.textContent = 'D\u00e9voilement automatique dans 5 s';\n      songTitle.style.color = 'rgba(255, 255, 255, 0.4)';\n      songArtist.style.color = 'rgba(255, 255, 255, 0.4)';\n      if (btnRevealNow) btnRevealNow.style.display = 'none';\n\n      // Cacher les boutons morceau suivant et relance\n      const btnSkip = document.getElementById('btn-skip');\n      const btnResume = document.getElementById('btn-resume');\n      if (btnSkip) btnSkip.style.display = 'none';\n      if (btnResume) btnResume.style.display = 'none';\n\n      // R\u00e9activation des boutons de score\n      document.getElementById('score-btn-0').disabled = false;\n      document.getElementById('score-btn-half').disabled = false;\n      document.getElementById('score-btn-1').disabled = false;\n\n      const bIcon = document.getElementById('buzzer-icon');\n      const bText = document.getElementById('buzzer-text');\n      const bSub = document.getElementById('buzzer-sub');\n      const bGlow = document.getElementById('buzzer-glow');\n\n      if (isLockedForThisTrack) {\n        buzzerBtn.classList.add('is-locked');\n        buzzerBtn.disabled = true;\n        if (bIcon) { bIcon.style.display = 'block'; bIcon.textContent = '\ud83d\udd12'; }\n        if (bText) { bText.style.fontSize = '1.3rem'; bText.textContent = 'D\u00c9J\u00c0 BUZZ\u00c9'; }\n        if (bGlow) bGlow.style.display = 'none';\n        statusMsgWaiting.textContent = \"Tu as d\u00e9j\u00e0 buzz\u00e9 sur ce morceau !\";\n      } else {\n        buzzerBtn.classList.remove('is-locked');\n        buzzerBtn.disabled = false;\n        buzzerBtn.style.opacity = '1';\n        buzzerBtn.style.pointerEvents = 'auto';\n        if (bIcon) { bIcon.style.display = 'none'; bIcon.textContent = ''; }\n        if (bText) { bText.style.fontSize = '2.6rem'; bText.textContent = 'BUZZ'; }\n        if (bGlow) bGlow.style.display = 'block';\n        statusMsgWaiting.textContent = \"\u00c9coute bien la musique...\";\n      }\n    }\n\n    function handleServerMessage(data) {\n      if (!data) return;\n\n      // 1. Mise \u00e0 jour continue du classement et de mon score\n      updateLeaderboard(data);\n\n      // 2. Extraction et m\u00e9morisation du morceau en cours\n      let rawTitle = (data.track && data.track.title) || data.title || data.songTitle || currentTrack.title;\n      let rawArtist = (data.track && data.track.artist) || data.artist || currentTrack.artist;\n      let rawAlbum = (data.track && data.track.album) || data.album || '';\n      let rawFranchise = (data.track && (data.track.franchise || data.track.movieFranchise)) || data.franchise || data.movieFranchise || currentTrack.franchise || '';\n\n      if (rawTitle && rawTitle.includes(' \ud83c\udfac ')) {\n        const parts = rawTitle.split(' \ud83c\udfac ');\n        rawTitle = parts[0].trim();\n        if (!rawFranchise && parts.length > 1) {\n          rawFranchise = parts[1].trim();\n        }\n      }\n\n      const detFranchise = detectFranchise(rawTitle, rawArtist, rawAlbum, rawFranchise);\n      currentTrack.franchise = detFranchise;\n      currentTrack.isCinema = Boolean(detFranchise || (data.track && data.track.isCinema) || data.isCinema);\n      currentTrack.title = rawTitle;\n      currentTrack.artist = rawArtist;\n\n      // 3. Manche et Playlist\n      const rNum = data.round || data.roundNumber;\n      if (rNum) {\n        currentTrack.round = rNum;\n        roundTitle.textContent = `MANCHE #${rNum}`;\n        barTrackNum.textContent = `Morceau #${rNum}`;\n      }\n      const plTitle = data.playlist || data.playlistTitle;\n      if (plTitle) {\n        barTrackStatus.textContent = plTitle;\n      }\n\n      // 4. Gestion des types d'\u00e9v\u00e9nements\n      switch (data.type) {\n        case 'start_round':\n        case 'track_update': {\n          // NOUVEAU MORCEAU : D\u00e9verrouillage total pour tous les joueurs !\n          songStartEpoch = Date.now();\n          isLockedForThisTrack = false;\n          countdownBanner.style.display = 'none';\n          resetToWaitingScreen();\n          break;\n        }\n\n        case 'reset': {\n          // Relance pour deviner la 2e moiti\u00e9 (le joueur qui a d\u00e9j\u00e0 buzz\u00e9 reste verrouill\u00e9)\n          songStartEpoch = Date.now();\n          resetToWaitingScreen();\n          break;\n        }\n\n        case 'track_countdown': {\n          if (data.isExpired) {\n            countdownBanner.style.display = 'flex';\n            countdownBanner.textContent = \"TEMPS \u00c9COUL\u00c9 (30s) \u2014 BUZZ TERMIN\u00c9\";\n            buzzerBtn.classList.add('is-locked');\n            buzzerBtn.disabled = true;\n            const bIcon = document.getElementById('buzzer-icon');\n            const bText = document.getElementById('buzzer-text');\n            const bGlow = document.getElementById('buzzer-glow');\n            if (bIcon) { bIcon.style.display = 'block'; bIcon.textContent = '\u23f1\ufe0f'; }\n            if (bText) { bText.style.fontSize = '1.3rem'; bText.textContent = 'TEMPS \u00c9COUL\u00c9'; }\n            if (bGlow) bGlow.style.display = 'none';\n          } else if (data.remaining !== undefined && data.remaining <= 5) {\n            countdownBanner.style.display = 'flex';\n            countdownSec.textContent = data.remaining;\n          }\n          break;\n        }\n\n        case 'buzz':\n        case 'buzzer_pressed': {\n          buzzerArea.style.display = 'none';\n          buzzedContainer.style.display = 'flex';\n\n          const winner = (data.winner && (data.winner.playerName || data.winner.name))\n            || data.playerName || data.name || 'Joueur';\n          const isMe = myName && (winner.trim().toLowerCase() === myName.trim().toLowerCase());\n\n          const winnerBadgeTop = document.getElementById('winner-badge-top');\n          const winnerBadgeDot = document.getElementById('winner-badge-dot');\n\n          if (isMe) {\n            if (winnerBadgeTop) {\n              winnerBadgeTop.style.background = 'rgba(239, 68, 68, 0.15)';\n              winnerBadgeTop.style.borderColor = 'rgba(239, 68, 68, 0.4)';\n            }\n            if (winnerBadgeDot) {\n              winnerBadgeDot.style.background = '#ef4444';\n              winnerBadgeDot.style.boxShadow = '0 0 8px #ef4444';\n            }\n            winnerName.style.color = '#ef4444';\n            winnerName.textContent = `${myName.toUpperCase()} (TOI)`;\n            scoringPrompt.style.display = 'block';\n            scoringPrompt.textContent = \"VALIDE TES POINTS :\";\n            scoringGrid.style.display = 'grid';\n          } else {\n            if (winnerBadgeTop) {\n              winnerBadgeTop.style.background = 'rgba(56, 189, 248, 0.15)';\n              winnerBadgeTop.style.borderColor = 'rgba(56, 189, 248, 0.4)';\n            }\n            if (winnerBadgeDot) {\n              winnerBadgeDot.style.background = '#38bdf8';\n              winnerBadgeDot.style.boxShadow = '0 0 8px #38bdf8';\n            }\n            winnerName.style.color = '#38bdf8';\n            winnerName.textContent = `${winner.toUpperCase()}`;\n            scoringPrompt.style.display = 'block';\n            scoringPrompt.textContent = `\ud83d\udc49 C'est ${winner} qui a la main pour r\u00e9pondre !`;\n            scoringGrid.style.display = 'none';\n          }\n\n          const btnSkip = document.getElementById('btn-skip');\n          const btnResume = document.getElementById('btn-resume');\n          if (btnSkip) btnSkip.style.display = isMe ? 'block' : 'none';\n          if (btnResume) btnResume.style.display = isMe ? 'flex' : 'none';\n\n          const rawReaction = data.reactionTime \n            ?? (typeof data.winner === 'object' ? data.winner?.reactionTime : null)\n            ?? (data.winner?.reactionMs ? (data.winner.reactionMs / 1000) : null)\n            ?? (data.reactionMs ? (data.reactionMs / 1000) : null);\n          const finalSec = (rawReaction && Number(rawReaction) > 0.05 && Number(rawReaction) <= 30.0)\n            ? Number(rawReaction).toFixed(2)\n            : '1.50';\n          reactionPill.textContent = `\u26a1 ${finalSec} s`;\n\n          startClientAnswerTimer(isMe, winner);\n          break;\n        }\n\n        case 'score_updated':\n        case 'scores_update':\n        case 'score_submission':\n        case 'submit_score':\n        case 'score': {\n          const sName = (data.playerName || data.name || '').trim();\n          const pts = Number(data.points ?? 0);\n          if (sName) {\n            const isMe = myName && sName.toLowerCase() === myName.toLowerCase();\n            const label = pts === 1.0 ? '+1 PT' : (pts === 0.5 ? '+0,5 PT' : '0 PT');\n            if (isMe) {\n              showToast(`\ud83c\udf89 Tes points sont valid\u00e9s (${label}) !`);\n            } else {\n              showToast(`\ud83d\udc4f ${sName} a marqu\u00e9 ${label} !`);\n            }\n          }\n          break;\n        }\n\n        case 'state':\n        case 'state_update': {\n          if (data.state === 'waiting') {\n            resetToWaitingScreen();\n          } else if (data.state === 'buzzed') {\n            // D\u00e9j\u00e0 g\u00e9r\u00e9 par buzzer_pressed\n          }\n          break;\n        }\n\n        default:\n          break;\n      }\n    }\n\n    buzzerBtn.addEventListener('click', () => {\n      triggerBuzz();\n    });\n    buzzerBtn.addEventListener('touchend', (e) => {\n      e.preventDefault();\n      triggerBuzz();\n    });\n  </script>\n</body>\n</html>\n";
