import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = 3001;
//const PEER_URL = "http://192.168.6.224:5051"; // your Python aiortc local URL

// Middleware
app.use(cors());
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

/** ---------------- IN-MEMORY MAILBOXES ---------------- **/
const waiters = new Map();         // streamId -> { resolve, timer }
const offers = new Map();          // streamId -> offer {sdp,type}
const clientIceQ = new Map();      // streamId -> [candidates]

const pubOffers = new Map();       // cam3 publisher offers
const pubClientIceQ = new Map();   // cam3 publisher ICE

function qGet(map, id) {
  if (!map.has(id)) map.set(id, []);
  return map.get(id);
}

/** ---------------- HEALTH ---------------- **/
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/** ---------------- VIEWER: OFFER ---------------- **/
app.post('/offer/:id', async (req, res) => {
  const streamId = req.params.id;
  const { sdp, type } = req.body;
  console.log(`Received offer for stream ${streamId}`);

  // store offer for backend puller
  offers.set(streamId, { sdp, type });
  const waiter = waiters.get(streamId);
  if (waiter) {
    waiter.resolve({ sdp, type });
    clearTimeout(waiter.timer);
    waiters.delete(streamId);
  }

  try {
    // Wait up to 25s for backend answer
    const answer = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for backend answer")), 25000);
      const key = `__answer_${streamId}`;
      app.set(key, { resolve: (a) => { clearTimeout(t); resolve(a); }, timer: t });
    });

    console.log(`Got backend answer for stream ${streamId}`);
    return res.json(answer);
  } catch (e) {
    console.warn(`Backend answer timeout for ${streamId}, falling back: ${e.message}`);
    // fallback: forward directly to aiortc
  
  }
});

/** ---------------- VIEWER: ICE ---------------- **/
app.post('/ice-candidate/:id', async (req, res) => {
  const streamId = req.params.id;
  const candidate = req.body;
  console.log(`Received ICE candidate for stream ${streamId}`);

  // enqueue for backend puller
  qGet(clientIceQ, streamId).push(candidate);

  
  res.json({ status: "queued" });
});

/** ---------------- PUBLISHER (cam3 only) ---------------- **/
// app.post("/publish/offer/:id", async (req, res) => {
//   const id = req.params.id;
//   if (id !== "cam3") return res.status(400).json({ error: "only cam3 can publish" });
//   try {
//     pubOffers.set(id, req.body); // store for backend puller
//     const r = await fetch(`${PEER_URL}/client-offer/${id}`, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(req.body),
//     });
//     const data = await r.json();
//     if (!r.ok) throw new Error(JSON.stringify(data));
//     res.json(data);
//   } catch (e) {
//     console.error(`publish/offer/${id} error`, e.message);
//     res.status(500).json({ error: "failed", details: e.message });
//   }
// });

// app.post("/publish/ice-candidate/:id", async (req, res) => {
//   const id = req.params.id;
//   if (id !== "cam3") return res.status(400).json({ error: "only cam3 can publish" });
//   try {
//     qGet(pubClientIceQ, id).push(req.body); // store for backend puller
//     const r = await fetch(`${PEER_URL}/client-ice/${id}`, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(req.body),
//     });
//     const data = await r.json();
//     if (!r.ok) throw new Error(JSON.stringify(data));
//     res.json(data);
//   } catch (e) {
//     console.error(`publish/ice-candidate/${id} error`, e.message);
//     res.status(500).json({ error: "failed", details: e.message });
//   }
// });

/** ---------------- BACKEND-ONLY (for aiortc client) ---------------- **/

// aiortc pulls next offer (long-poll)
app.get("/backend/wait-offer/:id", async (req, res) => {
  const id = req.params.id;
  const off = offers.get(id);
  if (off) return res.json(off);
  await new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(id); resolve(); }, 25000);
    waiters.set(id, { resolve: (o) => res.json(o), timer });
  });
  if (!res.headersSent) res.json(null);
});

// aiortc posts its answer
app.post("/backend/answer/:id", (req, res) => {
  const id = req.params.id;
  const answer = req.body;
  const key = `__answer_${id}`;
  const hook = app.get(key);
  if (hook) {
    hook.resolve(answer);
    clearTimeout(hook.timer);
    app.set(key, undefined);
  }
  offers.delete(id);
  res.json({ status: "ok" });
});

// aiortc pulls ICE from client
app.get("/backend/wait-ice/:id", (req, res) => {
  const id = req.params.id;
  const q = qGet(clientIceQ, id);
  if (q.length) return res.json(q.shift());
  return res.json(null);
});

// aiortc pulls publisher cam3 offer
app.get("/backend/publish/wait-offer/:id", (req, res) => {
  const id = req.params.id;
  const off = pubOffers.get(id);
  pubOffers.delete(id);
  res.json(off || null);
});

// aiortc pulls publisher cam3 ICE
app.get("/backend/publish/wait-ice/:id", (req, res) => {
  const id = req.params.id;
  const q = qGet(pubClientIceQ, id);
  if (q.length) return res.json(q.shift());
  return res.json(null);
});

/** ---------------- START ---------------- **/
app.listen(PORT, () => {
  console.log(`WebRTC signaling server running on port ${PORT}`);
//   console.log(`PEER_URL fallback: ${PEER_URL}`);
});
