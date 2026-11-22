/**
 * Live network monitor for a Real Device Access API session.
 *
 * Connects to the session's Companion WebSocket (`links.eventsWebsocketUrl`) and listens for
 * `device.har.entry` messages, which are only sent after `enableNetworkCapture`. Every entry that
 * matches the filter is printed (request + response) the moment it arrives, and kept so tests can
 * wait for and assert on a specific request.
 *
 * Docs: https://docs.saucelabs.com/mobile-apps/rdc-access-api/real-device-access-api-mastering-companion-socket
 */
import WebSocket from 'ws';

const HAR_ENTRY = 'device.har.entry';
const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i;

const C = process.stdout.isTTY && !process.env.NO_COLOR
    ? { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' }
    : { dim: '', bold: '', cyan: '', green: '', yellow: '', red: '', reset: '' };

/**
 * The docs only guarantee a top-level `type` field, so look for the HAR entry ({ request, response })
 * at the top level or one level down (entry / data / value / payload / message / har.entry),
 * parsing JSON strings on the way.
 */
export function extractHarEntry(message) {
    const isEntry = (o) => o && typeof o === 'object' && o.request && typeof o.request === 'object';
    const parse = (v) => {
        if (typeof v !== 'string') return v;
        try {
            return JSON.parse(v);
        } catch {
            return undefined;
        }
    };
    if (isEntry(message)) return message;
    for (const key of ['entry', 'data', 'value', 'payload', 'message', 'har']) {
        let candidate = parse(message?.[key]);
        if (candidate?.entry) candidate = parse(candidate.entry);
        if (candidate?.log?.entries?.[0]) candidate = candidate.log.entries[0];
        if (isEntry(candidate)) return candidate;
    }
    return undefined;
}

function decodeBody(text, encoding) {
    if (text == null || text === '') return '';
    let body = encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : String(text);
    try {
        body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
        /* not JSON - print as is */
    }
    return body;
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function formatHeaders(headers = []) {
    return headers
        .map(({ name, value }) => `    ${name}: ${SECRET_HEADERS.test(name) ? '***' : value}`)
        .join('\n');
}

function indent(text, prefix = '    ') {
    return text.split('\n').map((line) => prefix + line).join('\n');
}

export function formatEntry(entry, { maxBody = 2000 } = {}) {
    const { request = {}, response = {} } = entry;
    const status = response.status ?? '?';
    const color = status >= 500 || status <= 0 ? C.red : status >= 400 ? C.yellow : C.green;
    const reqBody = decodeBody(request.postData?.text, request.postData?.encoding);
    const resBody = decodeBody(response.content?.text, response.content?.encoding);
    const time = typeof entry.time === 'number' ? ` ${C.dim}(${Math.round(entry.time)} ms)${C.reset}` : '';

    const lines = [
        `${C.cyan}${C.bold}┌─ [network] ${request.method ?? '?'} ${request.url ?? '?'}${C.reset}`,
        `${C.bold}│ ▶ Request${C.reset}`,
        formatHeaders(request.headers),
    ];
    if (reqBody) lines.push(`${C.dim}    body:${C.reset}`, indent(truncate(reqBody, maxBody), '      '));
    lines.push(
        `${C.bold}│ ◀ Response ${color}${status} ${response.statusText ?? ''}${C.reset}${time}`,
        formatHeaders(response.headers),
    );
    if (resBody) lines.push(`${C.dim}    body:${C.reset}`, indent(truncate(resBody, maxBody), '      '));
    else if (response.content?.size > 0) lines.push(`${C.dim}    body: ${response.content.size} bytes (not included in the capture)${C.reset}`);
    lines.push(`${C.cyan}└─${C.reset}`);
    return lines.filter((l) => l !== '').join('\n');
}

export class NetworkMonitor {
    /**
     * @param {object} opts
     * @param {string} opts.url         Companion socket URL (session.links.eventsWebsocketUrl)
     * @param {string} opts.authHeader  "Basic base64(username:accessKey)"
     * @param {RegExp} [opts.filter]    Only keep/print entries whose URL matches
     * @param {boolean} [opts.print]    Print entries live (default true)
     * @param {boolean} [opts.debug]    Also print the raw socket message of each HAR entry
     * @param {number} [opts.maxBody]   Max characters of a body to print
     */
    constructor({ url, authHeader, filter, print = true, debug = false, maxBody = 2000, log = console.log }) {
        Object.assign(this, { url, authHeader, filter, print, debug, maxBody, log });
        this.entries = [];
        this.ignored = 0;
        this.waiters = new Set();
        this.closed = false;
        this.reconnects = 0;
    }

    /** Opens the socket; resolves once connected. */
    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url, {
                headers: { Authorization: this.authHeader },
                maxPayload: 64 * 1024 * 1024, // HAR entries with bodies can be large
            });
            this.ws = ws;
            ws.once('open', () => {
                this.log(`${C.dim}[network] Listening on the Companion socket${this.filter ? ` (filter: ${this.filter})` : ''}${C.reset}`);
                resolve();
            });
            ws.once('unexpected-response', (_req, res) => {
                reject(new Error(`Companion socket refused the connection: HTTP ${res.statusCode}`));
            });
            ws.once('error', (err) => reject(err));
            ws.on('message', (data) => this.#onMessage(data));
            ws.on('close', (code) => {
                if (this.closed) return;
                // Unexpected close: reconnect a few times so a network blip doesn't end the monitoring.
                if (this.reconnects++ < 5) {
                    this.log(`[network] Socket closed (${code}), reconnecting…`);
                    setTimeout(() => this.connect().catch((e) => this.log(`[network] Reconnect failed: ${e.message}`)), 2_000);
                }
            });
        });
    }

    #onMessage(data) {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (message?.type !== HAR_ENTRY) return;

        if (this.debug) this.log(`[network] raw message:\n${JSON.stringify(message, null, 2)}`);
        const entry = extractHarEntry(message);
        if (!entry) {
            this.log(`[network] ${HAR_ENTRY} without a recognizable HAR entry:\n${JSON.stringify(message).slice(0, 2000)}`);
            return;
        }
        if (this.filter && !this.filter.test(entry.request?.url ?? '')) {
            this.ignored++;
            return;
        }

        this.entries.push(entry);
        if (this.print) this.log(formatEntry(entry, { maxBody: this.maxBody }));
        for (const waiter of this.waiters) waiter.check();
    }

    /** Position in the captured list; pass it as `since` to only match newer entries. */
    mark() {
        return this.entries.length;
    }

    /**
     * Resolves with the first entry (at or after `since`) that matches `predicate`.
     * @param {(entry: object) => boolean} predicate
     */
    waitFor(predicate, { since = 0, timeout = 30_000, description = 'matching request' } = {}) {
        return new Promise((resolve, reject) => {
            const waiter = {
                check: () => {
                    const found = this.entries.slice(since).find(predicate);
                    if (!found) return false;
                    clearTimeout(waiter.timer);
                    this.waiters.delete(waiter);
                    resolve(found);
                    return true;
                },
            };
            if (waiter.check()) return;
            waiter.timer = setTimeout(() => {
                this.waiters.delete(waiter);
                const seen = this.entries.slice(since).map((e) => `${e.request?.method} ${e.request?.url}`);
                reject(new Error(
                    `No ${description} captured within ${timeout / 1000}s. ` +
                    `Captured since mark: ${seen.length ? seen.join(', ') : 'none'} ` +
                    `(${this.ignored} other entries ignored by the filter)`,
                ));
            }, timeout);
            this.waiters.add(waiter);
        });
    }

    close() {
        this.closed = true;
        for (const waiter of this.waiters) clearTimeout(waiter.timer);
        this.waiters.clear();
        this.ws?.close();
    }
}

/** Small helpers for assertions on HAR entries. */
export const har = {
    status: (entry) => entry.response?.status,
    header: (headers = [], name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value,
    requestJson(entry) {
        const { text, encoding } = entry.request?.postData ?? {};
        if (!text) return undefined;
        return JSON.parse(encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text);
    },
};
