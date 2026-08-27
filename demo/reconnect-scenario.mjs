import { SyncClient } from './offline-client.mjs';

const URL = 'ws://localhost:8080';
const DOC_ID = 'demo-doc';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const alice = new SyncClient(URL, DOC_ID, 'alice');
  const bob = new SyncClient(URL, DOC_ID, 'bob');
  alice.connect();
  bob.connect();
  await Promise.all([alice.ready(), bob.ready()]); 

  const listOp = alice.createList('root', 'items');
  await wait(150); 
  const i1 = alice.insertListItem(listOp.nodeId, null, 'first');
  await wait(150);

  console.log('--- Bob goes offline mid-session ---');
  bob.simulateGoOffline();
  await wait(50);

  
  alice.insertListItem(listOp.nodeId, i1.id, 'alice-added-while-bob-offline');
  await wait(50);
  bob.insertListItem(listOp.nodeId, i1.id, 'bob-added-while-offline');
  console.log('Bob (offline) local view:', JSON.stringify(bob.snapshot()));

  await wait(50);
  console.log('--- Bob reconnects ---');
  bob.simulateReconnect();
  await bob.ready();
  await wait(300); 

  const aliceState = JSON.stringify(alice.snapshot());
  const bobState = JSON.stringify(bob.snapshot());
  console.log('Alice final state:', aliceState);
  console.log('Bob final state:  ', bobState);
  console.log('Converged:', aliceState === bobState);

  process.exit(0);
}

main();
