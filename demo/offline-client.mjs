import WebSocket from 'ws';
import { Doc } from '../src/crdt.js';

export class SyncClient {
  constructor(url, docId, siteId) {
    this.url = url;
    this.docId = docId;
    this.siteId = siteId;
    this.doc = new Doc(siteId);
    this.outbox = [];
    this.connected = false;
    this.ws = null;
    this._readyResolvers = [];
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.ws.send(JSON.stringify({ type: 'join', docId: this.docId }));
    });

    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);

      if (msg.type === 'init') {
        const freshDoc = new Doc(this.siteId);
        for (const op of msg.log) freshDoc.apply(op);
        freshDoc.drainPending(); 
        for (const op of this.outbox) freshDoc.apply(op);
        freshDoc.drainPending();

        this.doc = freshDoc;
        this._flushOutboxToWire();
        this._resolveReady();
        return;
      }

      if (msg.type === 'op') {
        this.doc.apply(msg.op);
        this.doc.drainPending();
      }
    });

    this.ws.on('close', () => {
      this.connected = false; 
    });
  }

  
  ready() {
    return new Promise((resolve) => {
      if (this._isReady) resolve();
      else this._readyResolvers.push(resolve);
    });
  }
  _resolveReady() {
    this._isReady = true;
    for (const r of this._readyResolvers) r();
    this._readyResolvers = [];
  }

  
  createMap(parentNodeId, key)               { return this._local(this.doc.createMap(parentNodeId, key)); }
  createList(parentNodeId, key)              { return this._local(this.doc.createList(parentNodeId, key)); }
  setValue(mapNodeId, key, value)            { return this._local(this.doc.setValue(mapNodeId, key, value)); }
  deleteKey(mapNodeId, key)                  { return this._local(this.doc.deleteKey(mapNodeId, key)); }
  insertListItem(listNodeId, afterId, value) { return this._local(this.doc.insertListItem(listNodeId, afterId, value)); }
  deleteListItem(listNodeId, id)             { return this._local(this.doc.deleteListItem(listNodeId, id)); }

  _local(op) {
    this.outbox.push(op);
    if (this.connected && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'op', docId: this.docId, op }));
    }
    return op;
  }

  _flushOutboxToWire() {
    for (const op of this.outbox) {
      this.ws.send(JSON.stringify({ type: 'op', docId: this.docId, op }));
    }
  }

  simulateGoOffline() {
    this._isReady = false;
    this.ws.close();
  }

  simulateReconnect() {
    this.connect();
  }

  snapshot() {
    return this.doc.toJSON();
  }
}
