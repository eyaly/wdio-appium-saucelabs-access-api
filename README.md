# wdio-appium-saucelabs-access-api

WebdriverIO + Appium test for the [PawKnits iOS app](https://github.com/eyaly/PawKnits-iOS) on a
Sauce Labs **real iOS device**, using the
[Real Device Access API](https://docs.saucelabs.com/mobile-apps/rdc-access-api/real-device-access-api-introduction)
to reserve the device and **print the app's network traffic live** while the test logs in.

Simple on purpose: one config, one spec, no page objects.

## How it works

| When | What | Where |
| --- | --- | --- |
| Once, before the tests | Reserve an iOS device (`POST /sessions`), wait for `ACTIVE`, `enableNetworkCapture`, install PawKnits from App Storage, start the Sauce-hosted Appium server | `onPrepare` in `config/wdio.access-api.conf.js` |
| Per spec file | `startTest` (video, logs, HAR are recorded as one Sauce Labs test), connect WebdriverIO to the hosted Appium server | `beforeSession` |
| Per spec file | Connect to the session's **Companion socket** and print every `device.har.entry` (request + response) the moment it arrives | `before` → `lib/network-monitor.js` |
| Tests | Log in 3 times; for each login wait for the captured request and assert on it | `test/specs/login.spec.js` |
| After | `endTest`, `disableNetworkCapture`, release the device (also on Ctrl+C) | `afterSession`, `onComplete` |

Each PawKnits login sends a POST to httpbin.org (see the app's README):

| Test | Captured request | Status |
| --- | --- | --- |
| Wrong password | `POST https://httpbin.org/status/401` | 401 |
| Locked-out user | `POST https://httpbin.org/status/403` | 403 |
| Valid user | `POST https://httpbin.org/anything/pawknits/login` | 200 |

The tests check the status, the `X-App: PawKnits` header, the JSON body, and that the password is
never sent.

## Setup

Requirements: Node.js 22+, a Sauce Labs **Enterprise** account (the Access API is Enterprise-only),
and `PawKnits.ipa` in [App Storage](https://docs.saucelabs.com/mobile-apps/app-storage/) (the
unsigned IPA from `./scripts/build-ipa.sh` is enough; Sauce Labs re-signs it).

```bash
npm install
cp .env.example .env   # optional: settings below can also be system env vars
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` | — | Credentials |
| `SAUCE_REGION` | `eu-central-1` | `eu-central-1`, `us-west-1` or `us-east-4` |
| `IOS_APP` | `storage:filename=PawKnits.ipa` | App in App Storage |
| `IOS_DEVICE` | any iOS device | Exact device name or regex, e.g. `iPhone_16_real` or `iPhone.*` |
| `NETWORK_FILTER` | `httpbin\.org` | Regex on the URL of entries to print. Empty = all device traffic |
| `NETWORK_DEBUG` | — | `1` also prints the raw Companion socket message |
| `NETWORK_MAX_BODY` | `2000` | Max characters printed per body |
| `ACCESS_API_SESSION_DURATION` | `PT30M` | Safety net: the device is released after this even if the run dies |

## Run

```bash
npm test                     # login tests + live network output (PawKnits traffic only)
npm run test:all-traffic     # print every request the device makes
npm run test:debug-network   # also print the raw socket messages
```

Live output looks like this:

```
[0-0] ┌─ [network] POST https://httpbin.org/anything/pawknits/login
[0-0] │ ▶ Request
[0-0]     Content-Type: application/json
[0-0]     X-App: PawKnits
[0-0]     body:
[0-0]       { "event": "login", "success": true, "username": "doglover" }
[0-0] │ ◀ Response 200 OK (187 ms)
[0-0]     Content-Type: application/json
[0-0]     body:
[0-0]       { "json": { ... }, "url": "https://httpbin.org/anything/pawknits/login" }
[0-0] └─
```

The run also prints the Live View URL of the device and a link to the recorded test, where the
full HAR is in the **Network** tab.

## Using the monitor in your own tests

`network` is a global in every spec:

```js
import { har } from '../../lib/network-monitor.js';

const since = network.mark();                       // only look at traffic from now on
await $('~login_button').click();
const entry = await network.waitFor(
    (e) => e.request.url.endsWith('/pawknits/login'),
    { since, timeout: 30_000 },
);
expect(har.status(entry)).toBe(200);
expect(har.requestJson(entry).username).toBe('doglover');
```

## Notes

- The docs only define the `type` field of Companion socket messages, so `extractHarEntry()`
  accepts the HAR entry at the top level or nested (`entry`, `data`, …). If a run prints
  "without a recognizable HAR entry", run `npm run test:debug-network` and adjust that function.
- Network capture needs iOS 14+, no SSL pinning (PawKnits has none), and only records connections
  opened after capture starts. That's why capture is enabled before the app is installed.
- Capture is system-wide, so `NETWORK_FILTER` keeps the output to the app's own traffic.

## Docs

- [Companion socket (live logs and HAR)](https://docs.saucelabs.com/mobile-apps/rdc-access-api/real-device-access-api-mastering-companion-socket)
- [Sauce-hosted Appium](https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/)
- [Test results (startTest / endTest)](https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/)
- [Network capture on real devices](https://docs.saucelabs.com/mobile-apps/features/network-capture)
- [Access API OpenAPI spec](https://github.com/saucelabs/real-device-api/blob/main/open_api_specification.yaml)
