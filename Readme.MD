# CRDT Sync Engine

A real-time collaborative document engine built on a **hand-rolled JSON-CRDT**
(no CRDT library) — nested maps and lists that stay conflict-free across
concurrent, possibly-offline clients, synced over raw WebSockets.

This exists to answer a hard distributed-systems question honestly: *when
two people edit the same document at the same time, including one of them
being offline, how do you guarantee everyone ends up with the same result
— and how do you prove it, instead of just hoping?*

## What it actually does

- Any number of clients can edit a shared document concurrently.
- A client can go offline mid-edit, keep working locally, and merge back
  in on reconnect — without losing its own edits or clobbering anyone
  else's.
- Live edits propagate to other connected clients in tens of
  milliseconds.
- Convergence isn't just claimed — it's proven with a test that replays
  the same set of edits in thousands of random orders and asserts every
  replica lands on byte-for-byte the same document.

## Why a CRDT instead of Operational Transformation

OT needs a server that's the single arbiter of operation order, and a
transform function that rewrites concurrent ops against each other so they
still make sense once reordered — famously hard to get right (Google
Wave's team called it one of the hardest parts of their system). It also
assumes a mostly-live, mostly-ordered stream of ops, which fights directly
against "a client can be offline for a while and merge later."

A CRDT sidesteps this by making convergence a property of the data
structure itself: any two replicas that have seen the same set of
operations converge to the same state, *regardless of the order those
operations arrived in*. Offline support falls out for free — a
reconnecting client just replays whatever it has, in whatever order, and
convergence is guaranteed by construction rather than by careful
sequencing.

## Architecture

```
┌─────────────┐         WebSocket          ┌─────────────┐
│  SyncClient │ ◄────────────────────────► │   server.js │
│  (Doc + Doc)│      op / init / join      │ (Doc + log) │
└─────────────┘                            └─────────────┘
       │                                          │
       ▼                                          ▼
   src/crdt.js  ◄──────── same code, no special-casing ────────┘
   (Doc: maps + lists, applied identically
    whether the op is local, remote, live, or replayed
    from a reconnect — there is no separate "merge" step)
```

- **`src/crdt.js`** — the CRDT itself. A `Doc` is a flat registry of nodes
  (maps and lists) addressed by globally-unique ids. Every mutation is an
  op that references stable ids, never array indices or "path from root,"
  so an op replayed hours later in any order still lands correctly.
- **`server.js`** — a thin WebSocket relay. Keeps one authoritative `Doc`
  and a full op log per document room; broadcasts each incoming op to
  every other connected client; on join/reconnect, resends the entire log
  so the joining client can rebuild identical internal state (not just
  today's rendered snapshot).
- **`demo/offline-client.mjs`** — wraps a `Doc` with connect/disconnect
  handling: local edits apply instantly for a responsive feel, transmit
  immediately if online, or queue in an outbox if not. On reconnect, it
  rebuilds from the server's full log, replays its own queued ops on top,
  and only then starts sending live again.
- **`demo/reconnect-scenario.mjs`** — a runnable proof: two clients edit
  concurrently, one disconnects and keeps editing offline, reconnects, and
  the script asserts both clients converge to an identical final state.
- **`demo/reconnect-stress.mjs`** — a harder version: BOTH clients go
  offline simultaneously, each makes several conflicting edits (concurrent
  inserts near the same neighbor, a self-delete, and a genuine tie on a
  shared map key), and only then does either reconnect. See "Proven
  scenarios" below for a full walkthrough of an actual run.
- **`tests/convergence.test.js`** — the formal proof. Builds one trace of
  genuinely concurrent edits from three independent, unsynced clients
  (including a delete racing its own insert, and conflicting writes to the
  same key), then replays that exact op set in many random orders and
  asserts identical output every time.

## Key design decisions (and what breaks without them)

**Lists are ordered by position identifiers (fractional indexing), not
origin-pointer RGA.** An earlier version used the more textbook
origin-pointer approach — insert "after id X." The convergence test itself
caught a real bug in it: two different origin-chains can get ordered
inconsistently depending on application order, a known failure mode
sometimes called the "interleaving anomaly." Position identifiers sidestep
this entirely — final order is just "sort by position string," and sorting
a fixed set of strings is order-independent by definition.

**Deletes are tombstones, never physical removals.** If Alice deletes an
item while Bob, concurrently and offline, inserts something "after" that
same item, Bob's op needs the item to still exist as a valid anchor when
it eventually replays. A tombstone (marked dead, kept in the structure)
guarantees that anchor is always there.

**IDs are `(Lamport counter, site id)` pairs, not random or wall-clock
based.** Two offline clients could otherwise mint colliding ids with no
deterministic way to break the tie — different replicas could resolve the
same conflict differently and diverge permanently with no way to detect
it. This scheme guarantees every replica computes the identical ordering
for the identical set of ops, independent of arrival order.

**Ops that reference a not-yet-existing node are queued, not dropped.**
`Doc.pending` holds them; `drainPending()` retries after a batch (e.g. a
reconnect sync) in case a `create` op was buried later in the batch than
something depending on it. Early on, a list-delete arriving before its
target's insert silently vanished — a real data-loss bug the convergence
test caught on its first run.

**Convergence must be checked with structural equality, never
string/JSON equality.** `toJSON()` builds plain objects by iterating
`Map`s, and `Map` iteration order is insertion order — so two replicas can
be semantically identical but serialize with different key order
depending on op arrival sequence. Comparing via `JSON.stringify` produces
false "divergences" that aren't real bugs; this actually happened during
development of an ad hoc stress test and is worth knowing before you trust
any quick sanity check you write yourself.

## Proven scenarios

These are real runs, not hypotheticals — both were executed against a live
server over actual WebSocket connections.

### Scenario 1: one client offline while the other keeps editing

`npm run demo:reconnect` — Alice stays online and inserts an item while
Bob is disconnected and offline. Bob independently inserts his own item at
the same position, fully offline. Bob reconnects.

```
Alice final state: {"items":["first","alice-added-while-bob-offline","bob-added-while-offline"]}
Bob final state:   {"items":["first","alice-added-while-bob-offline","bob-added-while-offline"]}
Converged: true
```

Both edits survive; neither overwrote the other; both replicas agree on
the final order.

### Scenario 2: both clients offline simultaneously, multiple conflicting edits each

`npm run demo:stress` — a meaningfully harder case. Alice and Bob both go
offline at the same time. Each makes three inserts (several targeting the
*same* neighbor as the other side), Alice deletes one of her own items
while still offline, and both write to the same `meta.title` key — a
direct conflict. Neither has any visibility into the other's edits until
they reconnect.

```
Alice final state: {"items":["seed-item","bob-4-after-a3-unseen-by-bob","bob-2","alice-1","bob-1","alice-3-after-a1","bob-3-after-b1"],"meta":{"title":"Bob's working title"}}
Bob   final state: {"items":["seed-item","bob-4-after-a3-unseen-by-bob","bob-2","alice-1","bob-1","alice-3-after-a1","bob-3-after-b1"],"meta":{"title":"Bob's working title"}}
Converged: true
```

Three specific things this run demonstrates, worth understanding rather
than just screenshotting:

- **Alice's self-delete stuck.** She created and then deleted her own
  `alice-2` item, entirely offline, before ever reconnecting — it's absent
  from the final state on both sides.
- **The `meta.title` conflict was a genuine tie, resolved identically on
  both replicas.** Both sites had made the same number of prior edits
  before writing `title`, so their Lamport counters were equal — an actual
  tie, not just "one op happened first." The tie-break falls back to
  comparing site ids (`"bob" > "alice"`), so Bob's title wins — the same
  way, deterministically, on every replica, with no coordination needed.
- **`bob-4-after-a3-unseen-by-bob` resolved correctly despite Bob never
  having seen `a3` locally.** Bob's insert says "after `a3`" — a node
  created by Alice, offline, that Bob's replica had no knowledge of. This
  works because the op never actually ships "after `a3`" over the wire; it
  ships a **position string** computed once at creation time. Merging is
  just "sort everyone's positions," so no replica ever needs to resolve
  "where is `a3`" — the exact case fractional-indexing exists to handle.

## Known limitations (by design, for a project of this scope)

- The op log and tombstone set both grow unboundedly — no snapshot/compaction.
  A production system would periodically compact both.
- The server resends the *entire* log on every join/reconnect rather than
  a seq-based delta. Simpler and provably correct; not bandwidth-efficient
  at scale.
- No authentication, persistence, or durability — the whole document
  store is in-memory and resets when the server restarts.

## Running it

```bash
npm install

# terminal 1
npm start

# terminal 2
npm test                 
npm run demo:reconnect   
npm run demo:stress      
```

