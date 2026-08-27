import { WebSocketServer } from 'ws';
import { Doc } from './src/crdt.js';

const PORT = process.env.PORT || 8080;


const rooms = new Map();

function getRoom(docId) {
  if (!rooms.has(docId)) {
    rooms.set(docId, { doc: new Doc('server'), log: [], clients: new Set() });
  }
  return rooms.get(docId);
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  let joinedDocId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      joinedDocId = msg.docId;
      const room = getRoom(joinedDocId);
      room.clients.add(ws);
      
      ws.send(JSON.stringify({ type: 'init', log: room.log }));
      return;
    }

    if (msg.type === 'op' && joinedDocId) {
      const room = getRoom(joinedDocId);
      const serverReceivedAt = Date.now();
      room.doc.apply(msg.op);
      room.doc.drainPending();
      room.log.push(msg.op);
      
      const payload = JSON.stringify({ type: 'op', op: msg.op, serverReceivedAt });
      for (const client of room.clients) {
        if (client !== ws && client.readyState === client.OPEN) client.send(payload);
      }
      return;
    }
  });

  ws.on('close', () => {
    
    if (joinedDocId) getRoom(joinedDocId).clients.delete(ws);
  });
});

console.log(`sync-engine server listening on ws://localhost:${PORT}`);