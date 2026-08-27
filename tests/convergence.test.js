import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from '../src/crdt.js';

function buildOpTrace() {
  const alice = new Doc('alice');
  const bob = new Doc('bob');
  const carol = new Doc('carol');
  const clients = [alice, bob, carol];
  const ops = [];
  const push = (op) => { ops.push(op); return op; };
  const broadcast = (op, originSite) => {
    for (const c of clients) if (c.clock.site !== originSite) c.apply(op);
  };

  const docNode = push(alice.createMap('root', 'doc'));
  broadcast(docNode, 'alice');
  const todos = push(alice.createList(docNode.nodeId, 'todos'));
  broadcast(todos, 'alice');
  const meta = push(alice.createMap(docNode.nodeId, 'meta'));
  broadcast(meta, 'alice');

  const aliceItem = push(alice.insertListItem(todos.nodeId, null, 'alice: buy milk'));
  const bobItem = push(bob.insertListItem(todos.nodeId, null, 'bob: walk dog'));
  const carolItem = push(carol.insertListItem(todos.nodeId, null, 'carol: file taxes'));

  push(alice.setValue(meta.nodeId, 'title', 'Alice\u2019s List'));
  push(bob.setValue(meta.nodeId, 'title', 'Shared Todos'));

  push(carol.setValue(meta.nodeId, 'owner', 'carol'));
  push(alice.deleteKey(meta.nodeId, 'owner'));

  push(alice.deleteListItem(todos.nodeId, aliceItem.id));
  push(bob.insertListItem(todos.nodeId, bobItem.id, 'bob: buy dog food'));

  const commentNode = push(carol.createMap(null, null));
  push(carol.setValue(commentNode.nodeId, 'label', 'nested note'));
  push(carol.insertListItem(todos.nodeId, carolItem.id, { ref: commentNode.nodeId }));

  return ops.filter(Boolean);
}

function shuffled(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function replay(ops) {
  const doc = new Doc('replica');
  for (const op of ops) doc.apply(op);
  doc.drainPending();
  return doc;
}

test('convergence: same ops, many random orders, identical final state', () => {
  const ops = buildOpTrace();
  assert.ok(ops.length > 5, 'sanity check: trace actually has edits in it');

  const reference = replay(ops);
  const referenceState = reference.toJSON();

  const TRIALS = 30;
  for (let trial = 0; trial < TRIALS; trial++) {
    const replica = replay(shuffled(ops));
    assert.deepEqual(
      replica.toJSON(),
      referenceState,
      `trial ${trial}: replica diverged from reference`
    );
  }
});

test('convergence: pairwise replicas built from independent random orders agree with each other', () => {
  const ops = buildOpTrace();
  const replicaA = replay(shuffled(ops));
  const replicaB = replay(shuffled(ops));
  assert.deepEqual(replicaA.toJSON(), replicaB.toJSON());
});

test('idempotence: re-applying the full op set on top of itself changes nothing', () => {
  const ops = buildOpTrace();
  const doc = replay(ops);
  const before = doc.toJSON();
  for (const op of shuffled(ops)) doc.apply(op);
  doc.drainPending();
  assert.deepEqual(doc.toJSON(), before);
});