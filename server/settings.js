import { get, all, run } from './db.js';
import { encrypt, decrypt } from './security.js';

/** Todas as chaves ficam cifradas em repouso. `secret` = nunca volta inteira para o navegador. */
export const SETTING_DEFS = {
  meta_access_token: { label: 'Meta Access Token', secret: true, group: 'meta' },
  google_developer_token: { label: 'Google Developer Token', secret: true, group: 'google' },
  google_client_id: { label: 'Google Client ID', secret: false, group: 'google' },
  google_client_secret: { label: 'Google Client Secret', secret: true, group: 'google' },
  google_login_customer_id: { label: 'Google Login Customer ID (MCC)', secret: false, group: 'google' },
  google_refresh_token: { label: 'Google Refresh Token', secret: true, group: 'google' },
  notify_webhook_url: { label: 'Webhook de alertas (WhatsApp/Slack/Zapier, HTTPS)', secret: true, group: 'notify' },
  notify_telegram_token: { label: 'Telegram Bot Token', secret: true, group: 'notify' },
  notify_telegram_chat: { label: 'Telegram Chat ID', secret: false, group: 'notify' },
};

export function getSetting(key) {
  const row = get('SELECT value_enc FROM settings WHERE key = ?', key);
  if (!row) return '';
  try { return decrypt(row.value_enc); } catch { return ''; }
}

export function setSetting(key, value) {
  if (!(key in SETTING_DEFS)) throw new Error('chave desconhecida');
  if (value === '') return run('DELETE FROM settings WHERE key = ?', key);
  run(
    `INSERT INTO settings (key, value_enc, updated_at) VALUES (?,?,unixepoch())
     ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
    key, encrypt(value),
  );
}

export function publicSettings() {
  const have = new Set(all('SELECT key FROM settings').map((r) => r.key));
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const isSet = have.has(key);
    const v = isSet ? getSetting(key) : '';
    out[key] = {
      label: def.label, group: def.group, secret: def.secret, set: isSet,
      value: def.secret ? '' : v,
      preview: def.secret && v ? `••••••${v.slice(-4)}` : '',
    };
  }
  return out;
}
