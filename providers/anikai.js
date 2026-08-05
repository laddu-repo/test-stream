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
    } catch (e) { return null; }
}

async function getTmdbMeta(tmdbId, type) {
    try {
        const url = type === 'movie'
            ? `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
            : `${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
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
            results.push({ url: href, title: titleMatch ? titleMatch[1].trim() : '' });
        }
        return results;
    } catch (e) { return []; }
}

function unpackPacked(html) {
    try {
        const startIdx = html.indexOf('eval(function(p,a,c,k,e,d)');
        if (startIdx === -1) return null;
        const funcBodyStart = html.indexOf('{', startIdx);
        let braceCount = 1, j = funcBodyStart + 1;
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
        const rest = argsStr.substring(i + 1).trim();
        const numMatch = rest.match(/^,?\s*(\d+)\s*,\s*(\d+)/);
        if (!numMatch) return null;
        const a = parseInt(numMatch[1]);
        const c = parseInt(numMatch[2]);
        const keysMatch = rest.match(/['"]([^'"]*\|[^'"]*)['"]/);
        if (!keysMatch) return null;
        const keys = keysMatch[1].split('|');
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
    } catch (e) { return null; }
}

async function getStreamsFromWatchPage(watchUrl) {
    try {
        const res = await fetch(watchUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        const html = await res.text();
        const streams = [];
        const seenUrls = new Set();

        const groupRegex = /class="server-items[^"]*"[^>]*data-id="([^"]*)"[\s\S]*?<\/div>/g;
        let gmatch;
        while ((gmatch = groupRegex.exec(html)) !== null) {
            const groupId = gmatch[1];
            if (!['hsub', 'sub', 'dub'].includes(groupId)) continue;
            const isDub = groupId === 'dub';
            const audioLabel = isDub ? 'Dub' : 'Sub';

            const videoRegex = /data-video="([^"]*)"/g;
            let vmatch;
            let serverIdx = 0;
            while ((vmatch = videoRegex.exec(gmatch[0])) !== null) {
                const embedUrl = vmatch[1];
                serverIdx++;
                const serverName = `HD-${serverIdx}`;
                const fullLabel = `${serverName} (${audioLabel})`;

                const embedStreams = await extractFromEmbed(embedUrl);
                for (const s of embedStreams) {
                    if (seenUrls.has(s.url)) continue;
                    seenUrls.add(s.url);
                    streams.push({
                        name: 'AniKai',
                        title: `${serverName} (${audioLabel})`,
                        url: s.url,
                        quality: s.quality,
                        headers: s.headers
                    });
                }
            }
        }
        return streams;
    } catch (e) { return []; }
}

async function extractFromEmbed(embedUrl) {
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
                url: match[1],
                quality: quality,
                headers: { 'Referer': embedUrl, 'User-Agent': UA }
            });
        }

        if (streams.length === 0 && html.includes('eval(function(p,a,c,k,e,d)')) {
            const unpacked = unpackPacked(html);
            if (unpacked) {
                while ((match = m3u8Regex.exec(unpacked)) !== null) {
                    streams.push({
                        url: match[1],
                        quality: 'Unknown',
                        headers: { 'Referer': embedUrl, 'User-Agent': UA }
                    });
                }
            }
        }
        return streams;
    } catch (e) { return []; }
}

async function getStreams(id, type = 'tv', season = null, episode = null) {
    try {
        let tmdbId = id;
        if (typeof id === 'string' && id.startsWith('tt')) {
            const tmdbData = await imdbToTmdb(id);
            if (tmdbData) tmdbId = tmdbData.id;
            else return [];
        }

        const meta = await getTmdbMeta(tmdbId, type);
        if (!meta) return [];
        const title = meta.name || meta.title;

        if (type === 'movie') {
            const results = await searchAnikai(title);
            if (results.length === 0) return [];
            return await getStreamsFromWatchPage(`${results[0].url}/ep-1`);
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

        const results = await searchAnikai(title);
        if (results.length === 0) {
            const altResults = await searchAnikai(meta.original_name || title);
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

        return await getStreamsFromWatchPage(`${best.url}/ep-${absoluteEp}`);
    } catch (e) {
        console.error('[AniKai] getStreams error:', e.message);
        return [];
    }
}

module.exports = { getStreams };
