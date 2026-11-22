/**
 * Sauce Labs Real Device Access API (iOS, PawKnits) - session lifecycle only:
 *
 *   start session -> enable network capture -> start recording
 *   -> install PawKnits (instrumented) -> hold RECORD_SECONDS -> end recording
 *   -> disable network capture -> end session
 *
 * The device is always released, also on errors and Ctrl+C.
 */
import { AccessApi, testUrl } from './lib/access-api.js';

try {
    process.loadEnvFile(); // .env in the project root, if present (system env vars win)
} catch {
    /* no .env */
}

const env = process.env;
const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [access-api] ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const accessApi = new AccessApi();
let sessionId;
let recording = false;
let released = false;

async function release(status) {
    if (released || !sessionId) return;
    released = true;
    if (recording) {
        await accessApi.endTest(sessionId, status).catch((e) => log(`WARNING: endTest failed: ${e.message}`));
        log(`Recording ended - ${status}`);
    }
    await accessApi.disableNetworkCapture(sessionId).catch(() => {});
    log(`Ending session ${sessionId}`);
    try {
        log(`Session ${sessionId} is ${await accessApi.closeSession(sessionId)}`);
    } catch (err) {
        log(`WARNING: could not end session ${sessionId}: ${err.message}`);
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
        log(`${signal} received, releasing the device…`);
        await release('failed');
        process.exit(130);
    });
}

try {
    log(`Data center: ${accessApi.region}`);

    sessionId = await accessApi.createSession({
        os: 'ios',
        deviceName: env.IOS_DEVICE || undefined, // exact name or regex; empty = any iOS device
        sessionDuration: env.ACCESS_API_SESSION_DURATION || 'PT30M',
    });
    log(`Session ${sessionId} created, waiting for a device…`);

    const session = await accessApi.waitForSessionActive(sessionId);
    log(`Session is ACTIVE on ${session.device?.descriptor ?? session.device?.deviceName} (iOS ${session.device?.osVersion ?? '?'})`);
    if (session.links?.liveViewUrl) log(`Live View: ${session.links.liveViewUrl}`);

    // Before the install: capture only records connections opened after it starts.
    await accessApi.enableNetworkCapture(sessionId);
    log('Network capture enabled');

    // Start recording before the install, so the installation is in the video.
    const testName = env.SAUCE_TEST_NAME || 'PawKnits - Access API';
    const jobId = await accessApi.startTest(sessionId, {
        testName,
        build: env.SAUCE_BUILD_NAME || `PawKnits Access API ${new Date().toISOString().slice(0, 19)}`,
        tags: ['access-api', 'ios', 'network-capture'],
    });
    recording = true;
    log(`Recording started: ${testName} (job ${jobId}) - ${testUrl(jobId, accessApi.region)}`);

    const app = env.IOS_APP || 'storage:filename=PawKnits.ipa';
    log(`Installing ${app} (instrumentation enabled)…`);
    await accessApi.installApp(sessionId, app);
    log('App installed');

    const seconds = Number(env.RECORD_SECONDS) || 60;
    log(`Recording for ${seconds}s - use the app in Live View now`);
    await sleep(seconds * 1000);

    await release('passed');
} catch (err) {
    log(`ERROR: ${err.message}`);
    await release('failed');
    process.exitCode = 1;
}
