const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { 
  getOrCreateAssociatedTokenAccount, 
  mintTo,
  createBurnInstruction 
} = require('@solana/spl-token');
const { Metaplex, keypairIdentity, bundlrStorage } = require("@metaplex-foundation/js");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ──────────────────────────────────────
// CONFIG — UPDATE THESE 3 LINES ONLY
// ──────────────────────────────────────
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
// const connection = new Connection('https://api.devnet.solana.com'); // ← switch for testing

const CAPS_MINT = new PublicKey('FywSJiYrtgErQwGeySiugRxCNg9xAnzRqmZQr6v2mEt2'); // Your $CAPS token
const GEAR_COLLECTION = new PublicKey('YOUR_GEAR_COLLECTION_ADDRESS');
const STIMPAK_COLLECTION = new PublicKey('YOUR_STIMPAK_COLLECTION_ADDRESS');

// YOUR MINT AUTHORITY (NEVER COMMIT THIS TO GITHUB!)
const mintAuthority = Keypair.fromSecretKey(Uint8Array.from([
  // ←←←←← PUT YOUR 64-BYTE SECRET KEY ARRAY HERE ←←←←←
]));

const metaplex = Metaplex.make(connection)
  .use(keypairIdentity(mintAuthority))
  .use(bundlrStorage());

// In-memory DB (replace with Redis/MongoDB later)
const playerData = new Map();

// ──────────────────────────────────────
// 1. SERVE ALL 300+ LOCATIONS
// ──────────────────────────────────────
app.get('/locations', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'locations.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'locations.json not found — create it!' });
    }
    const locations = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(locations);
  } catch (err) {
    console.error('Locations load error:', err);
    res.status(500).json({ error: 'Failed to load locations' });
  }
});

// ──────────────────────────────────────
// 2. GET PLAYER DATA
// ──────────────────────────────────────
app.get('/player/:wallet', (req, res) => {
  const player = playerData.get(req.params.wallet) || {
    caps: 0, xp: 0, hp: 100, gear: [], stimpaks: [], claimedSpots: 0, raidsWon: 0, quests: {}
  };
  res.json(player);
});

// ──────────────────────────────────────
// 3. CLAIM SPOT → MINT CAPS + XP + GEAR + RAID
// ──────────────────────────────────────
app.post('/claim-survival', async (req, res) => {
  try {
    const { wallet, spot } = req.body;
    const walletPubkey = new PublicKey(wallet);
    const player = playerData.get(wallet) || { caps:0, xp:0, hp:100, gear:[], stimpaks:[], claimedSpots:0, raidsWon:0, quests:{} };

    // Mint 25 CAPS
    const ata = await getOrCreateAssociatedTokenAccount(connection, mintAuthority, CAPS_MINT, walletPubkey);
    const txSig = await mintTo(connection, mintAuthority, CAPS_MINT, ata.address, mintAuthority.publicKey, 25 * 1_000_000_000);
    
    player.caps += 25;
    player.xp += 100; // base XP (you can make this dynamic per spot later)

    // Random gear drop (20% chance)
    let gearDrop = null;
    const roll = Math.random();
    if (roll < 0.05) gearDrop = await mintGear(walletPubkey, "Power Armor T-51b", "legendary");
    else if (roll < 0.20) gearDrop = await mintGear(walletPubkey, "Service Rifle", "rare");
    else if (roll < 0.35) gearDrop = await mintGear(walletPubkey, "10mm Pistol", "common");
    if (gearDrop) player.gear.push(gearDrop);

    // 5% raid chance on dangerous spots
    let raidResult = null;
    const dangerSpots = ['Hoover Dam', 'Black Mountain', 'Lucky 38', 'REPCONN HQ'];
    if (dangerSpots.includes(spot) && Math.random() < 0.05) {
      raidResult = await triggerRaid(wallet);
      if (raidResult.won) player.raidsWon++;
    }

    playerData.set(wallet, player);

    res.json({
      success: true,
      caps: 25,
      xp: 100,
      gear: gearDrop,
      raid: raidResult,
      explorer: `https://solscan.io/tx/${txSig}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Claim failed' });
  }
});

// ──────────────────────────────────────
// 4. BUY STIMPAK
// ──────────────────────────────────────
app.post('/buy-stimpak', async (req, res) => {
  try {
    const { wallet, tier, cost } = req.body;
    const player = playerData.get(wallet);
    if (!player || player.caps < cost) return res.status(400).json({ error: 'Not enough CAPS' });

    player.caps -= cost;
    const stimpak = await mintStimpak(new PublicKey(wallet), tier);
    player.stimpaks.push(stimpak);
    playerData.set(wallet, player);

    res.json({ success: true, stimpak: stimpak.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// 5. CLAIM QUEST XP
// ──────────────────────────────────────
app.post('/claim-quest', async (req, res) => {
  try {
    const { wallet, questId, xp } = req.body;
    const player = playerData.get(wallet);
    if (!player || player.quests[questId]) return res.status(400).json({ error: 'Already claimed' });

    player.xp += xp;
    player.quests[questId] = true;
    playerData.set(wallet, player);
    res.json({ success: true, xp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────
// HELPER: MINT GEAR NFT
// ──────────────────────────────────────
async function mintGear(toWallet, name, rarity) {
  const { nft } = await metaplex.nfts().create({
    uri: `https://atomicfizzcaps.xyz/metadata/gear/${rarity}/${name.toLowerCase().replace(/\s/g, '-')}.json`,
    name: `${name} • ${rarity.toUpperCase()}`,
    symbol: "FIZZ",
    sellerFeeBasisPoints: 500,
    collection: GEAR_COLLECTION,
    creators: [{ address: mintAuthority.publicKey, share: 100 }],
    isMutable: true
  });

  await metaplex.nfts().update({ nftOrSft: nft, owner: toWallet });

  return { id: nft.address.toString(), name, rarity };
}

// ──────────────────────────────────────
// HELPER: MINT STIMPAK NFT
// ──────────────────────────────────────
async function mintStimpak(toWallet, tier) {
  const names = { common: "Stimpak", rare: "Super Stimpak", legendary: "Med-X + Stimpak" };
  const { nft } = await metaplex.nfts().create({
    uri: `https://atomicfizzcaps.xyz/metadata/stimpak/${tier}.json`,
    name: names[tier],
    symbol: "FIZZ",
    sellerFeeBasisPoints: 500,
    collection: STIMPAK_COLLECTION
  });
  await metaplex.nfts().update({ nftOrSft: nft, owner: toWallet });
  return { id: nft.address.toString(), name: names[tier], tier };
}

// ──────────────────────────────────────
// HELPER: RAID LOGIC
// ──────────────────────────────────────
async function triggerRaid(wallet) {
  const player = playerData.get(wallet);
  const enemies = [
    { name: "Deathclaw", hp: 300, attack: 120 },
    { name: "Super Mutant Behemoth", hp: 250, attack: 90 },
    { name: "Raider Gang", hp: 150, attack: 60 }
  ];
  const enemy = enemies[Math.floor(Math.random() * enemies.length)];
  const damage = Math.max(10, enemy.attack - (player.gear.reduce((a,g) => a + (g.defense||0), 20)));
  player.hp = Math.max(0, player.hp - damage);

  return { enemy: enemy.name, won: player.hp > 0, hp: player.hp };
}

// ──────────────────────────────────────
// START SERVER
// ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ATOMIC FIZZ BACKEND LIVE ON PORT ${PORT}`);
  console.log(`→ http://localhost:${PORT}/locations ← your 300+ spots`);
  console.log(`War never changes... but your backend just did.`);
});

