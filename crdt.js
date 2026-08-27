export class LamportClock {
  constructor(site) {
    this.site = site;
    this.counter = 0;
  }
  tick() {
    this.counter += 1;
    return { counter: this.counter, site: this.site };
  }
  // Call whenever a remote op arrives, so our clock never mints an id that
  // could collide with (or sort behind) one we've already seen.
  observe(remoteId) {
    if (remoteId) this.counter = Math.max(this.counter, remoteId.counter);
  }
}

export function compareId(a, b) {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.site < b.site) return -1;
  if (a.site > b.site) return 1;
  return 0;
}
const idEq = (a, b) => !!a && !!b && a.counter === b.counter && a.site === b.site;
const sameOrigin = (a, b) => (a === null || b === null ? a === b : idEq(a, b));
const nodeKey = (id) => `${id.counter}:${id.site}`;
const TOMBSTONE = Symbol('deleted');

// ---------------------------------------------------------------------------
// 2. The document
// ---------------------------------------------------------------------------
export class Doc {
  constructor(site) {
    this.clock = new LamportClock(site);
    this.nodes = new Map();
    this.nodes.set('root', { type: 'map', entries: new Map() });
    // Ops we couldn't apply yet because their parent node doesn't exist
    // locally. See the note on causal ordering at the bottom of the file --
    // this is the seed of what "reconnect mid-edit without data loss" needs.
    this.pending = [];
  }

  // -- local mutation helpers ------------------------------------------
  // Each of these (a) mints a fresh op with a fresh id, (b) applies it
  // locally immediately (so the local user sees their own edit instantly),
  // and (c) returns the op so the caller can broadcast it to other replicas.
  createMap(parentNodeId, key) {
    const ts = this.clock.tick();
    const op = { kind: 'create', nodeType: 'map', nodeId: nodeKey(ts), parentNodeId, key, ts };
    this.apply(op);
    return op;
  }

  createList(parentNodeId, key) {
    const ts = this.clock.tick();
    const op = { kind: 'create', nodeType: 'list', nodeId: nodeKey(ts), parentNodeId, key, ts };
    this.apply(op);
    return op;
  }

  setValue(mapNodeId, key, value) {
    const ts = this.clock.tick();
    const op = { kind: 'map_set', nodeId: mapNodeId, key, value, ts };
    this.apply(op);
    return op;
  }

  deleteKey(mapNodeId, key) {
    const ts = this.clock.tick();
    const op = { kind: 'map_delete', nodeId: mapNodeId, key, ts };
    this.apply(op);
    return op;
  }

  insertListItem(listNodeId, afterId /* null = insert at head */, value) {
    const id = this.clock.tick();
    const op = { kind: 'list_insert', nodeId: listNodeId, id, afterId, value };
    this.apply(op);
    return op;
  }

  deleteListItem(listNodeId, id) {
    const op = { kind: 'list_delete', nodeId: listNodeId, id };
    this.apply(op);
    return op;
  }

  // -- applying an op -----------------------------------------------------
  // Whether the op is local, remote, arriving in order, or replayed late
  // after a reconnect: SAME code path. That's the whole point of a CRDT --
  // there's no separate "merge" step, just apply().
  apply(op) {
    this.clock.observe(op.ts || op.id);

    if (op.kind === 'create') {
      if (!this.nodes.has(op.nodeId)) {
        this.nodes.set(op.nodeId,
          op.nodeType === 'map' ? { type: 'map', entries: new Map() }
                                 : { type: 'list', elements: [] });
      }
      return this._mapSetRaw(op.parentNodeId, op.key, { ref: op.nodeId }, op.ts);
    }
    if (op.kind === 'map_set') return this._mapSetRaw(op.nodeId, op.key, op.value, op.ts);
    if (op.kind === 'map_delete') return this._mapSetRaw(op.nodeId, op.key, TOMBSTONE, op.ts);
    if (op.kind === 'list_insert') return this._listInsertRaw(op.nodeId, op.id, op.afterId, op.value);
    if (op.kind === 'list_delete') {
      const node = this.nodes.get(op.nodeId);
      if (!node) { this.pending.push(op); return; }
      const el = node.elements.find((e) => idEq(e.id, op.id));
      if (el) el.tombstone = true; // idempotent: fine if already tombstoned
      return;
    }
  }

  // -- LWW-register semantics per map key ---------------------------------
  // WHAT BREAKS WITHOUT THIS: concurrent writes to the SAME key are a real
  // conflict (two people renamed the same field differently) and someone's
  // intent has to lose. Comparing Lamport ids makes that loss deterministic
  // and IDENTICAL on every replica. If we used wall-clock time instead,
  // clock skew between machines could make replica A pick a different
  // winner than replica B -- silent, permanent divergence.
  _mapSetRaw(nodeId, key, value, ts) {
    const node = this.nodes.get(nodeId);
    if (!node) { this.pending.push({ kind: 'map_set', nodeId, key, value, ts }); return; }
    const existing = node.entries.get(key);
    if (!existing || compareId(ts, existing.ts) > 0) {
      node.entries.set(key, { value, ts });
    }
    // If the existing entry has a strictly greater ts, this write simply
    // loses -- the same way, on every replica. That's the guarantee.
  }

  // -- RGA insert for lists ------------------------------------------------
  // WHAT BREAKS WITHOUT TOMBSTONES: if Alice deletes element X while Bob,
  // concurrently and offline, inserts a new item "after X", Bob's op is
  // only meaningful if X still exists to anchor to. Physically removing X
  // would leave Bob's insert with nowhere valid to attach once he
  // reconnects. A dead-but-present tombstone keeps X as a permanent anchor.
  _listInsertRaw(nodeId, id, afterId, value) {
    const node = this.nodes.get(nodeId);
    if (!node) { this.pending.push({ kind: 'list_insert', nodeId, id, afterId, value }); return; }
    if (node.elements.some((e) => idEq(e.id, id))) return; // idempotent replay

    let at = afterId === null ? 0 : node.elements.findIndex((e) => idEq(e.id, afterId)) + 1;
    if (afterId !== null && at === 0) { this.pending.push({ kind: 'list_insert', nodeId, id, afterId, value }); return; }

    // Classic RGA tie-break: if other elements were ALSO inserted right
    // after the same origin (a concurrent insert at the same spot), skip
    // past any with a HIGHER id. This keeps insertion order consistent no
    // matter which replica applies the ops in which order.
    while (at < node.elements.length
      && sameOrigin(node.elements[at].afterId, afterId)
      && compareId(node.elements[at].id, id) > 0) {
      at++;
    }
    node.elements.splice(at, 0, { id, afterId, value, tombstone: false });
  }

  // Retry ops that arrived before the node they target existed locally.
  // Call this after applying a batch of remote ops (e.g. after a reconnect
  // sync) in case a "create" op was buried later in the batch than a child
  // op that depends on it.
  drainPending() {
    let progressed = true;
    while (progressed && this.pending.length) {
      progressed = false;
      const stillPending = [];
      for (const op of this.pending) {
        const before = this.pending.length;
        this.apply(op);
        // crude progress check: did applying it avoid re-queueing itself?
        if (this.pending.length <= before) progressed = true;
        else stillPending.push(op);
      }
      this.pending = stillPending;
    }
  }

  // -- read helpers: materialize the CRDT tree into a plain JS value -----
  toJSON(nodeId = 'root') {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    if (node.type === 'map') {
      const out = {};
      for (const [key, entry] of node.entries) {
        if (entry.value === TOMBSTONE) continue;
        out[key] = entry.value && entry.value.ref ? this.toJSON(entry.value.ref) : entry.value;
      }
      return out;
    }
    return node.elements
      .filter((e) => !e.tombstone)
      .map((e) => (e.value && e.value.ref ? this.toJSON(e.value.ref) : e.value));
  }
}