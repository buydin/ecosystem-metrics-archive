const axios = require('axios');
const fs = require('fs');
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
            let mapData = res.data;
            
            // Fetch Image from FCHQ
            try {
                const fchqRes = await axios.get(`https://fchq.io/api/v1/map/${code}`, { timeout: 5000 });
                if (fchqRes.data && fchqRes.data.map && fchqRes.data.map.epicImageUrl) {
                    mapData.image_url = fchqRes.data.map.epicImageUrl;
                }
            } catch(fchqErr) {
                // Silently fail FCHQ if it rate limits us, don't break the whole scrape!
            }
            
            await db.upsertMap(mapData);
            return mapData;
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
    let attempts = 0;
    let res = null;
    
    // Dynamically calculate the precise 7-day rolling window for the API
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 7);
    
    const toStr = encodeURIComponent(toDate.toISOString());
    const fromStr = encodeURIComponent(fromDate.toISOString());

    while (attempts < 3) {
        attempts++;
        try {
            res = await axios.get(`${API_BASE}/islands/${code}/metrics/${interval}?from=${fromStr}&to=${toStr}`, { timeout: 15000 });
            break;
        } catch (e) {
            if (attempts === 3) return { success: false, error: e };
            if (e.response) {
                if (e.response.status === 429) await sleep(10000);
                else if (e.response.status === 502) await sleep(5000);
                else await sleep(2000);
            } else {
                await sleep(2000);
            }
        }
    }
    
    if (!res || !res.data) return { success: false, error: "No data" };
    
    try {
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
    
    // Cache known maps to avoid redundant metadata calls
    const allKnownMaps = await db.getAllMaps();
    const knownMapCodes = new Set(allKnownMaps.map(m => m.code));

    for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        console.log(`[${i+1}/${codes.length}] Processing ${code}`);
        
        // Ensure metadata exists (Skip if we already have it in DB)
        if (!knownMapCodes.has(code)) {
            await fetchAndSaveIslandMetadata(code);
            await sleep(250);
            knownMapCodes.add(code);
        }
        
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

        // 3. Fetch Minute and Hour concurrently (2x faster)
        const [minRes, hrRes] = await Promise.all([
            fetchAndSaveMetrics(code, 'minute', 'metrics_minute'),
            fetchAndSaveMetrics(code, 'hour', 'metrics_hour')
        ]);
        
        mergeMetrics(minRes);
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
    let discoveredCodes = allMaps.map(m => m.code).filter(c => !rankedMapCodes.includes(c));
    
    // Auto-Resume: Filter out maps we already checked today!
    const today = new Date().toISOString().split('T')[0];
    const processedToday = await db.getMapsProcessedToday(today);
    const processedSet = new Set(processedToday);
    
    const originalCount = discoveredCodes.length;
    discoveredCodes = discoveredCodes.filter(c => !processedSet.has(c));
    console.log(`[Auto-Resume] Filtered out ${originalCount - discoveredCodes.length} maps already processed today.`);
    
    await runMetricsForMapCodes(discoveredCodes, 'Discovered Maps');
    
    console.log(`=== PIPELINE COMPLETE ===`);
}


async function runTrackA() {
    console.log("=== STARTING TRACK A (Coordinator) ===");
    await runGenreRankingsPhase();
    fs.writeFileSync('globalRankings.json', JSON.stringify(globalRankings, null, 2));
    await runDiscoveryPhase();
    console.log("=== TRACK A COMPLETE ===");
}

function chunkArray(array, totalChunks, chunkIndex) {
    const size = Math.ceil(array.length / totalChunks);
    const start = chunkIndex * size;
    return array.slice(start, start + size);
}

async function runTrackBGenres(total, idx) {
    console.log(`=== STARTING TRACK B GENRES [${idx}/${total}] ===`);
    if (fs.existsSync('globalRankings.json')) {
        globalRankings = JSON.parse(fs.readFileSync('globalRankings.json', 'utf8'));
    }
    const rankedMapCodes = Object.keys(globalRankings);
    const chunk = chunkArray(rankedMapCodes, total, idx);
    await runMetricsForMapCodes(chunk, 'Ranked Maps');
    console.log(`=== TRACK B GENRES COMPLETE ===`);
}

async function runTrackBDiscovery(total, idx) {
    console.log(`=== STARTING TRACK B DISCOVERY [${idx}/${total}] ===`);
    if (fs.existsSync('globalRankings.json')) {
        globalRankings = JSON.parse(fs.readFileSync('globalRankings.json', 'utf8'));
    }
    const rankedMapCodes = Object.keys(globalRankings);
    const allMaps = await db.getAllMaps();
    let discoveredCodes = allMaps.map(m => m.code).filter(c => !rankedMapCodes.includes(c));
    
    const today = new Date().toISOString().split('T')[0];
    const processedToday = await db.getMapsProcessedToday(today);
    const processedSet = new Set(processedToday);
    
    discoveredCodes = discoveredCodes.filter(c => !processedSet.has(c));
    const chunk = chunkArray(discoveredCodes, total, idx);
    await runMetricsForMapCodes(chunk, 'Discovered Maps');
    console.log(`=== TRACK B DISCOVERY COMPLETE ===`);
}

async function runTrackBAll(total, idx) {
    console.log(`=== STARTING TRACK B (Ultimate Load Balancer) [${idx}/${total}] ===`);
    if (fs.existsSync('globalRankings.json')) {
        globalRankings = JSON.parse(fs.readFileSync('globalRankings.json', 'utf8'));
    }
    
    // 1. Get all ranked maps
    const rankedMapCodes = Object.keys(globalRankings);
    
    // 2. Get all discovery maps
    const allMaps = await db.getAllMaps();
    let discoveredCodes = allMaps.map(m => m.code).filter(c => !rankedMapCodes.includes(c));
    
    // 3. Filter out maps already processed today
    const today = new Date().toISOString().split('T')[0];
    const processedToday = await db.getMapsProcessedToday(today);
    const processedSet = new Set(processedToday);
    discoveredCodes = discoveredCodes.filter(c => !processedSet.has(c));
    
    // 4. Combine them into one massive pool!
    // We put ranked maps first so they always get priority scraping
    const allCodesToProcess = [...rankedMapCodes, ...discoveredCodes];
    
    // 5. Perfectly slice the massive pool into exactly equal chunks for the 18 servers
    const chunk = chunkArray(allCodesToProcess, total, idx);
    console.log(`[Load Balancer] Total maps to process: ${allCodesToProcess.length}. Server #${idx} is processing exactly ${chunk.length} maps!`);
    
    await runMetricsForMapCodes(chunk, 'Combined Swarm');
    console.log(`=== TRACK B SWARM COMPLETE ===`);
}

module.exports = {
    runTrackA,
    runTrackBGenres,
    runTrackBDiscovery,
    runTrackBAll,
    runDiscoveryPhase,
    runGenreRankingsPhase,
    runMetricsPhase: () => runMetricsForMapCodes((Object.keys(globalRankings)), 'Manual Metrics'), // Fallback for old API calls
    runFullPipeline
};

