// Turn alerts in the browser: what kind of device this is, whether it can get alerts, and turning them on
// and off. The decisions are plain functions (tested in node); only the last few touch the browser.

// ---- what this device is ----
// `env` is { userAgent, platform, maxTouchPoints, standalone, hasPush }; pass the browser's own values.
export function describeDevice(env) {
  const ua = String(env.userAgent || '');
  const iPadOnMac = env.platform === 'MacIntel' && Number(env.maxTouchPoints) > 1; // iPadOS says it is a Mac
  const os = /iPhone|iPad|iPod/.test(ua) || iPadOnMac ? 'ios' : /Android/.test(ua) ? 'android' : 'other';
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /CriOS|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'this browser';
  const kind =
    os === 'ios' ? (/iPad/.test(ua) || iPadOnMac ? 'iPad' : 'iPhone') : os === 'android' ? 'Android phone' : 'Computer';
  // On an iPhone or iPad, alerts only work for a site opened from its Home Screen icon.
  const needsInstall = os === 'ios' && !env.standalone;
  return {
    os,
    browser,
    label: `${kind}, ${browser}`,
    standalone: !!env.standalone,
    needsInstall,
    canPush: !!env.hasPush && !needsInstall,
  };
}

// What to show and offer right now.
//   install      iPhone or iPad, in Safari: add the site to the Home Screen first
//   unsupported  this browser cannot do alerts at all
//   blocked      the person (or the phone) said no: it has to be undone in the settings
//   resubscribe  allowed, but this device lost its subscription: quietly make a new one
//   on           alerts are on for this device
//   off          alerts can be turned on
export function alertState(device, { permission, subscribed }) {
  if (device.needsInstall) return 'install';
  if (!device.canPush) return 'unsupported';
  if (permission === 'denied') return 'blocked';
  if (permission === 'granted') return subscribed ? 'on' : 'resubscribe';
  return 'off';
}

// Step-by-step instructions for allowing alerts on THIS phone and browser, for when the question never appears or
// was answered No. Menu names differ a little between phones and versions, so the last step is a general fallback.
export function howToAllow(device) {
  const press = 'Press Turn on alerts. If the phone asks "Allow notifications?", tap Allow.';
  const back = 'Come back to this page and press Turn on alerts again.';
  if (device.os === 'ios') {
    return {
      title: 'How to allow alerts on an iPhone or iPad',
      steps: [
        device.needsInstall
          ? 'Add the game to the Home Screen first: in Safari tap the Share button, then Add to Home Screen, then Add. Open Big Two from its new icon and sign in there.'
          : 'Make sure you opened Big Two from its Home Screen icon, not from Safari.',
        press,
        "If it never asked, or you tapped Don't Allow: open the phone's Settings app, tap Notifications, find Big Two in the list, and switch on Allow Notifications.",
        'If Big Two is not in that list: delete its Home Screen icon, add the game to the Home Screen again, open it, sign in, and press Turn on alerts.',
        'Not hearing anything? A Focus or Do Not Disturb can hide alerts: open Settings, then Focus, and allow Big Two.',
      ],
    };
  }
  if (device.os === 'android') {
    const settings =
      "Still nothing? Open the phone's Settings, then Apps, find your browser, tap Notifications, and make sure they are switched on.";
    if (device.browser === 'Samsung Internet') {
      return {
        title: 'How to allow alerts in Samsung Internet',
        steps: [
          press,
          'If nothing appeared: tap the menu (three lines), then Settings, then Sites and downloads, then Notifications.',
          'Find this site in the list and switch it on (or switch on notifications at the top).',
          back,
          settings,
        ],
      };
    }
    if (device.browser === 'Firefox') {
      return {
        title: 'How to allow alerts in Firefox on Android',
        steps: [
          press,
          'If nothing appeared: tap the padlock at the left of the address bar, then Permissions (or Edit site settings), then Notifications, and choose Allow.',
          back,
          settings,
        ],
      };
    }
    return {
      title: 'How to allow alerts in Chrome on Android',
      steps: [
        press,
        'If nothing appeared: tap the padlock (or the small settings icon) at the left of the address bar.',
        'Tap Permissions (or Site settings), then Notifications, and choose Allow.',
        back,
        settings,
      ],
    };
  }
  if (device.browser === 'Firefox') {
    return {
      title: 'How to allow alerts in Firefox',
      steps: [
        press,
        'If nothing appeared: click the padlock at the left of the address bar, then Permissions, then Notifications, and allow.',
        back,
      ],
    };
  }
  if (device.browser === 'Safari') {
    return {
      title: 'How to allow alerts in Safari',
      steps: [
        press,
        'If nothing appeared: open Safari, then Settings, then Websites, then Notifications, and set this site to Allow.',
        back,
      ],
    };
  }
  return {
    title: 'How to allow alerts in this browser',
    steps: [
      press,
      'If nothing appeared: click the padlock (or the small settings icon) at the left of the address bar, find Notifications, and choose Allow.',
      back,
    ],
  };
}

// The first-time prompts: where to offer alerts without being asked.
//   'ios-help'  an iPhone in Safari that has not been shown how to add the site to the Home Screen
//   'banner'    a phone that can turn alerts on with one tap, and has not said "not now"
//   null        nothing: everything else is in the account menu
export function firstPrompt(device, state, { iosHelpSeen, dismissed }) {
  if (state === 'install') return iosHelpSeen ? null : 'ios-help';
  if (state === 'off' && (device.os === 'android' || device.os === 'ios') && !dismissed) return 'banner';
  return null;
}

export const urlBase64ToBytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---- the browser itself ----
export function browserEnv() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches,
    hasPush: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  };
}

export const permission = () => ('Notification' in window ? Notification.permission || 'default' : 'denied');

export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function currentSubscription() {
  const reg = await registerWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Makes this device's subscription (or keeps the one it has) and tells the server about it. The server
// answers with the devices now on, so the screen can be redrawn from that.
async function subscribeAndRegister(api, device) {
  const reg = await registerWorker();
  const { publicKey } = await api.push();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made under a different sender key can never receive our messages: replace it.
  if (sub && sub.options && sub.options.applicationServerKey) {
    const have = new Uint8Array(sub.options.applicationServerKey);
    const want = urlBase64ToBytes(publicKey);
    if (have.length !== want.length || have.some((b, i) => b !== want[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
  return api.pushSubscribe(sub.toJSON(), device.label);
}

// Called from a tap. The permission question must be asked first, straight from the tap: some browsers
// (iPhone especially) refuse it after any waiting.
export async function turnOn(api, device) {
  const answer = await Notification.requestPermission();
  if (answer !== 'granted') return { permission: answer };
  return { permission: answer, ...(await subscribeAndRegister(api, device)) };
}

export async function turnOff(api) {
  const sub = await currentSubscription();
  const endpoint = sub && sub.endpoint;
  if (sub) await sub.unsubscribe();
  return endpoint ? api.pushUnsubscribe(endpoint) : api.push();
}

// Alerts off on every device of mine: this browser forgets its subscription too, so it cannot sign itself back up.
export async function turnOffAll(api) {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
  return api.pushUnsubscribeAll();
}

// On every sign-in where alerts are allowed: make sure the server has this device (it loses it if the
// browser rotated the subscription), without asking the person anything.
export const syncSubscription = (api, device) => subscribeAndRegister(api, device);
