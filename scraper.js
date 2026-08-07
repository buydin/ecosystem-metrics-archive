const axios = require('axios');
const db = require('./db');

const API_BASE = 'https://api.fortnite.com/ecosystem/v1';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

    return Object.keys(metricsByTime).map(timestamp => {
        return {
            timestamp,
            ...metricsByTime[timestamp]
        };
    });
}

// Global variable to hold Phase 1 rankings
let globalRankings = {}; // { 'mapCode': [ { genreSlug, genre, rank } ] }

async function fetchAndSaveIslandMetadata(code) {
    try {
        const res = await axios.get(`${API_BASE}/islands/${code}`);
        if (res.data) {
            await db.upsertMap(res.data);
            return res.data;
        }
    } catch(e) {
        if(e.response && e.response.status !== 404) {
            console.error(`Failed metadata for ${code}`);
        }
    }
    return null;
}

// STEP 1: Genre Rankings
async function runGenreRankingsPhase() {
    console.log(`--- Starting Phase 1: Genre Rankings ---`);
    globalRankings = {};
    
    try {
        console.log(`Fetching all genres...`);
        const genresRes = await axios.get(`${API_BASE}/genres`, { headers: { 'accept': 'application/json' } });
        if (!genresRes.data || !genresRes.data.data) return;
        
        const genres = genresRes.data.data;
        console.log(`Found ${genres.length} genres. Fetching rankings...`);
        
        for (const genre of genres) {
            console.log(`Fetching top maps for genre: ${genre.slug}...`);
            let keepGoing = true;
            let afterCursor = null;
            let count = 0;
            
            while (keepGoing && count < 1000) {
                try {
                    let url = `${API_BASE}/genres/${genre.slug}/rankings?size=100`;
                    if (afterCursor) url += `&after=${encodeURIComponent(afterCursor)}`;
                    
                    const rankRes = await axios.get(url, { headers: { 'accept': 'application/json' } });
                    const data = rankRes.data;
                    
                    if (data.data && data.data.length > 0) {
                        for (const item of data.data) {
                            if (!globalRankings[item.islandCode]) globalRankings[item.islandCode] = [];
                            if (!globalRankings[item.islandCode].find(g => g.genreSlug === genre.slug)) {
                                globalRankings[item.islandCode].push({
                                    genreSlug: genre.slug,
                                    genre: genre.name,
                                    rank: item.rank
                                });
                            }
                            count++;
                        }
                    }
                    
                    if (data.meta && data.meta.page && data.meta.page.nextCursor && count < 1000) {
                        afterCursor = data.meta.page.nextCursor;
                        await sleep(300);
                    } else {
                        keepGoing = false;
                    }
                } catch (e) {
                    console.error(`Error fetching rank for ${genre.slug}: ${e.message}`);
                    keepGoing = false;
                }
            }
            await sleep(500);
        }
        console.log(`--- Phase 1 Complete. Ranks cached in memory. ---`);
    } catch (e) {
        console.error(`Error fetching genres: ${e.message}`);
    }
}

// STEP 3: Discovery
async function runDiscoveryPhase() {
    console.log(`--- Starting Phase 3: Discovery ---`);
    let afterCursor = null;
    let keepGoing = true;
    let totalFound = 0;

    while (keepGoing) {
        try {
            let url = `${API_BASE}/islands?size=1000`;
            if (afterCursor) url += `&after=${encodeURIComponent(afterCursor)}`;

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
                await sleep(500);
            } else {
                keepGoing = false;
            }

        } catch (e) {
            if (e.response && e.response.status === 429) {
                await sleep(15000);
            } else if (e.response && e.response.status === 502) {
                await sleep(10000);
            } else {
                await sleep(5000);
            }
        }
    }
    console.log(`--- Discovery Complete. Discovered ${totalFound} maps. ---`);
}

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
            if (e.response.status === 429) await sleep(10000);
            else if (e.response.status === 502) await sleep(5000);
        }
        return { success: false, error: e };
    }
}

async function runMetricsForMapCodes(codes, phaseName) {
    console.log(`--- Starting Metrics Phase: ${phaseName} ---`);
    console.log(`Need to process ${codes.length} maps.`);

    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        console.log(`[${i+1}/${codes.length}] Processing ${code}`);
        
        // Ensure metadata exists
        await fetchAndSaveIslandMetadata(code);
        await sleep(250);
        
        let mapLatestMetrics = { latestCCU: 0, latestFavorites: 0, latestPlays: 0, latestUniquePlayers: 0, latestAvgMinutes: 0 };
        function mergeMetrics(res) {
            if (res.metrics) {
                if (res.metrics.latestCCU > mapLatestMetrics.latestCCU) mapLatestMetrics.latestCCU = res.metrics.latestCCU;
                if (res.metrics.latestFavorites > mapLatestMetrics.latestFavorites) mapLatestMetrics.latestFavorites = res.metrics.latestFavorites;
                if (res.metrics.latestPlays > mapLatestMetrics.latestPlays) mapLatestMetrics.latestPlays = res.metrics.latestPlays;
                if (res.metrics.latestUniquePlayers > mapLatestMetrics.latestUniquePlayers) mapLatestMetrics.latestUniquePlayers = res.metrics.latestUniquePlayers;
                if (res.metrics.latestAvgMinutes > mapLatestMetrics.latestAvgMinutes) mapLatestMetrics.latestAvgMinutes = res.metrics.latestAvgMinutes;
            }
        }
        
        // 1. Day
        const dayRes = await fetchAndSaveMetrics(code, 'day', 'metrics_day');
        mergeMetrics(dayRes);
        await sleep(250);
        
        // 2. Skip Dead
        if (mapLatestMetrics.latestCCU === 0 && mapLatestMetrics.latestUniquePlayers === 0 && mapLatestMetrics.latestPlays === 0) {
            console.log(`[${i+1}/${codes.length}] 💀 Skipping ${code} (Dead map)`);
            await db.updateMapLatestMetrics(code, mapLatestMetrics);
            continue; 
        }

        // 3. Minute
        const minRes = await fetchAndSaveMetrics(code, 'minute', 'metrics_minute');
        mergeMetrics(minRes);
        await sleep(250);

        // 4. Hour
        const hrRes = await fetchAndSaveMetrics(code, 'hour', 'metrics_hour');
        mergeMetrics(hrRes);
        await sleep(250);
        
        // 5. Inject Rankings
        if (globalRankings[code]) {
            if (hrRes.metrics && hrRes.count > 0) {
                const currentHour = new Date();
                currentHour.setMinutes(0, 0, 0);
                await db.upsertMetricRecord('metrics_hour', code, currentHour.toISOString(), { rankings: globalRankings[code] });
            }
        }
        
        // 6. Update Latest
        await db.updateMapLatestMetrics(code, mapLatestMetrics);
    }
}

async function runFullPipeline() {
    console.log(`=== STARTING FULL AUTOMATED PIPELINE ===`);
    
    // STEP 1: Rankings
    await runGenreRankingsPhase();
    const rankedMapCodes = Object.keys(globalRankings);
    
    // STEP 2: Metrics for Rankings
    await runMetricsForMapCodes(rankedMapCodes, 'Ranked Maps');
    
    // STEP 3: Discovery
    await runDiscoveryPhase();
    
    // STEP 4: Metrics for Discovered
    const allMaps = await db.getAllMaps();
    const discoveredCodes = allMaps.map(m => m.code).filter(c => !rankedMapCodes.includes(c));
    await runMetricsForMapCodes(discoveredCodes, 'Discovered Maps');
    
    console.log(`=== PIPELINE COMPLETE ===`);
}

module.exports = {
    runDiscoveryPhase,
    runGenreRankingsPhase,
    runMetricsPhase: () => runMetricsForMapCodes((Object.keys(globalRankings)), 'Manual Metrics'), // Fallback for old API calls
    runFullPipeline
};

