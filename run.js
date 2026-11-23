/**
 * Sauce Labs Real Device Access API (iOS, PawKnits) + Appium tests:
 *
 *   start session -> enable network capture -> start recording
 *   -> install PawKnits (instrumented) -> start the hosted Appium server
 *   -> create an Appium session -> run the tests one after another -> delete the Appium session
 *   -> end recording -> disable network capture -> end session
 *
 * The device is always released, also on errors and Ctrl+C.
 */
import { remote } from 'webdriverio';
import { AccessApi, testUrl } from './lib/access-api.js';
import { tests } from './tests/login.tests.js';

try {
    process.loadEnvFile(); // .env in the project root, if present (system env vars win)
} catch {
    /* no .env */
}

const env = process.env;
const BUNDLE_ID = env.IOS_BUNDLE_ID || 'com.pawknits.demo';
const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] [access-api] ${msg}`);

const accessApi = new AccessApi();
let sessionId;
let driver; // the Appium (WebDriver) session
let jobId; // the recorded Sauce Labs test, set by startTest
let released = false;

async function release(status) {
    if (released || !sessionId) return;
    released = true;
    if (driver) {
        await driver.deleteSession().catch((e) => log(`WARNING: could not delete the Appium session: ${e.message}`));
        log('Appium session deleted');
    }
    if (jobId) {
        log(`Ending the test recording (endTest, status: ${status})…`);
        try {
            await accessApi.endTest(sessionId, status);
            log(`Test recording ended - ${status}. It's under Access API > Test Results: ${testUrl(jobId, accessApi.region)}`);
        } catch (err) {
            log(`WARNING: endTest failed: ${err.message}`);
        }
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

/** Runs the tests one after another; a failing test does not stop the next one. Returns the number of failures. */
async function runTests() {
    let failed = 0;
    for (const [i, test] of tests.entries()) {
        const label = `Test ${i + 1}/${tests.length}: ${test.name}`;
        log(`${label} - running`);
        const started = Date.now();
        try {
            await test.run(driver);
            log(`${label} - PASSED (${Date.now() - started} ms)`);
        } catch (err) {
            failed++;
            log(`${label} - FAILED: ${err.message}`);
        }
    }
    log(`Tests: ${tests.length - failed} passed, ${failed} failed`);
    return failed;
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
    log(`Starting the test recording (startTest): ${testName}…`);
    jobId = await accessApi.startTest(sessionId, {
        testName,
        build: env.SAUCE_BUILD_NAME || `PawKnits Access API ${new Date().toISOString().slice(0, 19)}`,
        tags: ['access-api', 'ios', 'appium'],
    });
    log(`Test recording started (job ${jobId}): ${testUrl(jobId, accessApi.region)}`);

    const app = env.IOS_APP || 'storage:filename=PawKnits.ipa';
    log(`Installing ${app} (instrumentation enabled)…`);
    await accessApi.installApp(sessionId, app);
    log('App installed');

    // Appium server hosted by Sauce Labs, next to the reserved device.
    const appium = await accessApi.startAppiumServer(sessionId, env.APPIUM_VERSION || 'latest');
    const url = new URL(appium.url);
    log(`Appium server ${appium.version ?? ''} started: ${url.origin}${url.pathname}`);

    // The Access API session already owns the device and the app is installed,
    // so the Appium session only needs the platform and the automation name.
    driver = await remote({
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        // Credentials in the returned URL win; otherwise send your Sauce Labs credentials.
        user: url.username ? decodeURIComponent(url.username) : accessApi.username,
        key: url.password ? decodeURIComponent(url.password) : accessApi.accessKey,
        logLevel: 'warn',
        connectionRetryTimeout: 420_000,
        connectionRetryCount: 1,
        capabilities: {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:newCommandTimeout': 240,
        },
    });
    log(`Appium session ${driver.sessionId} created`);

    // Start from a fresh app (it was launched by the install).
    await driver.terminateApp(BUNDLE_ID).catch(() => {});
    await driver.activateApp(BUNDLE_ID);

    const failed = await runTests();
    await release(failed === 0 ? 'passed' : 'failed');
    if (failed) process.exitCode = 1;
} catch (err) {
    log(`ERROR: ${err.message}`);
    await release('failed');
    process.exitCode = 1;
}
