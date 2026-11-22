/**
 * Minimal client for the Sauce Labs Real Device Access API (rdc/v2).
 *
 * Docs: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-integration-guide/
 * OpenAPI spec: https://github.com/saucelabs/real-device-api/blob/main/open_api_specification.yaml
 */

// Accepts the hostname form (eu-central-1) and the form other Sauce tools use (EU_CENTRAL).
const REGIONS = {
    'eu-central-1': 'eu-central-1',
    eu_central: 'eu-central-1',
    eu: 'eu-central-1',
    'us-west-1': 'us-west-1',
    us_west: 'us-west-1',
    us: 'us-west-1',
    'us-east-4': 'us-east-4',
    us_east: 'us-east-4',
};

const APP_URLS = {
    'eu-central-1': 'https://app.eu-central-1.saucelabs.com',
    'us-west-1': 'https://app.saucelabs.com',
    'us-east-4': 'https://app.us-east-4.saucelabs.com',
};

export function sauceRegion(raw = process.env.SAUCE_REGION || 'eu-central-1') {
    const region = REGIONS[raw.trim().toLowerCase()];
    if (!region) {
        throw new Error(`Unknown SAUCE_REGION '${raw}'. Use one of: ${Object.keys(REGIONS).join(', ')}`);
    }
    return region;
}

/** Link to a recorded test (job) in the Sauce Labs UI. */
export function testUrl(jobId, region = sauceRegion()) {
    return `${APP_URLS[region]}/tests/${jobId}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AccessApi {
    constructor({
        username = process.env.SAUCE_USERNAME,
        accessKey = process.env.SAUCE_ACCESS_KEY,
        region = sauceRegion(),
    } = {}) {
        if (!username || !accessKey) {
            throw new Error('SAUCE_USERNAME and SAUCE_ACCESS_KEY must be set (system env or .env)');
        }
        this.region = region;
        // SAUCE_API_URL overrides the region host (non-standard endpoints, local mocks).
        const host = (process.env.SAUCE_API_URL || `https://api.${region}.saucelabs.com`).replace(/\/+$/, '');
        this.baseUrl = `${host}/rdc/v2`;
        this.authHeader = `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;
    }

    async request(method, path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                Authorization: this.authHeader,
                ...(body !== undefined && { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`${method} ${path} failed: HTTP ${res.status} ${text}`);
        }
        if (!text) return null; // e.g. 204 from enableNetworkCapture
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    // ---------- Session lifecycle ----------

    /** Allocates a device. `deviceName` may be an exact descriptor or a regex; omit it for any device. */
    async createSession({ os = 'ios', deviceName, sessionDuration = 'PT30M' } = {}) {
        const session = await this.request('POST', '/sessions', {
            device: { os, ...(deviceName && { deviceName }) },
            configuration: { sessionDuration },
        });
        return session.id ?? session.sessionId;
    }

    getSession(sessionId) {
        return this.request('GET', `/sessions/${sessionId}`);
    }

    async waitForSessionActive(sessionId, { timeoutMs = 10 * 60_000, intervalMs = 5_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const session = await this.getSession(sessionId);
            if (session.state === 'ACTIVE') return session;
            if (['ERRORED', 'CLOSING', 'CLOSED'].includes(session.state)) {
                throw new Error(`Session ${sessionId} is ${session.state}: ${JSON.stringify(session.error)}`);
            }
            if (Date.now() > deadline) {
                throw new Error(`Session ${sessionId} is still ${session.state} after ${timeoutMs / 1000}s`);
            }
            await sleep(intervalMs);
        }
    }

    /** Releases the device and waits (up to 1 minute) until the session is CLOSED. */
    async closeSession(sessionId) {
        await this.request('DELETE', `/sessions/${sessionId}`);
        for (let i = 0; i < 12; i++) {
            const { state } = await this.getSession(sessionId).catch(() => ({ state: 'UNKNOWN' }));
            if (state === 'CLOSED') return state;
            await sleep(5_000);
        }
        return 'NOT_CLOSED_YET';
    }

    // ---------- Device ----------

    enableNetworkCapture(sessionId) {
        return this.request('POST', `/sessions/${sessionId}/device/enableNetworkCapture`);
    }

    disableNetworkCapture(sessionId) {
        return this.request('POST', `/sessions/${sessionId}/device/disableNetworkCapture`);
    }

    /** Installs an app from App Storage and waits until the installation is FINISHED. */
    async installApp(sessionId, app, { launchAfterInstall = true, networkCapture = true, timeoutMs = 5 * 60_000 } = {}) {
        const { installationId } = await this.request('POST', `/sessions/${sessionId}/device/installApp`, {
            app,
            enableInstrumentation: true, // required for iOS (re-signs the app)
            launchAfterInstall,
            features: { networkCapture },
        });
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const { appInstallations = [] } = await this.request(
                'POST',
                `/sessions/${sessionId}/device/listAppInstallations`,
            );
            const install = appInstallations.find((i) => i.installationId === installationId);
            if (install?.status === 'FINISHED') return install;
            if (install?.status === 'ERROR' || Date.now() > deadline) {
                throw new Error(`Installing ${app} did not finish: ${JSON.stringify(install)}`);
            }
            await sleep(5_000);
        }
    }

    // ---------- Appium & test recording ----------

    /** Starts the Sauce-hosted Appium server for the session. Returns { url, appiumVersion, ... }. */
    async startAppiumServer(sessionId, appiumVersion = 'latest') {
        const server = await this.request('POST', `/sessions/${sessionId}/appiumserver`, { appiumVersion });
        if (!server?.url) throw new Error(`Could not start the Appium server: ${JSON.stringify(server)}`);
        return server;
    }

    /** Starts recording a test (video etc.). Returns the jobId of the test in Sauce Labs. */
    async startTest(sessionId, { testName, build, tags = [], artifacts } = {}) {
        const response = await this.request('POST', `/sessions/${sessionId}/startTest`, {
            testName,
            build,
            tags,
            artifacts: artifacts ?? {
                video: true,
                screenshots: true,
                deviceLogs: true,
                networkCapture: true,
                appiumLogs: true,
            },
        });
        if (!response?.jobId) throw new Error(`startTest returned no jobId: ${JSON.stringify(response)}`);
        return response.jobId;
    }

    endTest(sessionId, status) {
        return this.request('POST', `/sessions/${sessionId}/endTest`, { status });
    }
}
