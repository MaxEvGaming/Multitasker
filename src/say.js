// What the server says back. Kept apart from the words in the browser because
// these are the few sentences that have to exist on this side: refusals that
// happen before any screen has been drawn, and the body of a test notification.
//
// The language comes from the account when there is one, and from the browser's
// own header when there is not — a wrong password has to be explained before
// anyone has signed in to have a preference.

export const DEFAULT_LANG = 'en';

const EN = {
  'need.signin': 'Please sign in',
  'need.emailPassword': 'Enter an email address and a password',
  'need.longerPassword': 'Passwords must be at least {n} characters',
  'register.closed': 'New registrations are not being accepted',
  'register.taken': 'That email address is already registered',
  'register.badInvite': 'That invitation is not one this board will accept — it may have been used already, or expired',
  'login.tooMany': 'Too many attempts. Wait about {n} minutes and try again',
  'ip.tooMany': 'Too many requests from this address. Wait about {n} minutes and try again',
  'login.wrong': 'That email address or password is wrong',
  'task.noSquare': 'No square was given',
  'state.needName': 'Give the state a name',
  'state.nameTaken': 'There is already a state with that name',
  'state.inUse': 'Some squares are using that state',
  'keys.missing': 'The keys are incomplete',
  'recover.wrongKey': 'That recovery key does not open this account',
  'need.derived': 'This page sent the old shape of request. Reload it.',
  'push.badSubscription': 'That subscription is malformed',
  'push.testTitle': 'Test notification',
  'push.testBody': 'If this arrived, the setup is done',
  'push.suspendedTitle': 'Every PC was disconnected',
  'push.suspendedBody': 'Someone signed in from a new device, so every PC on this account was disconnected. Press Reconnect in the PC program to bring one back.',
  'push.killedBody': 'Every PC on this account was stopped from the board. Press Reconnect in the PC program to bring one back.',
  'server.broken': 'Something went wrong on the server',
  'lang.unknown': 'That is not a language this board speaks',

  // Read on a phone, so they follow the account rather than the server.
  'square': 'Square {n}',
  'why.signal': 'Claude has stopped',
  'why.timeout': 'the expected time has passed',
  'why.unmatched': 'no square matches',
  'why.unknownSession': 'an unknown session',
  'why.where': '{why} ({from} → {to})',
  'page.new': 'New page',
  'page.gone': 'That page is not there',
  'page.lastOne': 'There has to be at least one page',
  'reset.unusable': 'That reset link cannot be used (it has expired, or was already used)',
  'need.longerNewPassword': 'The new password must be at least {n} characters',
  'password.wrongCurrent': 'That is not your current password',
  'password.wrong': 'That password is wrong',
  'email.notAnAddress': 'That does not look like an email address',

  // Command squares. The three "why" lines ring on the phone like the others.
  'why.done': 'the PC finished it',
  'why.failed': 'the PC could not do it',
  'why.expired': 'no PC came for the instruction within 5 seconds',
  'command.needsEncryption': 'Turn on encryption first',
  'command.none': 'That square has no command',
  'command.noStates': 'That square has nowhere to go: pick the three states in its command settings',
  'command.badState': 'That is not one of your states',
  'command.badPc': 'That is not one of your PCs',
  'job.gone': 'That instruction is not open',
  'job.needSealed': 'The instruction has to arrive sealed',
};

const JA = {
  'need.signin': 'ログインしてください',
  'need.emailPassword': 'メールとパスワードを入力してください',
  'need.longerPassword': 'パスワードは{n}文字以上にしてください',
  'register.closed': '新規登録は受け付けていません',
  'register.taken': 'そのメールは登録済みです',
  'register.badInvite': 'その招待は使えません。既に使われたか、期限が切れています',
  'login.tooMany': '試行が多すぎます。{n}分ほど待ってからやり直してください',
  'ip.tooMany': '同じアドレスからの要求が多すぎます。{n}分ほど待ってからやり直してください',
  'login.wrong': 'メールかパスワードが違います',
  'task.noSquare': '枠が指定されていません',
  'state.needName': '状態の名前を入れてください',
  'state.nameTaken': 'その名前の状態が既にあります',
  'state.inUse': 'その状態を使っている枠があります',
  'keys.missing': '鍵が足りません',
  'recover.wrongKey': 'その復旧鍵では、このアカウントは開きません',
  'need.derived': 'このページは古い形のまま送信しました。再読み込みしてください。',
  'push.badSubscription': '購読情報が不正です',
  'push.testTitle': '通知テスト',
  'push.testBody': '届いていれば設定は完了です',
  'push.suspendedTitle': 'PC を全部切りました',
  'push.suspendedBody': '新しい場所からログインがあったので、このアカウントの PC を全部切りました。戻すには、PC のプログラムで「再接続」を押してください。',
  'push.killedBody': '盤から、このアカウントの PC を全部止めました。戻すには、PC のプログラムで「再接続」を押してください。',
  'server.broken': 'サーバー側で問題が起きました',
  'lang.unknown': 'このボードはその言語を話しません',

  'square': '枠 {n}',
  'why.signal': 'Claude が手を止めました',
  'why.timeout': '予想時間を過ぎました',
  'why.unmatched': '対応する枠がありません',
  'why.unknownSession': '不明なセッション',
  'why.where': '{why}（{from} → {to}）',
  'page.new': '新しいページ',
  'page.gone': 'そのページはありません',
  'page.lastOne': 'ページは1つ以上必要です',
  'reset.unusable': 'この再設定リンクは使えません（期限切れか、使用済みです）',
  'need.longerNewPassword': '新しいパスワードは{n}文字以上にしてください',
  'password.wrongCurrent': '今のパスワードが違います',
  'password.wrong': 'パスワードが違います',
  'email.notAnAddress': 'メールアドレスの形になっていません',

  'why.done': 'PC が実行を終えました',
  'why.failed': 'PC で失敗しました',
  'why.expired': '5 秒以内に PC が取りに来ませんでした',
  'command.needsEncryption': '先に暗号化を有効にしてください',
  'command.none': 'その枠にコマンドはありません',
  'command.noStates': 'その枠の行き先がありません。コマンド設定で3つの状態を選んでください',
  'command.badState': 'それはあなたの状態ではありません',
  'command.badPc': 'それはあなたの PC ではありません',
  'job.gone': 'その指示は開いていません',
  'job.needSealed': '指示は封じた形で送ってください',
};

export const BOOKS = { en: EN, ja: JA };

export const isLanguage = (code) => Object.prototype.hasOwnProperty.call(BOOKS, String(code || ''));

export function say(lang, key, vars) {
  const book = BOOKS[lang] || EN;
  let text = book[key];
  if (text === undefined) text = EN[key];
  if (text === undefined) return key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

// Only used before sign-in. The header is a ranked list with weights; the first
// entry this board speaks wins, and English wins by default — including for the
// many browsers that ask for a language nobody here has written.
export function langFromHeader(header) {
  for (const part of String(header || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (isLanguage(tag)) return tag;
  }
  return DEFAULT_LANG;
}
