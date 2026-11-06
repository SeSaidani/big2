import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice, alertState, firstPrompt, urlBase64ToBytes, howToAllow } from '../src/push-client.js';

// Real user-agent strings, as the browsers send them.
const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  ipadAsMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};
const env = (userAgent, extra = {}) => ({
  userAgent,
  platform: 'x',
  maxTouchPoints: 0,
  standalone: false,
  hasPush: true,
  ...extra,
});

test('phones and computers are told apart, with a name people recognise', () => {
  const cases = [
    [env(UA.androidChrome), { os: 'android', label: 'Android phone, Chrome' }],
    [env(UA.samsung), { os: 'android', label: 'Android phone, Samsung Internet' }],
    [env(UA.androidFirefox), { os: 'android', label: 'Android phone, Firefox' }],
    [env(UA.iphoneSafari), { os: 'ios', label: 'iPhone, Safari' }],
    [env(UA.iphoneChrome), { os: 'ios', label: 'iPhone, Chrome' }],
    [env(UA.ipadAsMac, { platform: 'MacIntel', maxTouchPoints: 5 }), { os: 'ios', label: 'iPad, Safari' }],
    [env(UA.windowsEdge), { os: 'other', label: 'Computer, Edge' }],
    [env(UA.macSafari, { platform: 'MacIntel' }), { os: 'other', label: 'Computer, Safari' }], // a real Mac has no touch
  ];
  for (const [e, want] of cases) {
    const d = describeDevice(e);
    assert.equal(d.os, want.os, e.userAgent);
    assert.equal(d.label, want.label, e.userAgent);
  }
  assert.equal(describeDevice(env('')).os, 'other');
  assert.equal(describeDevice({}).label, 'Computer, this browser');
});

test('an iPhone or iPad can only get alerts from the Home Screen icon', () => {
  const safariTab = describeDevice(env(UA.iphoneSafari));
  assert.equal(safariTab.needsInstall, true);
  assert.equal(safariTab.canPush, false);
  const homeScreen = describeDevice(env(UA.iphoneSafari, { standalone: true }));
  assert.equal(homeScreen.needsInstall, false);
  assert.equal(homeScreen.canPush, true);
  // Android and computers never need installing.
  assert.equal(describeDevice(env(UA.androidChrome)).needsInstall, false);
  assert.equal(describeDevice(env(UA.androidChrome)).canPush, true);
  // A browser with no push support cannot, installed or not.
  assert.equal(describeDevice(env(UA.androidChrome, { hasPush: false })).canPush, false);
  assert.equal(describeDevice(env(UA.iphoneSafari, { standalone: true, hasPush: false })).canPush, false);
});

test('what the alerts screen shows, for every combination', () => {
  const android = describeDevice(env(UA.androidChrome));
  const iphoneTab = describeDevice(env(UA.iphoneSafari));
  const iphoneApp = describeDevice(env(UA.iphoneSafari, { standalone: true }));
  const old = describeDevice(env(UA.androidChrome, { hasPush: false }));
  const s = (d, permission, subscribed) => alertState(d, { permission, subscribed });
  assert.equal(s(android, 'default', false), 'off');
  assert.equal(s(android, 'granted', true), 'on');
  assert.equal(s(android, 'granted', false), 'resubscribe', 'allowed, but the subscription was lost');
  assert.equal(s(android, 'denied', false), 'blocked');
  assert.equal(s(android, 'denied', true), 'blocked');
  assert.equal(s(iphoneTab, 'default', false), 'install', 'nothing else matters until it is on the Home Screen');
  assert.equal(s(iphoneTab, 'granted', true), 'install');
  assert.equal(s(iphoneApp, 'default', false), 'off');
  assert.equal(s(iphoneApp, 'granted', true), 'on');
  assert.equal(s(old, 'default', false), 'unsupported');
});

test('who is offered alerts without asking: iPhones the steps once, phones a one-tap bar, nobody twice', () => {
  const android = describeDevice(env(UA.androidChrome));
  const iphoneTab = describeDevice(env(UA.iphoneSafari));
  const iphoneApp = describeDevice(env(UA.iphoneSafari, { standalone: true }));
  const computer = describeDevice(env(UA.windowsEdge));
  const fresh = { iosHelpSeen: false, dismissed: false };
  assert.equal(firstPrompt(android, 'off', fresh), 'banner');
  assert.equal(firstPrompt(iphoneApp, 'off', fresh), 'banner');
  assert.equal(firstPrompt(iphoneTab, 'install', fresh), 'ios-help');
  assert.equal(
    firstPrompt(iphoneTab, 'install', { iosHelpSeen: true, dismissed: false }),
    null,
    'shown once per device',
  );
  assert.equal(firstPrompt(android, 'off', { iosHelpSeen: false, dismissed: true }), null, '"not now" is respected');
  assert.equal(firstPrompt(computer, 'off', fresh), null, 'computers use the menu');
  for (const state of ['on', 'resubscribe', 'blocked', 'unsupported']) {
    assert.equal(firstPrompt(android, state, fresh), null, `${state}: nothing to offer`);
  }
});

test('the sender key is decoded from base64url', () => {
  const bytes = urlBase64ToBytes(Buffer.from([4, 251, 255, 0, 62]).toString('base64url'));
  assert.deepEqual([...bytes], [4, 251, 255, 0, 62]);
  assert.equal(urlBase64ToBytes('').length, 0);
});

test('every phone and browser gets plain steps for allowing alerts, in words that match what it has', () => {
  const steps = (ua, extra) => howToAllow(describeDevice(env(ua, extra)));
  const text = (h) => h.steps.join(' ');
  const chrome = steps(UA.androidChrome);
  assert.equal(chrome.title, 'How to allow alerts in Chrome on Android');
  // Step 1 says where the dialog is, because the instructions are useless if you cannot find the box.
  assert.match(chrome.steps[0], /tap your name at the top right of the game, then Turn alerts/);
  assert.match(chrome.steps[0], /Allow notifications\?/, 'it says what the question will look like');
  // The order that worked on a phone where Chrome had the site on Block: reset the site, then the master switch,
  // then Android's own switch, then refresh.
  assert.match(chrome.steps[1], /three dots.*Settings.*Site settings.*All sites.*Delete & reset/);
  assert.match(chrome.steps[1], /signed out: sign in again/, 'it warns that resetting signs you out');
  assert.match(chrome.steps[2], /Site settings.*Notifications.*switch at the top.*Blocked.*Allow/);
  assert.match(chrome.steps[2], /padlock/, 'and the quick route');
  assert.match(chrome.steps[3], /Settings app.*Apps.*All notifications.*Sites/);
  assert.match(chrome.steps[4], /refresh/);
  assert.equal(chrome.steps.length, 5);

  const samsung = steps(UA.samsung);
  assert.match(samsung.title, /Samsung Internet/);
  assert.match(text(samsung), /Sites and downloads/);
  assert.match(text(samsung), /Settings app.*Apps/, 'Samsung Internet gets the Android-level step too');
  const firefox = steps(UA.androidFirefox);
  assert.match(firefox.title, /Firefox on Android/);
  assert.match(text(firefox), /Reset permissions/);
  assert.match(text(firefox), /Settings app.*Apps/);

  const iphoneTab = steps(UA.iphoneSafari);
  assert.match(text(iphoneTab), /Add to Home Screen/, 'in Safari the first step is the Home Screen');
  assert.match(text(iphoneTab), /Settings app.*Notifications.*Big Two/);
  const iphoneApp = steps(UA.iphoneSafari, { standalone: true });
  assert.ok(!/Add the game to the Home Screen first/.test(text(iphoneApp)), 'from the icon that step is not needed');
  assert.match(text(iphoneApp), /Home Screen icon, not from Safari/);
  assert.match(text(iphoneApp), /Focus/);

  assert.match(steps(UA.windowsEdge).title, /this browser/);
  assert.match(steps(UA.macSafari, { platform: 'MacIntel' }).title, /Safari/);

  // Every device is told where the dialog is, and gets plain sentences with nothing undefined.
  for (const ua of Object.values(UA)) {
    const h = steps(ua);
    assert.ok(h.title.length > 10 && h.steps.length >= 3, ua);
    assert.ok(
      h.steps.some((s) => /tap your name at the top right of the game, then Turn alerts/.test(s)),
      ua,
    );
    for (const s of h.steps) assert.ok(typeof s === 'string' && s.length > 20 && !s.includes('undefined'), s);
  }
  assert.ok(howToAllow(describeDevice({})).steps.length >= 3, 'even an unknown browser');
});
