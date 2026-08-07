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
    const today = new Date().toISOString().split('T')[0];
    const targetDbPath = path.join(DB_DIR, `metrics_${today}.db`);
    
    console.log(`Initializing target database: ${targetDbPath}`);
    await initDailyDb(targetDbPath);
    
    const targetDb = new sqlite3.Database(targetDbPath);
    
    const files = fs.readdirSync(DB_DIR).filter(f => f.startsWith('shard_') && f.endsWith('.db'));
    if (files.length === 0) {
        console.log("No shard databases found to merge.");
        targetDb.close();
        return;
    }
    
    console.log(`Found ${files.length} shards to merge.`);
    
    for (let i = 0; i < files.length; i++) {
        const shardFile = files[i];
        const shardPath = path.join(DB_DIR, shardFile);
        console.log(`Merging shard: ${shardFile}`);
        
        const attachName = `shard_${i}`;
        
        await runQuery(targetDb, `ATTACH DATABASE '${shardPath.replace(/'/g, "''")}' AS ${attachName}`);
        
        // Merge tables
        const tables = ['metrics_minute', 'metrics_hour', 'metrics_day'];
        for (const table of tables) {
            try {
                await runQuery(targetDb, `
                    INSERT OR IGNORE INTO ${table} 
                    SELECT * FROM ${attachName}.${table}
                `);
            } catch (e) {
                console.error(`Error merging ${table} from ${shardFile}:`, e);
            }
        }
        
        await runQuery(targetDb, `DETACH DATABASE ${attachName}`);
    }
    
    targetDb.close();
    console.log("Merge completed successfully.");
}

mergeShards().catch(err => {
    console.error("Error merging shards:", err);
    process.exit(1);
});
