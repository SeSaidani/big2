// The sign-in page: all a visitor gets before they are signed in. It talks to the same
// /api/login routes as the game used to; on success the cookie is set and a reload brings the game.
const $ = (id) => document.getElementById(id);
const show = (id, on) => {
  $(id).hidden = !on;
};

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* an error page, not JSON */
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

async function attempt(fn) {
  $('err').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('err').textContent = err.message;
    return;
  }
  location.reload();
}

const name = () => $('name').value.trim();

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  attempt(() =>
    code
      ? call('POST', '/api/login/verify', { name: name(), code })
      : call('POST', '/api/login', { name: name(), password: $('pw').value }),
  );
});

$('registerBtn').addEventListener('click', () =>
  attempt(() => call('POST', '/api/register', { name: name(), password: $('pw').value, phone: $('phone').value })),
);

// The server answers the same for any name, so this says "if" rather than confirming anything.
$('codeBtn').addEventListener('click', async () => {
  $('err').textContent = '';
  if (!name()) {
    $('err').textContent = 'Enter your name first.';
    return;
  }
  try {
    await call('POST', '/api/login/code', { name: name() });
  } catch (err) {
    $('err').textContent = err.message;
    return;
  }
  show('codeField', true);
  $('err').textContent = 'If that account exists, a code is on its way. Enter it below.';
  $('code').focus();
});

async function init() {
  let config = { registrationOpen: false, codeLogin: false };
  try {
    config = await call('GET', '/api/config');
  } catch {
    /* password sign-in still works without it */
  }
  show('codeBtn', !!config.codeLogin);
  show('registerBtn', !!config.registrationOpen);
  show('phoneField', !!config.registrationOpen);
  // Only registration needs explaining; with it closed the page is just the logo and the form.
  show('help', !!config.registrationOpen);
  $('help').textContent = config.registrationOpen
    ? 'Sign in, or create an account (3-20 letters, digits, _ or -; password of at least 10 characters).'
    : '';
  $('name').focus();
}
init();
