const TMDB_API_KEY = '1865f43a0549ca50d341dd9ab8b29f49';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const ANIKAI_BASE = 'https://www3.anikai.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function getSimilarity(a, b) {
    if (!a || !b) return 0;
    const sa = a.toLowerCase().replace(/[^a-z0-9]/g, '');
    const sb = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (sa === sb) return 1;
    if (sa.length < 2 || sb.length < 2) return 0;
    const bigrams = s => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
        return set;
    };
    const ba = bigrams(sa), bb = bigrams(sb);
    let common = 0;
    for (const bg of ba) if (bb.has(bg)) common++;
    return (2 * common) / (ba.size + bb.size);
}

async function imdbToTmdb(imdbId) {
    try {
        const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.tv_results && data.tv_results.length > 0) return data.tv_results[0];
        if (data.movie_results && data.movie_results.length > 0) return data.movie_results[0];
        return null;
    } catch (e) {
        console.error('[AniKai] imdbToTmdb error:', e.message);
        return null;
    }
}

async function getTmdbMeta(tmdbId, type) {
    try {
        const url = type === 'movie'
            ? `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
            : `${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function searchAnikai(query) {
    try {
        const url = `${ANIKAI_BASE}/browser?keyword=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        const html = await res.text();
        const results = [];
        const itemRegex = /class="aitem"[\s\S]*?href="([^"]*\/watch\/[^"]*)"/g;
        let match;
        while ((match = itemRegex.exec(html)) !== null) {
            let href = match[1];
            if (!href.startsWith('http')) href = ANIKAI_BASE + href;
            const titleMatch = html.substring(match.index, match.index + 500).match(/class="title"[^>]*>([^<]*)/);
            const title = titleMatch ? titleMatch[1].trim() : '';
            results.push({ url: href, title: title });
        }
        return results;
    } catch (e) {
        console.error('[AniKai] Search error:', e.message);
        return [];
    }
}

async function getStreamsFromWatchPage(watchUrl) {
    try {
        const res = await fetch(watchUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        const html = await res.text();
        const streams = [];
        
        // The HTML structure is:
        // <div class="server-items" data-id="hsub">
        //   <span class="server-video ..." data-video="URL" data-tab='tab_0'>HD-1</span>
        //   ...
        // </div>
        // <div class="server-items" data-id="sub">...</div>
        // <div class="server-items" data-id="dub">...</div>
        //
        // We need to find the server-items divs and extract data-video from within them.
        
        const groupRegex = /class="server-items[^"]*"[^>]*data-id="([^"]*)"[\s\S]*?<\/div>/g;
        let gmatch;
        while ((gmatch = groupRegex.exec(html)) !== null) {
            const groupId = gmatch[1];
            const groupHtml = gmatch[0];
            
            // Only process hsub, sub, dub groups
            if (!['hsub', 'sub', 'dub'].includes(groupId)) continue;
            
            const isDub = groupId === 'dub';
            const label = isDub ? 'Dub' : 'Sub';
            
            // Extract all data-video URLs from this group
            const videoRegex = /data-video="([^"]*)"/g;
            let vmatch;
            let serverIdx = 0;
            while ((vmatch = videoRegex.exec(groupHtml)) !== null) {
                const embedUrl = vmatch[1];
                serverIdx++;
                const serverName = `HD-${serverIdx}`;
                const fullLabel = `${serverName} (${label})`;
                
                console.log(`[AniKai] Found: ${fullLabel} -> ${embedUrl.substring(0, 60)}`);
                const embedStreams = await extractFromEmbed(embedUrl, fullLabel);
                streams.push(...embedStreams);
            }
        }
        
        console.log(`[AniKai] Total streams: ${streams.length}`);
        return streams;
    } catch (e) {
        console.error('[AniKai] Watch page error:', e.message);
        return [];
    }
}

async function extractFromEmbed(embedUrl, label) {
    try {
        const res = await fetch(embedUrl, {
            headers: { 'User-Agent': UA, 'Referer': ANIKAI_BASE + '/' }
        });
        if (!res.ok) return [];
        const html = await res.text();
        const streams = [];
        
        const m3u8Regex = /(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/g;
        let match;
        while ((match = m3u8Regex.exec(html)) !== null) {
            let quality = 'Unknown';
            if (match[1].includes('1080')) quality = '1080p';
            else if (match[1].includes('720')) quality = '720p';
            else if (match[1].includes('480')) quality = '480p';
            else if (match[1].includes('360')) quality = '360p';
            streams.push({
                name: 'AniKai',
                title: `${label} - ${quality}`,
                url: match[1],
                quality: quality,
                headers: { 'Referer': embedUrl, 'User-Agent': UA }
            });
        }
        
        if (streams.length === 0 && html.includes('eval(function(p,a,c,k,e,d)')) {
            const unpacked = unpackEval(html);
            if (unpacked) {
                while ((match = m3u8Regex.exec(unpacked)) !== null) {
                    streams.push({
                        name: 'AniKai',
                        title: `${label} - Unknown`,
                        url: match[1],
                        quality: 'Unknown',
                        headers: { 'Referer': embedUrl, 'User-Agent': UA }
                    });
                }
            }
        }
        
        return streams;
    } catch (e) {
        return [];
    }
}

function unpackEval(html) {
    try {
        const startIdx = html.indexOf('eval(function(p,a,c,k,e,d)');
        if (startIdx === -1) return null;
        const openBrace = html.indexOf('{', startIdx);
        if (openBrace === -1) return null;
        let braceCount = 1, j = openBrace + 1;
        while (j < html.length && braceCount > 0) {
            if (html[j] === '{') braceCount++;
            else if (html[j] === '}') braceCount--;
            j++;
        }
        const argsStart = html.indexOf('(', j - 1);
        if (argsStart === -1) return null;
        let parenCount = 1, k = argsStart + 1;
        while (k < html.length && parenCount > 0) {
            if (html[k] === '(') parenCount++;
            else if (html[k] === ')') parenCount--;
            k++;
        }
        const argsStr = html.substring(argsStart + 1, k - 1).trim();
        const startChar = argsStr[0];
        let payload = '', i = 1;
        while (i < argsStr.length) {
            if (argsStr[i] === startChar) {
                let bs = 0, m = i - 1;
                while (m >= 0 && argsStr[m] === '\\') { bs++; m--; }
                if (bs % 2 === 0) break;
            }
            payload += argsStr[i];
            i++;
        }
        payload = payload.replace(new RegExp('\\\\' + startChar, 'g'), startChar).replace(/\\\\/g, '\\');
        const rest = argsStr.substring(i + 1);
        const quoteMatch = rest.match(/["']/);
        if (!quoteMatch) return null;
        const quotePos = quoteMatch.index;
        const quoteChar = quoteMatch.value;
        const ints = rest.substring(0, quotePos).match(/\b\d+\b/g);
        if (!ints || ints.length < 2) return null;
        const a = parseInt(ints[0]), c = parseInt(ints[1]);
        let keysStr = '', jj = quotePos + 1;
        while (jj < rest.length) {
            if (rest[jj] === quoteChar) {
                let bs = 0, m = jj - 1;
                while (m >= 0 && rest[m] === '\\') { bs++; m--; }
                if (bs % 2 === 0) break;
            }
            keysStr += rest[jj];
            jj++;
        }
        keysStr = keysStr.replace(new RegExp('\\\\' + quoteChar, 'g'), quoteChar).replace(/\\\\/g, '\\');
        const keys = keysStr.split('|');
        const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
        let result = payload;
        for (let idx = c - 1; idx >= 0; idx--) {
            if (idx < keys.length && keys[idx]) {
                let baseStr = '';
                if (idx === 0) baseStr = '0';
                else {
                    let temp = idx;
                    while (temp > 0) { baseStr = chars[temp % a] + baseStr; temp = Math.floor(temp / a); }
                }
                result = result.replace(new RegExp('\\b' + baseStr + '\\b', 'g'), keys[idx]);
            }
        }
        return result;
    } catch (e) {
        return null;
    }
}

async function getStreams(id, type = 'tv', season = null, episode = null) {
    try {
        let tmdbId = id;
        let meta = null;
        
        if (typeof id === 'string' && id.startsWith('tt')) {
            console.log(`[AniKai] Converting IMDB ID: ${id}`);
            const tmdbData = await imdbToTmdb(id);
            if (tmdbData) {
                tmdbId = tmdbData.id;
                console.log(`[AniKai] TMDB ID: ${tmdbId}`);
            } else {
                console.error('[AniKai] Could not convert IMDB ID');
                return [];
            }
        }
        
        meta = await getTmdbMeta(tmdbId, type);
        if (!meta) {
            console.error('[AniKai] Could not get TMDB metadata');
            return [];
        }
        
        const title = meta.name || meta.title;
        console.log(`[AniKai] Title: ${title}`);
        
        if (type === 'movie') {
            const results = await searchAnikai(title);
            if (results.length === 0) return [];
            const watchUrl = `${results[0].url}/ep-1`;
            return await getStreamsFromWatchPage(watchUrl);
        }
        
        const seasons = meta.seasons || [];
        let absoluteEp = episode || 1;
        if (season && season > 0) {
            for (const s of seasons) {
                if (s.season_number < season && s.season_number > 0) {
                    absoluteEp += s.episode_count;
                }
            }
        }
        console.log(`[AniKai] ${title} S${season}E${episode} = absolute ep ${absoluteEp}`);
        
        const results = await searchAnikai(title);
        if (results.length === 0) {
            const altTitle = meta.original_name || title;
            const altResults = await searchAnikai(altTitle);
            if (altResults.length === 0) return [];
            results.push(...altResults);
        }
        
        let best = null, bestScore = 0;
        for (const r of results) {
            const score = getSimilarity(r.title, title);
            if (score > bestScore) { bestScore = score; best = r; }
        }
        if (!best && results.length > 0) best = results[0];
        if (!best) return [];
        
        console.log(`[AniKai] Best match: ${best.title} -> ${best.url}`);
        const watchUrl = `${best.url}/ep-${absoluteEp}`;
        return await getStreamsFromWatchPage(watchUrl);
    } catch (e) {
        console.error('[AniKai] getStreams error:', e.message);
        return [];
    }
}

module.exports = { getStreams };
