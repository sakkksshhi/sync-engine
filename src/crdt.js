export class LamportClock {
  constructor(site) {
    this.site = site;
    this.counter = 0;
  }
  tick() {
    this.counter += 1;
    return { counter: this.counter, site: this.site };
  }
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
const nodeKey = (id) => `${id.counter}:${id.site}`;
const TOMBSTONE = Symbol('deleted');

const BASE = 36;
function digitAt(str, i) { return i < str.length ? parseInt(str[i], BASE) : 0; }
function between(lo, hi) {
  let result = '';
  let i = 0;
  for (;;) {
    const loDigit = digitAt(lo, i);
    const hiDigit = hi === null ? BASE : digitAt(hi, i);
    if (hiDigit - loDigit > 1) {
      const mid = loDigit + Math.floor((hiDigit - loDigit) / 2);
      return result + mid.toString(BASE);
    }
    result += loDigit.toString(BASE); r
    i += 1;
  }
}
function comparePosId(posA, idA, posB, idB) {
  if (posA < posB) return -1;
  if (posA > posB) return 1;
  return compareId(idA, idB);
}

export class Doc {
  constructor(site) {
    this.clock = new LamportClock(site);
    this.nodes = new Map();
    this.nodes.set('root', { type: 'map', entries: new Map() });
    this.pending = [];
  }

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

  insertListItem(listNodeId, afterId, value) {
    const node = this.nodes.get(listNodeId);
    let leftPos = '';
    let rightPos = null;
    if (node) {
      if (afterId === null) {
        rightPos = node.elements.length ? node.elements[0].pos : null;
      } else {
        const idx = node.elements.findIndex((e) => idEq(e.id, afterId));
        if (idx !== -1) {
          leftPos = node.elements[idx].pos;
          rightPos = idx + 1 < node.elements.length ? node.elements[idx + 1].pos : null;
        }
      }
    }
    const id = this.clock.tick();
    const pos = between(leftPos, rightPos);
    const op = { kind: 'list_insert', nodeId: listNodeId, id, pos, value };
    this.apply(op);
    return op;
  }

  deleteListItem(listNodeId, id) {
    const op = { kind: 'list_delete', nodeId: listNodeId, id };
    this.apply(op);
    return op;
  }

  apply(op) {
    this.clock.observe(op.ts || op.id);

    if (op.kind === 'create') {
      if (!this.nodes.has(op.nodeId)) {
        this.nodes.set(op.nodeId,
          op.nodeType === 'map' ? { type: 'map', entries: new Map() }
                                 : { type: 'list', elements: [] });
      }
      if (op.parentNodeId == null) return;
      return this._mapSetRaw(op.parentNodeId, op.key, { ref: op.nodeId }, op.ts);
    }
    if (op.kind === 'map_set') return this._mapSetRaw(op.nodeId, op.key, op.value, op.ts);
    if (op.kind === 'map_delete') return this._mapSetRaw(op.nodeId, op.key, TOMBSTONE, op.ts);
    if (op.kind === 'list_insert') return this._listInsertRaw(op.nodeId, op.id, op.pos, op.value);
    if (op.kind === 'list_delete') {
      const node = this.nodes.get(op.nodeId);
      if (!node) { this.pending.push(op); return; }
      const el = node.elements.find((e) => idEq(e.id, op.id));
      if (!el) { this.pending.push(op); return; }
      el.tombstone = true; 
      return;
    }
  }

  _mapSetRaw(nodeId, key, value, ts) {
    const node = this.nodes.get(nodeId);
    if (!node) { this.pending.push({ kind: 'map_set', nodeId, key, value, ts }); return; }
    const existing = node.entries.get(key);
    if (!existing || compareId(ts, existing.ts) > 0) {
      node.entries.set(key, { value, ts });
    }
    
  }

  
  _listInsertRaw(nodeId, id, pos, value) {
    const node = this.nodes.get(nodeId);
    if (!node) { this.pending.push({ kind: 'list_insert', nodeId, id, pos, value }); return; }
    if (node.elements.some((e) => idEq(e.id, id))) return; // idempotent replay

    let at = node.elements.findIndex((e) => comparePosId(pos, id, e.pos, e.id) < 0);
    if (at === -1) at = node.elements.length;
    node.elements.splice(at, 0, { id, pos, value, tombstone: false });
  }

  drainPending() {
    let progressed = true;
    while (progressed && this.pending.length) {
      progressed = false;
      const stillPending = [];
      for (const op of this.pending) {
        const before = this.pending.length;
        this.apply(op);
        if (this.pending.length <= before) progressed = true;
        else stillPending.push(op);
      }
      this.pending = stillPending;
    }
  }

  
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