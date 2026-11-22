/**
 * WebdriverIO + Sauce Labs Real Device Access API (iOS, PawKnits).
 *
 * Launcher (onPrepare, runs once):
 *   reserve an iOS real device -> enable network capture -> install PawKnits -> start the
 *   Sauce-hosted Appium server. The session id and Appium URL are passed to the workers via env.
 * Worker (per spec file):
 *   startTest (video etc.) -> Appium session on the hosted server -> connect to the Companion
 *   socket and print every HAR entry live -> tests -> endTest.
 * Launcher (onComplete / Ctrl+C):
 *   disable network capture and release the device.
 */
import path from 'node:path';
import exitHook from 'async-exit-hook';
import { AccessApi, testUrl } from '../lib/access-api.js';
import { NetworkMonitor } from '../lib/network-monitor.js';

try {
    process.loadEnvFile(); // .env in the project root, if present (system env vars win)
} catch {
    /* no .env */
}

const env = process.env;
const BUNDLE_ID = env.IOS_BUNDLE_ID || 'com.pawknits.demo';
const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [access-api] ${msg}`);

// ---------- launcher state ----------
let launcherApi;
let launcherSessionId;

async function releaseDevice() {
    const sessionId = launcherSessionId;
    if (!sessionId) return;
    launcherSessionId = undefined; // run once, even if both onComplete and the exit hook fire
    await launcherApi.disableNetworkCapture(sessionId).catch(() => {});
    log(`Ending session ${sessionId}`);
    try {
        const state = await launcherApi.closeSession(sessionId);
        log(`Session ${sessionId} is ${state}`);
    } catch (err) {
        log(`WARNING: could not end session ${sessionId}: ${err.message}`);
    }
}

// ---------- worker state ----------
let workerApi;
let jobId;
let testStatus = 'failed';

export const config = {
    runner: 'local',
    specs: ['../test/specs/**/*.spec.js'],
    // One reserved device -> one spec file at a time.
    maxInstances: 1,

    // The Access API session already owns the device and the app is installed,
    // so the hosted Appium server only needs platform + automation name.
    capabilities: [
        {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:newCommandTimeout': 240,
            'sauce:options': {
                name: 'PawKnits',
                sessionCreationTimeout: 420_000, // ms
            },
        },
    ],

    logLevel: 'warn',
    waitforTimeout: 20_000,
    connectionRetryTimeout: 420_000,
    connectionRetryCount: 1,

    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: { ui: 'bdd', timeout: 180_000 },

    // =========================== Launcher hooks ===========================

    onPrepare: async () => {
        launcherApi = new AccessApi();
        exitHook((done) => releaseDevice().finally(done)); // Ctrl+C / crash: never leave the device reserved

        env.SAUCE_BUILD_NAME ||= `PawKnits WDIO Access API ${new Date().toISOString().slice(0, 19)}`;
        log(`Data center: ${launcherApi.region}`);

        launcherSessionId = await launcherApi.createSession({
            os: 'ios',
            deviceName: env.IOS_DEVICE || undefined, // exact name or regex; empty = any iPhone/iPad
            sessionDuration: env.ACCESS_API_SESSION_DURATION || 'PT30M',
        });
        log(`Session ${launcherSessionId} created, waiting for a device…`);

        const session = await launcherApi.waitForSessionActive(launcherSessionId);
        log(`Session is ACTIVE on ${session.device?.descriptor ?? session.device?.deviceName} (iOS ${session.device?.osVersion ?? '?'})`);
        if (session.links?.liveViewUrl) log(`Live View: ${session.links.liveViewUrl}`);

        await launcherApi.enableNetworkCapture(launcherSessionId);
        log('Network capture enabled');

        const app = env.IOS_APP || 'storage:filename=PawKnits.ipa';
        log(`Installing ${app}…`);
        await launcherApi.installApp(launcherSessionId, app);
        log('App installed');

        const appium = await launcherApi.startAppiumServer(launcherSessionId, env.APPIUM_VERSION || 'latest');
        log(`Appium ${appium.appiumVersion ?? ''} server started`);

        // Workers are forked after onPrepare, so they inherit these.
        env.ACCESS_API_SESSION_ID = launcherSessionId;
        env.ACCESS_API_EVENTS_URL =
            session.links?.eventsWebsocketUrl ||
            `wss://api.${launcherApi.region}.saucelabs.com/rdc/v2/socket/companion/${launcherSessionId}`;
        env.APPIUM_URL = appium.url;
    },

    onComplete: async () => {
        await releaseDevice();
    },

    // ============================ Worker hooks ============================

    beforeSession: async (cfg, capabilities, specs) => {
        // Point WebdriverIO at the hosted Appium server of the Access API session.
        const url = new URL(env.APPIUM_URL);
        cfg.protocol = url.protocol.replace(':', '');
        cfg.hostname = url.hostname;
        cfg.port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        cfg.path = url.pathname || '/';
        cfg.user = url.username ? decodeURIComponent(url.username) : undefined;
        cfg.key = url.password ? decodeURIComponent(url.password) : undefined;

        const testName = `PawKnits - ${path.basename(specs[0], '.spec.js')}`;
        capabilities['sauce:options'].name = testName;

        // startTest starts the recording; everything until endTest is one test (video, logs, HAR) in Sauce Labs.
        workerApi = new AccessApi();
        jobId = await workerApi.startTest(env.ACCESS_API_SESSION_ID, {
            testName,
            build: env.SAUCE_BUILD_NAME,
            tags: ['access-api', 'ios', 'wdio', 'network-capture'],
        });
        log(`Recording started: ${testName} (job ${jobId})`);
    },

    before: async () => {
        // Live network monitor, available in specs as the global `network`.
        const network = new NetworkMonitor({
            url: env.ACCESS_API_EVENTS_URL,
            authHeader: workerApi.authHeader,
            filter: env.NETWORK_FILTER === '' ? undefined : new RegExp(env.NETWORK_FILTER || 'httpbin\\.org'),
            debug: env.NETWORK_DEBUG === '1',
            maxBody: Number(env.NETWORK_MAX_BODY) || 2000,
        });
        await network.connect();
        globalThis.network = network;

        // Start every spec file from the login screen.
        await driver.terminateApp(BUNDLE_ID).catch(() => {});
        await driver.activateApp(BUNDLE_ID);
    },

    after: async (result) => {
        testStatus = result === 0 ? 'passed' : 'failed';
        globalThis.network?.close();
    },

    afterSession: async () => {
        if (!jobId) return;
        try {
            await workerApi.endTest(env.ACCESS_API_SESSION_ID, testStatus);
        } catch (err) {
            log(`WARNING: endTest failed: ${err.message}`);
        }
        log(`Recording ended - ${testStatus} - ${testUrl(jobId, workerApi.region)}`);
    },
};
