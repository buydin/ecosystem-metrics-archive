const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'db');

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR);
}

// Ensure the tables exist in the target DB
function initDailyDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run('PRAGMA journal_mode = WAL;');
        
        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS metrics_minute (
                    map_code TEXT,
                    timestamp TEXT,
                    peak_ccu INTEGER,
                    favorites INTEGER,
                    minutes_played INTEGER,
                    recommendations INTEGER,
                    plays INTEGER,
                    unique_players INTEGER,
                    UNIQUE(map_code, timestamp)
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS metrics_hour (
                    map_code TEXT,
                    timestamp TEXT,
                    peak_ccu INTEGER,
                    favorites INTEGER,
                    minutes_played INTEGER,
                    average_minutes_per_player REAL,
                    recommendations INTEGER,
                    plays INTEGER,
                    unique_players INTEGER,
                    rankings TEXT,
                    UNIQUE(map_code, timestamp)
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS metrics_day (
                    map_code TEXT,
                    timestamp TEXT,
                    peak_ccu INTEGER,
                    favorites INTEGER,
                    minutes_played INTEGER,
                    average_minutes_per_player REAL,
                    recommendations INTEGER,
                    plays INTEGER,
                    unique_players INTEGER,
                    retention_d1 REAL,
                    retention_d7 REAL,
                    rankings TEXT,
                    UNIQUE(map_code, timestamp)
                )
            `, (err) => {
                if (err) reject(err);
                else {
                    db.close();
                    resolve();
                }
            });
        });
    });
}

function runQuery(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function mergeShards() {
    const shardsDir = path.join(__dirname, 'shards');
    if (!fs.existsSync(shardsDir)) {
        console.log("No shards directory found.");
        return;
    }
    
    // Find all metrics databases across all shard folders
    const allFiles = [];
    const shardFolders = fs.readdirSync(shardsDir);
    for (const folder of shardFolders) {
        const folderPath = path.join(shardsDir, folder);
        if (fs.statSync(folderPath).isDirectory()) {
            const dbFiles = fs.readdirSync(folderPath).filter(f => f.startsWith('metrics_') && f.endsWith('.db'));
            for (const f of dbFiles) {
                allFiles.push({ dateStr: f.replace('metrics_', '').replace('.db', ''), fullPath: path.join(folderPath, f) });
            }
        }
    }
    
    if (allFiles.length === 0) {
        console.log("No metrics databases found in shards.");
        return;
    }
    
    // Group files by date
    const dbByDate = {};
    for (const f of allFiles) {
        if (!dbByDate[f.dateStr]) dbByDate[f.dateStr] = [];
        dbByDate[f.dateStr].push(f.fullPath);
    }
    
    console.log(`Found databases for ${Object.keys(dbByDate).length} different days.`);
    
    for (const dateStr of Object.keys(dbByDate)) {
        console.log(`\n=== Merging Day: ${dateStr} ===`);
        const targetDbPath = path.join(DB_DIR, `metrics_${dateStr}.db`);
        await initDailyDb(targetDbPath);
        const targetDb = new sqlite3.Database(targetDbPath);
        
        const shardPaths = dbByDate[dateStr];
        console.log(`Found ${shardPaths.length} shards for ${dateStr}.`);
        
        for (let i = 0; i < shardPaths.length; i++) {
            const shardPath = shardPaths[i];
            const attachName = `shard_${i}`;
            
            try {
                await runQuery(targetDb, `ATTACH DATABASE '${shardPath.replace(/'/g, "''")}' AS ${attachName}`);
                
                const tables = ['metrics_minute', 'metrics_hour', 'metrics_day'];
                for (const table of tables) {
                    await runQuery(targetDb, `
                        INSERT OR IGNORE INTO ${table} 
                        SELECT * FROM ${attachName}.${table}
                    `);
                }
                
                await runQuery(targetDb, `DETACH DATABASE ${attachName}`);
            } catch (e) {
                console.error(`Error merging ${shardPath}:`, e.message);
                try { await runQuery(targetDb, `DETACH DATABASE ${attachName}`); } catch(err){}
            }
        }
        
        targetDb.close();
        console.log(`Successfully merged all shards into metrics_${dateStr}.db`);
    }
    
    console.log("\nAll days merged successfully.");
}

mergeShards().catch(err => {
    console.error("Error merging shards:", err);
    process.exit(1);
});
