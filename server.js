const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

const connection = new Connection('https://api.devnet.solana.com');
const CAPS_MINT = new PublicKey('FywSJiYrtgErQwGeySiugRxCNg9xAnzRqmZQr6v2mEt2');

// SIMULATED MINT AUTHORITY (replace with your real keypair later)
const mintAuthority = { publicKey: { toString: () => 'YourMintAuthorityHere' } };

const playerData = new Map();

app.post('/claim-survival', (req, res) => {
    const { wallet, spot } = req.body;

    // Simulate CAPS mint (25 CAPS)
    console.log(`${wallet} looted ${spot}: +25 CAPS`);

    // 35% chance gear drop
    let gearDrop = null;
    const roll = Math.random();
    if (roll < 0.05) gearDrop = { name: 'Power Armor T-51b', rarity: 'legendary', durability: 100 };
    else if (roll < 0.20) gearDrop = { name: 'Service Rifle', rarity: 'rare', durability: 100 };
    else if (roll < 0.35) gearDrop = { name: '10mm Pistol', rarity: 'common', durability: 100 };

    // 10% chance raid
    let raidResult = null;
    if (Math.random() < 0.10) {
        raidResult = simulateRaid(getOrCreatePlayer(wallet));
    }

    const player = getOrCreatePlayer(wallet);
    player.caps += 25;
    if (gearDrop) player.gear.push(gearDrop);
    if (raidResult) {
        player.hp = raidResult.hp;
        player.gear = raidResult.gear;
    }

    res.json({
        success: true,
        caps: 25,
        gear: gearDrop,
        raid: raidResult,
        playerState: { hp: player.hp, gear: player.gear, stimpaks: player.stimpaks },
        explorer: 'https://solscan.io/tx/fake123',
        message: `${spot} LOOTED!`
    });
});

app.post('/buy-stimpak', (req, res) => {
    const { wallet, tier, cost } = req.body;
    const player = getOrCreatePlayer(wallet);

    if (player.caps < cost) {
        return res.json({ success: false, error: 'Not enough CAPS' });
    }

    player.caps -= cost;
    const stimpak = { name: tier === 'rare' ? 'Super Stimpak' : 'Stimpak', tier };
    player.stimpaks.push(stimpak);

    res.json({
        success: true,
        stimpak: stimpak.name,
        cooldown: tier === 'rare' ? '12h' : '24h'
    });
});

app.get('/player/:wallet', (req, res) => {
    const player = getOrCreatePlayer(req.params.wallet);
    res.json(player);
});

// SIMULATE RAID COMBAT
function simulateRaid(player) {
    const enemies = [
        { name: 'Super Mutant', attack: 60, defense: 45 },
        { name: 'Raiders', attack: 35, defense: 25 },
        { name: 'Deathclaw', attack: 120, defense: 90 }
    ];
    const enemy = enemies[Math.floor(Math.random() * enemies.length)];

    let totalDefense = 20;
    player.gear.forEach(g => {
        totalDefense += (g.defense || 10) * (g.durability / 100);
    });

    const damage = Math.max(0, enemy.attack - totalDefense);
    player.hp = Math.max(0, player.hp - damage);

    // Gear damage
    player.gear.forEach(g => {
        g.durability = Math.max(0, g.durability - 25);
    });

    let revived = false;
    if (player.hp <= 0 && player.stimpaks.length > 0) {
        const stimpak = player.stimpaks.shift();
        player.hp = stimpak.tier === 'rare' ? 75 : 50;

        // Repair gear
        player.gear.forEach(g => {
            g.durability = Math.min(100, g.durability + 25);
        });
        revived = true;
    }

    return {
        enemy: enemy.name,
        won: player.hp > 0 && !revived,
        revived,
        hp: player.hp,
        gear: player.gear
    };
}

function getOrCreatePlayer(wallet) {
    if (!playerData.has(wallet)) {
        playerData.set(wallet, {
            caps: 0,
            hp: 100,
            gear: [],
            stimpaks: []
        });
    }
    return playerData.get(wallet);
}

app.listen(process.env.PORT || 3000, () => {
    console.log('?? Atomic Fizz Survival Server LIVE');
});