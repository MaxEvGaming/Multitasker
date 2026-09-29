// The claim is that whoever runs the server cannot read what is on a board.
// This checks it the only way worth checking: by being the operator. It opens
// the database directly, reads every column that could hold something readable,
// and looks for the words it knows were typed.
import pg from 'pg';
import {
  createKeys, subKeysFrom, encryptText, decryptText, blindIndex, toB64,
} from '../public/crypto.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3040';

let cookie = '';
let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function call(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  try { return { status: res.status, data: text ? JSON.parse(text) : null }; }
  catch (_) { return { status: res.status, data: text }; }
}

const PASSWORD = 'a-long-enough-password';
const SECRETS = {
  title: '請求書の突き合わせ',
  session: 'BillingReconcile',
  page: '経理まわり',
  state: 'レビュー待ち',
};

console.log('an account whose keys never leave here');
const keys = await createKeys(PASSWORD);
const { dataKey, indexKey } = await subKeysFrom(keys.masterRaw);

let r = await call('/api/register', {
  email: `sealed${Date.now()}@example.com`, password: keys.authToken,
  kdfSalt: keys.kdfSalt,
  wrappedByPassword: keys.wrappedByPassword,
  wrappedByRecovery: keys.wrappedByRecovery,
  recoveryToken: keys.recoveryToken,
});
check('the account was made', r.status === 200, JSON.stringify(r.data));

let board = (await call('/api/board')).data;

console.log('everything readable is sealed before it is sent');
{
  const square = board.tasks[0];
  await call('/api/task', {
    taskId: square.id, page: board.page,
    title: '', matchKey: '',
    titleCipher: await encryptText(dataKey, SECRETS.title),
    nameCipher: await encryptText(dataKey, SECRETS.session),
    matchHash: await blindIndex(indexKey, SECRETS.session),
  });
  await call('/api/page', { id: board.page, name: '', nameCipher: await encryptText(dataKey, SECRETS.page) });

  const state = board.states[0];
  await call('/api/state', {
    id: state.id, name: `#${state.id}`, nameCipher: await encryptText(dataKey, SECRETS.state),
    colour: state.colour, runsTimer: state.runs_timer, leftTo: state.left_to,
    rightTo: state.right_to, autoTo: state.auto_to, startTo: state.start_to,
    sortOrder: state.sort_order,
  });
  check('the writes were accepted', true);
}

console.log('now read the database as the person who runs it');
{
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Every column on every table that could hold something a person typed —
  // scoped to this account. Other accounts in the same database belong to other
  // tests and are deliberately not encrypted; sweeping them in would report
  // their plaintext as this account's leak.
  const { rows: me } = await db.query('select id from users order by id desc limit 1');
  const userId = me[0].id;

  const { rows } = await db.query(`
    select coalesce(string_agg(t, ' | '), '') as everything from (
      select coalesce(title, '') || ' ' || coalesce(title_cipher, '') || ' '
          || coalesce(match_key, '') || ' ' || coalesce(name_cipher, '') || ' '
          || coalesce(match_hash, '') as t from tasks where user_id = $1
      union all select coalesce(name, '') || ' ' || coalesce(name_cipher, '')
        from pages where user_id = $1
      union all select coalesce(name, '') || ' ' || coalesce(name_cipher, '')
        from states where user_id = $1
      union all select coalesce(name, '') || ' ' || coalesce(name_cipher, '')
        from seen_names where user_id = $1
      union all select coalesce(from_state, '') || ' ' || coalesce(to_state, '')
        from moves where user_id = $1
    ) as everything_readable`, [userId]);
  const everything = rows[0].everything;

  for (const [what, secret] of Object.entries(SECRETS)) {
    check(`the ${what} is nowhere in the database`, !everything.includes(secret),
      `found ${JSON.stringify(secret)}`);
  }

  const { rows: userRows } = await db.query(
    `select kdf_salt, wrapped_by_password, wrapped_by_recovery, encryption_version
       from users where id = $1`, [userId]);
  check('the account is marked as encrypted', userRows[0].encryption_version === 1);
  check('the wrapped keys are stored', Boolean(userRows[0].wrapped_by_password)
    && Boolean(userRows[0].wrapped_by_recovery));
  check('the master key itself is not stored',
    !JSON.stringify(userRows[0]).includes(toB64(keys.masterRaw)));

  await db.end();
}

console.log('the board still works without the server understanding it');
{
  // Into the state that has somewhere to go, the way it is actually reached —
  // a sealed instruction — then report a stop the same way. Nothing readable in
  // either.
  const before = (await call('/api/board')).data;
  await call(`/hook/${before.webhookToken}`, {
    matchHash: await blindIndex(indexKey, SECRETS.session),
    nameCipher: await encryptText(dataKey, SECRETS.session),
    event: 'start',
  });

  const running = (await call('/api/board')).data;
  const stateNameOf = (b, id) => (b.states.find((s) => String(s.id) === String(id)) || {}).name;
  const runningState = stateNameOf(running, running.tasks[0].state_id);

  await call(`/hook/${running.webhookToken}`, {
    matchHash: await blindIndex(indexKey, SECRETS.session),
    nameCipher: await encryptText(dataKey, SECRETS.session),
  });

  const after = (await call('/api/board')).data;
  check('a sealed report still moved the square',
    stateNameOf(after, after.tasks[0].state_id) !== runningState,
    `still ${stateNameOf(after, after.tasks[0].state_id)}`);
}

console.log('and the owner can read it all back');
{
  const view = (await call('/api/board')).data;
  check('the title comes back',
    (await decryptText(dataKey, view.tasks[0].title_cipher)) === SECRETS.title);
  check('the session name comes back',
    (await decryptText(dataKey, view.tasks[0].name_cipher)) === SECRETS.session);
  check('the page name comes back',
    (await decryptText(dataKey, view.pages[0].name_cipher)) === SECRETS.page);

  const seen = view.seenNames || [];
  check('the name the board was told is remembered, sealed', seen.length > 0
    && (await decryptText(dataKey, seen[0].name_cipher)) === SECRETS.session,
    JSON.stringify(seen.map((n) => n.name)));
}

console.log('a stranger with the database learns nothing');
{
  const view = (await call('/api/board')).data;
  const { dataKey: strangerKey } = await subKeysFrom(new Uint8Array(32).fill(5));
  check('another key opens none of it',
    (await decryptText(strangerKey, view.tasks[0].title_cipher)) === ''
    && (await decryptText(strangerKey, view.pages[0].name_cipher)) === '');
}

console.log('an account without keys cannot be made at all');
{
  // 鍵の無いアカウントが一つでも存在できると、そのボードは読める状態で立ち上がり、
  // しかも画面のどこにもそうとは出ない。作れないようにするのが唯一の保証。
  const bare = await call('/api/register', {
    email: `bare${Date.now()}@example.com`, password: keys.authToken,
  });
  check('registering with no keys is refused', bare.status === 400, `status ${bare.status}`);

  const half = await call('/api/register', {
    email: `half${Date.now()}@example.com`, password: keys.authToken,
    kdfSalt: keys.kdfSalt, wrappedByPassword: keys.wrappedByPassword,
  });
  check('and so is half of them', half.status === 400, `status ${half.status}`);
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
