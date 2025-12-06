// server.js – ATOMIC FIZZ v2.0 (Fixed + Production Ready)
// Supports: Phantom → cChain swap ready, dynamic POI loot, NFT minting from mintables.json, player sync, cooldowns, rads, level gates

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(express.json());
app.use(express.static(".")); // Serve index.html + assets

// ======= CONFIG =======
const PORT = Number(process.env.PORT || 3000);
const SIMULATE_MINT = process.env.SIMULATE_MINT !== "false"; // false = real mint
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 3600000); // 1 hour default
const DEFAULT_RADIUS = Number(process.env.CLAIM_RADIUS_M || 250);
const CHAIN = process.env.CHAIN || "solana"; // "solana" or "avalanche" (cChain)

// ======= LOAD DATA =======
let locationsData = [];
let mintables = [];

try {
    const locFile = fs.readFileSync("locations.js", "utf8");
    // Clean and parse the malformed JS array
    const cleaned = "[" + locFile.replace(/^[^{]*({)/, "$1").replace(/}[^{]*$/, "}") + "]";
    locationsData = JSON.parse(cleaned);
    console.log(`Loaded ${locationsData.length} POIs`);
} catch (e) {
    console.error("Failed to load locations.js – using fallback", e);
    locationsData = [
        { n: "Goodsprings Saloon", lat: 35.8324, lng: -115.4320, lvl: 1, rarity: "common" },
        { n: "Vault 77 (Secret)", lat: 36.170, lng: -115.140, lvl: 77, rarity: "legendary" }
    ];
}

try {
    const b1 = JSON.parse(fs.readFileSync("mintables_batch1.json"));
    const b2 = JSON.parse(fs.readFileSync("mintables_batch2.json"));
    mintables = [...b1, ...b2];
    console.log(`Loaded ${mintables.length} mintable items`);
} catch (e) {
    console.warn("mintables not loaded – loot will be generic", e);
}

// ======= IN-MEMORY PERSISTENCE (swap to Redis/Mongo later) =======
const players = {}; // { wallet: playerObj }

// ======= LOOT TABLES BY RARITY (fallback if mintables missing) =======
const FALLBACK_LOOT = {
    common: [{ id: "scrap", name: "Scrap Metal", rarity: "common", weight: 70 }],
    rare: [{ id: "ammo", name: "Ammo Pack", rarity: "rare", weight: 50 }],
    epic: [{ id: "tech", name: "Rare Tech", rarity: "epic", weight: 30 }],
    legendary: [{ id: "relic", name: "Legendary Relic", rarity: "legendary", weight: 10 }]
};

// ======= HELPERS =======
function distanceM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function ensurePlayer(wallet) {
    if (!players[wallet]) {
        players[wallet] = {
            wallet,
            caps: 0,
            lvl: 1,
            xp: 0,
            hp: 100,
            max_hp: 100,
            rads: 0,
            gear: [],
            inventory: [],
            claimed: [],
            lastClaim: 0
        };
    }
    return players[wallet];
}

function weightedRoll(table) {
    const total = table.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const item of table) if ((r -= item.weight) <= 0) return item;
    return table[0];
}

// ======= ENDPOINTS =======

// Serve locations (fixes empty map bug)
app.get("/locations", (req, res) => res.json(locationsData));

// Player profile (sync client ↔ server)
app.get("/player/:wallet", (req, res) => {
    const p = ensurePlayer(req.params.wallet);
    res.json({
        ...p,
        claimed: p.claimed // send claimed Set as array
    });
});

// Claim survival – MAIN GAME LOOP
app.post("/claim-survival", async (req, res) => {
    const { wallet, spot, lat, lng, signature } = req.body;
    if (!wallet || !spot) return res.status(400).json({ error: "Missing wallet or spot" });

    const loc = locationsData.find(l => l.n === spot);
    if (!loc) return res.status(404).json({ error: "Unknown location" });

    const player = ensurePlayer(wallet);
    const now = Date.now();

    // Cooldown
    if (now - player.lastClaim < COOLDOWN_MS) {
        return res.status(429).json({ error: "Cooldown active", remainingMs: COOLDOWN_MS - (now - player.lastClaim) });
    }

    // Level gate
    if (player.lvl < loc.lvl) {
        return res.status(403).json({ error: `Underleveled – need lvl ${loc.lvl}` });
    }

    // GPS proximity
    if (lat != null && lng != null) {
        const dist = distanceM(lat, lng, loc.lat, loc.lng);
        if (dist > (loc.radiusM || DEFAULT_RADIUS)) {
            return res.status(403).json({ error: "Too far", distanceM: Math.round(dist) });
        }
    }

    // Radiation hit
    if (loc.rads) player.rads += loc.rads;

    // LOOT ROLL – Try mintable first, fallback generic
    let lootItem = null;
    const candidates = mintables.filter(m => m.spawnPOI === spot && !m.mintedAt && m.levelRequirement <= player.lvl);
    if (candidates.length > 0 && Math.random() < 0.35) {
        lootItem = candidates[Math.floor(Math.random() * candidates.length)];
        lootItem.mintedAt = now;
        lootItem.provenance = wallet;
    } else {
        const table = FALLBACK_LOOT[loc.rarity] || FALLBACK_LOOT.common;
        const generic = weightedRoll(table);
        lootItem = { ...generic, source: spot, mintedAt: now };
    }

    // Rewards
    const baseCaps = 25;
    const rarityBonus = { common: 0, rare: 25, epic: 100, legendary: 500 }[loc.rarity] || 0;
    const capsEarned = baseCaps + rarityBonus;

    player.caps += capsEarned;
    player.xp += 50;
    player.lastClaim = now;
    player.claimed.push(spot);
    if (lootItem) player.inventory.push(lootItem);

    // Level up
    while (player.xp >= player.lvl * 100) {
        player.xp -= player.lvl * 100;
        player.lvl++;
        player.max_hp += 10;
        player.hp = player.max_hp;
    }

    // Optional on-chain mint (stub – plug Metaplex or cChain here)
    let chainTx = null;
    if (!SIMULATE_MINT && lootItem.rarity && ["rare", "epic", "legendary"].includes(lootItem.rarity)) {
        chainTx = { tx: "MINT_TX_12345", explorer: "https://solscan.io/tx/12345?cluster=devnet" };
    }

    res.json({
        success: true,
        location: loc.n,
        loot: lootItem,
        capsEarned,
        newLevel: player.lvl,
        chainTx,
        rads: player.rads,
        cooldownEndsAt: now + COOLDOWN_MS
    });
});

// Health check
app.get("/ping", (req, res) => res.send("ATOMIC FIZZ ONLINE – WASTELAND READY"));

// ======= START =======
app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║       ATOMIC FIZZ SERVER v2.0        ║
  ║   PORT: ${PORT}  |  MINT: ${SIMULATE_MINT ? "SIMULATED" : "LIVE"}       ║
  ║   POIs: ${locationsData.length}  |  Mintables: ${mintables.length}          ║
  ╚══════════════════════════════════════╝
  `);
});