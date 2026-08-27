import { WebSocket } from 'ws';
import { Doc } from '../src/crdt.js';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const DOC_ID = 'demo-doc';

function makeClient(site) {
  const doc = new Doc(site);
  const ws = new WebSocket(SERVER_URL);
  const sentAt = new Map(); 

  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', docId: DOC_ID })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'init') {
        for (const op of msg.log) doc.apply(op);
        doc.drainPending();
        resolve();
      } else if (msg.type === 'op') {
        doc.apply(msg.op);
        doc.drainPending();
        console.log(`[${site}] <- received a remote edit, now sees: ${JSON.stringify(doc.toJSON())}`);
      }
    });
  });

  function send(op) {
    ws.send(JSON.stringify({ type: 'op', docId: DOC_ID, op }));
  }

  return { site, doc, ws, ready, send };
}

const alice = makeClient('alice');
const bob = makeClient('bob');
await Promise.all([alice.ready, bob.ready]);
console.log('Both clients joined and caught up on doc history.\n');

const docNode = alice.doc.createMap('root', 'doc');
alice.send(docNode);
const todos = alice.doc.createList(docNode.nodeId, 'todos');
alice.send(todos);

await new Promise((r) => setTimeout(r, 200));

console.log('--- concurrent edit + latency measurement ---');
const t0 = Date.now();
const op = alice.doc.insertListItem(todos.nodeId, null, 'alice: buy milk');
alice.send(op);

await new Promise((resolve) => {
  const check = setInterval(() => {
    if (JSON.stringify(bob.doc.toJSON()) === JSON.stringify(alice.doc.toJSON())) {
      clearInterval(check);
      resolve();
    }
  }, 5);
});
console.log(`Propagation latency (alice edit -> bob sees it): ${Date.now() - t0}ms`);

const op2 = bob.doc.insertListItem(todos.nodeId, null, 'bob: walk dog');
bob.send(op2);
await new Promise((r) => setTimeout(r, 300));

console.log('\nFinal state:');
console.log('alice sees:', JSON.stringify(alice.doc.toJSON()));
console.log('bob sees:  ', JSON.stringify(bob.doc.toJSON()));
console.log('Converged:', JSON.stringify(alice.doc.toJSON()) === JSON.stringify(bob.doc.toJSON()));

alice.ws.close();
bob.ws.close();
