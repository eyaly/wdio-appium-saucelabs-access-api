/**
 * PawKnits login + live network inspection.
 *
 * Every login attempt makes the app send a POST to httpbin.org (see the PawKnits README):
 *   success -> /anything/pawknits/login (200), wrong password -> /status/401, locked -> /status/403
 *
 * `network` (set up in the config's `before` hook) prints each request/response live from the
 * Access API Companion socket; here we also wait for the login request and assert on it.
 */
import { har } from '../../lib/network-monitor.js';

const LOGIN_REQUEST = /httpbin\.org\/(anything\/pawknits\/login|status\/\d{3})$/;

const $id = (id) => $(`~${id}`);

/** Waits for the next login request captured after `since` and checks what every login request must have. */
async function expectLoginRequest(since, { status, username }) {
    const entry = await network.waitFor(
        (e) => e.request.method === 'POST' && LOGIN_REQUEST.test(e.request.url),
        { since, timeout: 30_000, description: 'PawKnits login request' },
    );

    expect(har.status(entry)).toBe(status);
    expect(har.header(entry.request.headers, 'X-App')).toBe('PawKnits');

    const body = har.requestJson(entry);
    if (body) {
        // postData may be missing from some captures; only assert when it is there.
        expect(body).toEqual({ event: 'login', username, success: status === 200 });
        expect(JSON.stringify(body)).not.toContain('woof1234'); // the password is never sent
    }
    return entry;
}

describe('PawKnits login - network capture via the Access API', () => {
    before(async () => {
        await $id('login_screen').waitForDisplayed({ timeout: 30_000 });
    });

    it('wrong password -> POST /status/401', async () => {
        await $id('demo_user_valid').click(); // fills doglover / woof1234
        const since = network.mark();
        await $id('login_password').setValue('wrong-password\n'); // Return submits the form

        await expectLoginRequest(since, { status: 401, username: 'doglover' });
        await expect($id('login_error')).toHaveText('Username and password do not match any user');
    });

    it('locked-out user -> POST /status/403', async () => {
        await $id('demo_user_locked').click();
        const since = network.mark();
        await $id('login_button').click();

        await expectLoginRequest(since, { status: 403, username: 'locked' });
        await expect($id('login_error')).toHaveText('Sorry, this account has been locked out.');
    });

    it('valid user -> POST /anything/pawknits/login (200)', async () => {
        await $id('demo_user_valid').click();
        const since = network.mark();
        await $id('login_button').click();

        const entry = await expectLoginRequest(since, { status: 200, username: 'doglover' });
        // httpbin /anything echoes the request back, so the response body shows what the server received.
        expect(entry.request.url).toMatch(/\/anything\/pawknits\/login$/);
        await expect($id('shop_screen')).toBeDisplayed();
    });
});
