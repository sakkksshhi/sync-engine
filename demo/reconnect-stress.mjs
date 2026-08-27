import { SyncClient } from './offline-client.mjs';

const URL = 'ws://localhost:8080';
const DOC_ID = 'stress-doc';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const alice = new SyncClient(URL, DOC_ID, 'alice');
  const bob = new SyncClient(URL, DOC_ID, 'bob');
  alice.connect();
  bob.connect();
  await Promise.all([alice.ready(), bob.ready()]);

  
  const listOp = alice.createList('root', 'items');
  const metaOp = alice.createMap('root', 'meta');
  await wait(200); 
  const seed = alice.insertListItem(listOp.nodeId, null, 'seed-item');
  await wait(200);

  console.log('--- Both Alice and Bob go offline ---');
  alice.simulateGoOffline();
  bob.simulateGoOffline();
  await wait(50);

  
  const a1 = alice.insertListItem(listOp.nodeId, seed.id, 'alice-1');
  const a2 = alice.insertListItem(listOp.nodeId, seed.id, 'alice-2');
  const a3 = alice.insertListItem(listOp.nodeId, a1.id, 'alice-3-after-a1');
  alice.setValue(metaOp.nodeId, 'title', 'Alice\u2019s working title');
  alice.deleteListItem(listOp.nodeId, a2.id); // alice deletes her OWN item, still offline

  const b1 = bob.insertListItem(listOp.nodeId, seed.id, 'bob-1');
  const b2 = bob.insertListItem(listOp.nodeId, seed.id, 'bob-2');
  bob.insertListItem(listOp.nodeId, b1.id, 'bob-3-after-b1');
  bob.setValue(metaOp.nodeId, 'title', 'Bob\u2019s working title');
  bob.insertListItem(listOp.nodeId, a3.id, 'bob-4-after-a3-unseen-by-bob');

  console.log('Alice (offline) local view:', JSON.stringify(alice.snapshot()));
  console.log('Bob   (offline) local view:', JSON.stringify(bob.snapshot()));

  await wait(50);
  console.log('--- Alice reconnects first ---');
  alice.simulateReconnect();
  await alice.ready();
  await wait(200);

  console.log('--- Bob reconnects ---');
  bob.simulateReconnect();
  await bob.ready();
  await wait(400); 
  await wait(200); 

  const aliceState = JSON.stringify(alice.snapshot());
  const bobState = JSON.stringify(bob.snapshot());
  console.log('\nAlice final state:', aliceState);
  console.log('Bob   final state:', bobState);
  console.log('\nConverged:', aliceState === bobState);
  console.log('Alice item count (excluding tombstoned):', alice.snapshot().items.length);
  console.log('Bob   item count (excluding tombstoned):', bob.snapshot().items.length);

  process.exit(0);
}

main();
