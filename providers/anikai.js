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

function toRoman(num) {
    const vals = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    let result = '';
    for (const [v, s] of vals) { while (num >= v) { result += s; num -= v; } }
    return result;
}

function isMovieOrSpecial(url, type) {
    const u = url.toLowerCase();
    // URL-based keywords (high-confidence special/movie indicators)
    if (u.includes('movie') || u.includes('film') || u.includes('compilation') ||
        u.includes('special') || u.includes('ova') || u.includes('ona') ||
        u.includes('recap') || u.includes('summary') || u.includes('mini') ||
        u.includes('reigen') || u.includes('spinoff') || u.includes('side-story') ||
        u.includes('-sp-') || u.endsWith('-sp') ||
        u.endsWith('-ova') || u.endsWith('-ona') || u.endsWith('-special') ||
        u.endsWith('-movie') || u.endsWith('-film')) {
        return true;
    }
    // Type-based (parsed from AniKai's HTML type label)
    // NOTE: We do NOT filter type==='special' because AniKai sometimes
    // mislabels main TV series (e.g. Chainsaw Man) as 'Special'.
    // We only filter Movie/OVA/Music/TV_SHORT types which are clearly not TV series.
    if (type && (type === 'movie' || type === 'ova' || type === 'music' || type === 'tvshort')) {
        return true;
    }
    return false;
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

async function getSeasonDetails(tmdbId, seasonNum) {
    try {
        const url = `${TMDB_BASE}/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}`;
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
        // Split by aitem blocks so we can extract title + type for each entry
        // without bleeding into the next entry.
        const parts = html.split('class="aitem"');
        for (let i = 1; i < parts.length; i++) {
            // Limit to first 2500 chars to avoid capturing the next aitem block
            const block = parts[i].substring(0, 2500);
            const hrefMatch = block.match(/href="([^"]*\/watch\/[^"]*)"/);
            if (!hrefMatch) continue;
            let href = hrefMatch[1];
            if (!href.startsWith('http')) href = ANIKAI_BASE + href;
            const titleMatch = block.match(/class="title[^"]*"[^>]*>([^<]*)/);
            const title = titleMatch ? titleMatch[1].trim() : '';
            // Extract type label: the LAST <span><b>X</b></span> inside .info
            // Structure: <span class="sub">N</span> <span class="dub">N</span>
            //            <span><b>N</b></span> (episode count, optional)
            //            <span><b>TYPE</b></span> (TV / Movie / Special / OVA / ONA)
            const spanMatches = [...block.matchAll(/<span>\s*<b>\s*([^<]+?)\s*<\/b>\s*<\/span>/g)];
            const type = spanMatches.length > 0
                ? spanMatches[spanMatches.length - 1][1].trim().toLowerCase()
                : '';
            results.push({ url: href, title, type });
        }
        return results;
    } catch (e) { return []; }
}

async function getEpisodeCount(animeUrl) {
    try {
        const res = await fetch(`${animeUrl}/ep-1`, { headers: { 'User-Agent': UA } });
        if (!res.ok) return 0;
        const html = await res.text();
        const slug = animeUrl.split('/watch/')[1];
        const epRegex = new RegExp(`/watch/${slug}/ep-(\\d+)`, 'g');
        let match, maxEp = 0;
        while ((match = epRegex.exec(html)) !== null) {
            const ep = parseInt(match[1]);
            if (ep > maxEp) maxEp = ep;
        }
        return maxEp;
    } catch (e) { return 0; }
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
                const embedStreams = await extractFromEmbed(embedUrl);
                for (const s of embedStreams) {
                    if (seenUrls.has(s.url)) continue;
                    seenUrls.add(s.url);
                    // Put the (Sub)/(Dub) label in BOTH `name` and `title` so the
                    // label is always visible regardless of which field the UI shows.
                    streams.push({
                        name: `AniKai ${serverName} (${audioLabel})`,
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
            streams.push({ url: match[1], quality, headers: { 'Referer': embedUrl, 'User-Agent': UA } });
        }

        if (streams.length === 0 && html.includes('eval(function(p,a,c,k,e,d)')) {
            const unpacked = unpackPacked(html);
            if (unpacked) {
                while ((match = m3u8Regex.exec(unpacked)) !== null) {
                    streams.push({ url: match[1], quality: 'Unknown', headers: { 'Referer': embedUrl, 'User-Agent': UA } });
                }
            }
        }
        return streams;
    } catch (e) { return []; }
}

async function findBestAnikaiEntry(results, title, season) {
    if (!results || results.length === 0) return null;

    // ===== Season 0 (Specials) =====
    // Look for entries that ARE specials/movies (reverse of the usual filter).
    if (season === 0) {
        const specials = results.filter(r => isMovieOrSpecial(r.url, r.type));
        if (specials.length > 0) {
            // Pick the one with the highest title similarity to the series name
            let best = null, bestScore = -1;
            for (const r of specials) {
                const score = getSimilarity(r.title, title);
                if (score > bestScore) { bestScore = score; best = r; }
            }
            return best || specials[0];
        }
        // No specials found — fall through and pick the first result
        return results[0];
    }

    // ===== Seasons 1+ =====
    // Filter out movies/specials/compilations using both URL keywords AND the
    // type label parsed from AniKai's HTML.
    const filtered = results.filter(r => !isMovieOrSpecial(r.url, r.type));
    if (filtered.length === 0) return results[0];

    const titleLower = (title || '').toLowerCase().trim();

    // For season 1: prefer exact title match first, then non-roman-numeral entries
    if (!season || season === 1) {
        // 1a. Exact title match (case-insensitive) — picks e.g. "Mob Psycho 100"
        //     over "Mob Psycho Mini" which is a spinoff special.
        const exactMatch = filtered.find(r =>
            (r.title || '').toLowerCase().trim() === titleLower
        );
        if (exactMatch) return exactMatch;

        // 1b. Entries whose URL slug does NOT end with a roman numeral suffix.
        //     This avoids picking Season 2/3 entries for Season 1.
        const season1 = filtered.find(r => {
            const slug = r.url.split('/watch/')[1] || '';
            return !slug.match(/-(ii|iii|iv|v|vi|vii|viii|ix|x)$/i);
        });
        if (season1) return season1;
    }

    // For season >1: prefer entries whose slug ends with the roman numeral
    if (season && season > 1) {
        const roman = toRoman(season).toLowerCase();
        const seasonMatch = filtered.find(r => {
            const slug = r.url.split('/watch/')[1] || '';
            return slug.toLowerCase().endsWith('-' + roman) ||
                   slug.toLowerCase().includes('-' + roman + '-') ||
                   slug.toLowerCase().includes('season-' + season) ||
                   slug.toLowerCase().includes('s' + season);
        });
        if (seasonMatch) return seasonMatch;
    }

    // Fallback: best similarity match
    let best = null, bestScore = 0;
    for (const r of filtered) {
        const score = getSimilarity(r.title, title);
        if (score > bestScore) { bestScore = score; best = r; }
    }
    return best || filtered[0];
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
            // For movies, prefer movie entries
            const movieEntry = results.find(r => isMovieOrSpecial(r.url, r.type));
            const target = movieEntry || results[0];
            return await getStreamsFromWatchPage(`${target.url}/ep-1`);
        }

        // TV type: determine the correct AniKai entry and episode number
        const seasons = meta.seasons || [];
        // Preserve season 0 (Specials) — don't coerce falsy 0 to 1.
        const seasonNum = (season === null || season === undefined) ? 1 : season;
        const epNum = episode || 1;

        // Get the season's episode count from TMDB
        const tmdbSeason = seasons.find(s => s.season_number === seasonNum);
        const seasonEpCount = tmdbSeason ? tmdbSeason.episode_count : 0;

        // Search AniKai with the series title
        const results = await searchAnikai(title);
        if (results.length === 0) {
            const altResults = await searchAnikai(meta.original_name || title);
            if (altResults.length === 0) return [];
            results.push(...altResults);
        }

        // Find the best entry for this season
        const best = await findBestAnikaiEntry(results, title, seasonNum);
        if (!best) return [];

        // Check how many episodes this AniKai entry has
        const anikaiEpCount = await getEpisodeCount(best.url);

        let targetEp;
        if (anikaiEpCount > seasonEpCount && seasonNum > 1) {
            // This entry contains multiple seasons (like One Piece)
            // Use absolute episode numbering
            let absoluteEp = epNum;
            for (const s of seasons) {
                if (s.season_number < seasonNum && s.season_number > 0) {
                    absoluteEp += s.episode_count;
                }
            }
            targetEp = absoluteEp;
        } else {
            // This entry is for a single season
            // Use the episode number directly
            targetEp = epNum;
        }

        return await getStreamsFromWatchPage(`${best.url}/ep-${targetEp}`);
    } catch (e) {
        console.error('[AniKai] getStreams error:', e.message);
        return [];
    }
}

module.exports = { getStreams };
