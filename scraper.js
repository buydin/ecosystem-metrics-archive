const axios = require('axios');
const db = require('./db');

const API_BASE = 'https://api.fortnite.com/ecosystem/v1';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Transform the metric arrays into a single array of objects grouped by timestamp
function transposeMetrics(apiData) {
    const metricsByTime = {};

    const metricKeys = [
        'peakCCU', 'favorites', 'minutesPlayed', 'averageMinutesPerPlayer', 
        'recommendations', 'plays', 'uniquePlayers', 'retention'
    ];

    for (const key of metricKeys) {
        if (apiData[key] && Array.isArray(apiData[key])) {
            for (const item of apiData[key]) {
                if (!item.timestamp) continue;
                if (!metricsByTime[item.timestamp]) {
                    metricsByTime[item.timestamp] = {};
                }
                if (key === 'retention') {
                    metricsByTime[item.timestamp].retention_d1 = item.d1;
                    metricsByTime[item.timestamp].retention_d7 = item.d7;
                } else {
                    metricsByTime[item.timestamp][key] = item.value;
                }
            }
        }
    }

    // Convert to array
    return Object.keys(metricsByTime).map(timestamp => {
        return {
            timestamp,
            ...metricsByTime[timestamp]
        };
    });
}

// PHASE 1: Discovery
async function runDiscoveryPhase() {
    console.log("--- Starting Discovery Phase ---");
    let afterCursor = null;
    let keepGoing = true;
    let totalFound = 0;

    while (keepGoing) {
        try {
            let url = `${API_BASE}/islands?size=1000`;
            if (afterCursor) {
                url += `&after=${encodeURIComponent(afterCursor)}`;
            }

            console.log(`Fetching islands...`);
            const res = await axios.get(url, { headers: { 'accept': 'application/json' } });
            
            const data = res.data;
            if (data.data && data.data.length > 0) {
                for (const map of data.data) {
                    await db.upsertMap(map);
                    totalFound++;
                }
                console.log(`Upserted ${data.data.length} maps. Total so far: ${totalFound}`);
            }

            if (data.meta && data.meta.page && data.meta.page.nextCursor) {
                afterCursor = data.meta.page.nextCursor;
                await sleep(500); // Respect rate limits
            } else {
                keepGoing = false;
            }

        } catch (e) {
            if (e.response) {
                if (e.response.status === 429) {
                    console.error("⚠️ RATE LIMITED (429 Too Many Requests). Sleeping for 15 seconds...");
                    await sleep(15000); // Sleep longer and retry same cursor
                } else if (e.response.status === 502) {
                    console.error("⚠️ BAD GATEWAY (502). Epic API is struggling. Sleeping for 10 seconds...");
                    await sleep(10000); // Sleep and retry
                } else {
                    console.error(`Discovery error HTTP ${e.response.status}:`, e.message);
                    await sleep(5000);
                }
            } else {
                console.error("Discovery network error:", e.message);
                await sleep(5000);
            }
            // Notice we do NOT set keepGoing = false here! 
            // It will loop back around and retry the EXACT same `afterCursor`!
        }
    }
    console.log(`--- Discovery Complete. Discovered ${totalFound} total maps. ---`);
}

// PHASE 2: Metrics
async function fetchAndSaveMetrics(code, interval, table) {
    try {
        const res = await axios.get(`${API_BASE}/islands/${code}/metrics/${interval}`);
        const transposed = transposeMetrics(res.data);
        
        let latestMetrics = {
            latestCCU: 0,
            latestFavorites: 0,
            latestPlays: 0,
            latestUniquePlayers: 0,
            latestAvgMinutes: 0
        };
        for (const record of transposed) {
            await db.upsertMetricRecord(table, code, record.timestamp, record);
            if (record.peakCCU > latestMetrics.latestCCU) latestMetrics.latestCCU = record.peakCCU;
            if (record.favorites > latestMetrics.latestFavorites) latestMetrics.latestFavorites = record.favorites;
            if (record.plays > latestMetrics.latestPlays) latestMetrics.latestPlays = record.plays;
            if (record.uniquePlayers > latestMetrics.latestUniquePlayers) latestMetrics.latestUniquePlayers = record.uniquePlayers;
            if (record.averageMinutesPerPlayer > latestMetrics.latestAvgMinutes) latestMetrics.latestAvgMinutes = record.averageMinutesPerPlayer;
        }
        return { success: true, metrics: latestMetrics, count: transposed.length };
    } catch(e) {
        if(e.response) {
            if (e.response.status === 429) {
                 console.error(`[${code}] ⚠️ RATE LIMITED (429).`);
                 await sleep(10000);
            } else if (e.response.status === 502) {
                 console.error(`[${code}] ⚠️ BAD GATEWAY (502).`);
                 await sleep(5000);
            } else if (e.response.status !== 404) {
                 console.error(`[${code}] Failed ${interval}: `, e.message);
            }
        } else {
             console.error(`[${code}] Network error on ${interval}: `, e.message);
        }
        return { success: false, error: e };
    }
}

async function runMetricsPhase() {
    console.log("--- Starting Metrics Phase ---");
    const maps = await db.getAllMaps();
    console.log(`Need to process ${maps.length} maps.`);

    for (let i = 0; i < maps.length; i++) {
        const map = maps[i];
        console.log(`[${i+1}/${maps.length}] Processing ${map.code} (${map.title})`);
        
        let mapLatestMetrics = {
            latestCCU: 0,
            latestFavorites: 0,
            latestPlays: 0,
            latestUniquePlayers: 0,
            latestAvgMinutes: 0
        };
        
        function mergeMetrics(res) {
            if (res.metrics) {
                if (res.metrics.latestCCU > mapLatestMetrics.latestCCU) mapLatestMetrics.latestCCU = res.metrics.latestCCU;
                if (res.metrics.latestFavorites > mapLatestMetrics.latestFavorites) mapLatestMetrics.latestFavorites = res.metrics.latestFavorites;
                if (res.metrics.latestPlays > mapLatestMetrics.latestPlays) mapLatestMetrics.latestPlays = res.metrics.latestPlays;
                if (res.metrics.latestUniquePlayers > mapLatestMetrics.latestUniquePlayers) mapLatestMetrics.latestUniquePlayers = res.metrics.latestUniquePlayers;
                if (res.metrics.latestAvgMinutes > mapLatestMetrics.latestAvgMinutes) mapLatestMetrics.latestAvgMinutes = res.metrics.latestAvgMinutes;
            }
        }
        
        // 1. Minute
        const minRes = await fetchAndSaveMetrics(map.code, 'minute', 'metrics_minute');
        mergeMetrics(minRes);
        await sleep(250);

        // 2. Hour
        const hrRes = await fetchAndSaveMetrics(map.code, 'hour', 'metrics_hour');
        mergeMetrics(hrRes);
        await sleep(250);

        // 3. Day
        const dayRes = await fetchAndSaveMetrics(map.code, 'day', 'metrics_day');
        mergeMetrics(dayRes);
        await sleep(250);
        
        // 4. Update latest metrics in maps table for quick sorting
        if (mapLatestMetrics.latestCCU > 0) {
            await db.updateMapLatestMetrics(map.code, mapLatestMetrics);
        }
    }
    
    console.log("--- Metrics Phase Complete ---");
}

module.exports = {
    runDiscoveryPhase,
    runMetricsPhase
};
