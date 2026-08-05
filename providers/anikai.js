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

async function getTmdbMeta(tmdbId, type) {
    try {
        const url = type === 'movie'
            ? `${TMDB_BASE}/movie/${tmdbId}?api_key=${TMDB_API_KEY}`
            : `${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error('[AniKai] TMDB error:', e.message);
        return null;
    }
}

async function getSeasonInfo(tmdbId, seasonNum) {
    try {
        const url = `${TMDB_BASE}/tv/${tmdbId}/season/${seasonNum}?api_key=${TMDB_API_KEY}`;
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
        const itemRegex = /class="aitem"[\s\S]*?<a[^>]*href="([^"]*)"[\s\S]*?<img[^>]*src="([^"]*)"[^>]*>[\s\S]*?<span[^>]*class="title"[^>]*>([^<]*)<\/span>/g;
        let match;
        while ((match = itemRegex.exec(html)) !== null) {
            let href = match[1];
            if (!href.startsWith('http')) href = ANIKAI_BASE + href;
            href = href.replace(/\/ep-\d+$/, '');
            results.push({
                url: href,
                poster: match[2],
                title: match[3].trim()
            });
        }
        return results;
    } catch (e) {
        console.error('[AniKai] Search error:', e.message);
        return [];
    }
}

async function getEpisodeList(animeUrl) {
    try {
        const res = await fetch(animeUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        const html = await res.text();
        const episodes = [];
        const epRegex = /<a[^>]*href="([^"]*)"[^>]*data-num="(\d+)"[^>]*>[\s\S]*?(?:<span[^>]*data-jp[^>]*>([^<]*)<\/span>)?/g;
        let match;
        while ((match = epRegex.exec(html)) !== null) {
            let epHref = match[1];
            if (!epHref.startsWith('http')) epHref = ANIKAI_BASE + epHref;
            episodes.push({
                url: epHref,
                number: parseInt(match[2]),
                title: match[3] ? match[3].trim() : null
            });
        }
        return episodes;
    } catch (e) {
        console.error('[AniKai] Episode list error:', e.message);
        return [];
    }
}

async function getStreamsFromWatchPage(watchUrl) {
    try {
        const res = await fetch(watchUrl, { headers: { 'User-Agent': UA } });
        if (!res.ok) return [];
        const html = await res.text();
        const streams = [];
        const types = ['sub', 'hsub', 'dub'];
        for (const type of types) {
            const groupRegex = new RegExp(
                `data-id="${type}"[\\s\\S]*?<\\/div>`, 'g'
            );
            const groupMatch = html.match(groupRegex);
            if (!groupMatch) continue;
            const groupHtml = groupMatch[0];
            const serverRegex = /<span[^>]*class="server-video"[^>]*data-video="([^"]*)"[^>]*>([^<]*)<\/span>/g;
            let smatch;
            while ((smatch = serverRegex.exec(groupHtml)) !== null) {
                const embedUrl = smatch[1];
                const serverName = smatch[2].trim();
                const isDub = type === 'dub';
                const label = `${serverName} (${isDub ? 'Dub' : 'Sub'})`;
                const embedStreams = await extractFromEmbed(embedUrl, label);
                streams.push(...embedStreams);
            }
        }
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
        const m3u8Regex = /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/g;
        let match;
        while ((match = m3u8Regex.exec(html)) !== null) {
            const m3u8Url = match[1];
            let quality = 'Unknown';
            if (m3u8Url.includes('1080')) quality = '1080p';
            else if (m3u8Url.includes('720')) quality = '720p';
            else if (m3u8Url.includes('480')) quality = '480p';
            else if (m3u8Url.includes('360')) quality = '360p';
            streams.push({
                name: 'AniKai',
                title: `${label} - ${quality}`,
                url: m3u8Url,
                quality: quality,
                headers: {
                    'Referer': embedUrl,
                    'User-Agent': UA
                }
            });
        }
        return streams;
    } catch (e) {
        return [];
    }
}

async function getStreams(tmdbId, type = 'tv', season = null, episode = null) {
    try {
        if (type === 'movie') {
            const meta = await getTmdbMeta(tmdbId, 'movie');
            if (!meta) return [];
            const title = meta.title || meta.name;
            const results = await searchAnikai(title);
            if (results.length === 0) return [];
            const best = results[0];
            const episodes = await getEpisodeList(best.url);
            if (episodes.length === 0) return [];
            const ep = episodes[0];
            return await getStreamsFromWatchPage(ep.url);
        }

        const meta = await getTmdbMeta(tmdbId, 'tv');
        if (!meta) return [];
        const title = meta.name || meta.title;
        const seasons = meta.seasons || [];
        let absoluteEp = episode;
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
            const altTitle = meta.original_name || meta.name;
            const altResults = await searchAnikai(altTitle);
            if (altResults.length === 0) return [];
            results.push(...altResults);
        }
        let best = null;
        let bestScore = 0;
        for (const r of results) {
            const score = getSimilarity(r.title, title);
            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        }
        if (!best && results.length > 0) best = results[0];
        if (!best) return [];
        const episodes = await getEpisodeList(best.url);
        if (episodes.length === 0) return [];
        const targetEp = episodes.find(e => e.number === absoluteEp) ||
                         episodes.find(e => e.number === episode) ||
                         episodes[Math.min(absoluteEp - 1, episodes.length - 1)];
        if (!targetEp) return [];
        return await getStreamsFromWatchPage(targetEp.url);
    } catch (e) {
        console.error('[AniKai] getStreams error:', e.message);
        return [];
    }
}

module.exports = { getStreams };
