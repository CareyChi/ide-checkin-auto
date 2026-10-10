#!/usr/bin/env node
// ide-checkin v1.0.2
// Trae 签到统一携带 x-device-id (取登录态 icube-dc 设备键); 无设备头的 claim 会被服务端以 9004 参数错误拒绝
'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// --- 公共 ---
class ApiError extends Error {
  constructor(what, code, detail) {
    super(what);
    this.what = what;
    this.code = code == null ? '' : code;
    this.detail = detail || '';
  }
}

function fmtNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  return String(Math.round(n * 100) / 100);
}

function tokenCell(expMs, appCn) {
  if (!expMs) return null;
  if (expMs < Date.now()) return `已过期，请打开 ${appCn} 刷新登录态`;
  const days = ((expMs - Date.now()) / 86400000).toFixed(1);
  return `还剩 ${days} 天\n(${new Date(expMs).toLocaleString()})`;
}

function isWideCp(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += isWideCp(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function renderTable(headers, rows) {
  const grid = [headers, ...rows].map(r => r.map(c => String(c).split('\n')));
  const widths = headers.map((_, i) => Math.max(...grid.map(r => Math.max(...r[i].map(displayWidth)))));
  const border = (l, m, r) => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r;
  const line = (cells) => {
    const parts = cells.map(c => String(c).split('\n'));
    const height = Math.max(...parts.map(ls => ls.length));
    const out = [];
    for (let k = 0; k < height; k++) {
      out.push(
        '│' +
        parts
          .map((ls, i) => {
            const s = ls[k] || '';
            const pad = widths[i] - displayWidth(s);
            return ' ' + ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2)) + ' ';
          })
          .join('│') +
        '│'
      );
    }
    return out;
  };
  const dash = '│' + widths.map(w => '┄'.repeat(w + 2)).join('│') + '│';
  const out = [border('┌', '┬', '┐'), ...line(headers), border('├', '┼', '┤')];
  for (let i = 0; i < rows.length; i++) {
    if (i) out.push(dash);
    out.push(...line(rows[i]));
  }
  out.push(border('└', '┴', '┘'));
  return out.join('\n');
}

function printFailure(app, e) {
  if (e instanceof ApiError) {
    console.error(`${app}:  ${e.what}！` + (e.code !== '' ? `错误码: ${e.code}` : ''));
    if (e.detail) console.error(`详情错误信息：${e.detail}`);
  } else {
    console.error(e.message);
  }
}

function fail(app, e) {
  printFailure(app, e);
  process.exit(e instanceof ApiError ? 1 : 2);
}

// --- Trae ---
const TRAE_APP = 'Trae';
const TRAE_APP_CN = 'Trae CN';
const TRAE_HOST = 'api.trae.cn';
const TRAE_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const TRAE_CHECKIN_PATH = '/trae/api/v2/ug/checkin_credits/claim';
const TRAE_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
const TRAE_AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const TRAE_DEVICE_KEY_PREFIX = 'iCubeAuthInfo://icube-dc:';
const TRAE_REQ_SOURCE = 1;
// 业务错误码 → 提示文案 (对应客户端 pAr 映射)
const TRAE_CODE_MESSAGES = {
  1002: '暂时无法验证账号，请重新登录后再试',
  2001: '服务异常，请稍后重试',
  9004: '请求参数异常，请稍后重试',
  9090: '活动暂不可用',
  9093: '活动配置异常',
  9095: '该设备今日已参与签到',
};
const TRAE_STORAGE_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(process.env.LOCALAPPDATA || '', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), '.trae-cn', 'User', 'globalStorage', 'storage.json'),
];
const TRAE_QOE = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const TRAE_ZOE = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

function traeSha512(buf) {
  return crypto.createHash('sha512').update(buf).digest();
}

function traeDeriveAes(seed, keyLen, ivLen) {
  const pad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) pad[i] = TRAE_QOE[i] ^ TRAE_ZOE[i];
  const n = new Uint8Array(128);
  n.set(traeSha512(seed), 0);
  n.set(pad, 64);
  const c = traeSha512(n);
  n.set(c, 0);
  return { key: Buffer.from(n.slice(0, keyLen)), iv: Buffer.from(n.slice(keyLen, keyLen + ivLen)) };
}

function traeDecryptValue(b64) {
  const t = Buffer.from(b64, 'base64');
  if (!(t[0] === 116 && t[1] === 99 && t[2] === 5 && t[3] === 16 && t[4] === 0 && t[5] === 0)) {
    throw new Error('unexpected envelope header: ' + [...t.slice(0, 6)].join(','));
  }
  const { key, iv } = traeDeriveAes(t.subarray(6, 38), 16, 16);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const c = Buffer.concat([d.update(t.subarray(38)), d.final()]);
  const h = traeSha512(c.subarray(64));
  if (!h.equals(c.subarray(0, 64))) throw new Error('integrity check failed');
  return c.subarray(64).toString('utf8');
}

function traeJwtExp(token) {
  try {
    const pl = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return pl.exp ? pl.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function traeLoadAuth() {
  for (const p of TRAE_STORAGE_CANDIDATES) {
    if (!p || !fs.existsSync(p)) continue;
    let store;
    try {
      store = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const raw = store[TRAE_AUTH_KEY];
    if (!raw) continue;
    const devKey = Object.keys(store).find(k => k.startsWith(TRAE_DEVICE_KEY_PREFIX));
    const deviceId = devKey ? devKey.slice(TRAE_DEVICE_KEY_PREFIX.length) : '';
    let ui;
    try {
      ui = JSON.parse(traeDecryptValue(raw));
    } catch (e) {
      throw new Error(`解密登录态失败 (${p}): ${e.message}\n(可能 Trae 升级改了存储格式, 需要重新逆向)`);
    }
    if (!ui.token) throw new Error('登录态中没有 token, 请先在 Trae CN 中登录');
    return { token: ui.token, userId: ui.userId, username: ui.account?.username || '', expMs: traeJwtExp(ui.token), deviceId };
  }
  throw new Error('找不到 Trae 登录态 storage.json, 请确认已安装 Trae CN 并登录过');
}

function traeApi(token, method, apiPath, body, deviceId) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // 签到/额度接口必须携带设备标识, 缺失会返回业务码 9004 (请求参数异常)
    const headers = { 'Authorization': 'Cloud-IDE-JWT ' + token };
    if (deviceId) headers['x-device-id'] = deviceId;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: TRAE_HOST, path: apiPath, method, headers, timeout: 15000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(d); } catch { /* 非 JSON 时保留 null */ }
        resolve({ status: res.statusCode, data, raw: d.slice(0, 500) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function traeFetchBalance(token, deviceId) {
  const r = await traeApi(token, 'POST', TRAE_USAGE_PATH, { require_usage: true, req_source: TRAE_REQ_SOURCE }, deviceId);
  const s = r.status === 200 && r.data && r.data.usage_summary;
  return s && typeof s.total_amount === 'number' && typeof s.consumed_amount === 'number'
    ? s.total_amount - s.consumed_amount
    : null;
}

async function traeStatusData() {
  const auth = traeLoadAuth();
  const [st, balance] = await Promise.all([
    traeApi(auth.token, 'POST', TRAE_STATUS_PATH, { req_source: TRAE_REQ_SOURCE }, auth.deviceId),
    traeFetchBalance(auth.token, auth.deviceId).catch(() => null),
  ]);
  const d = st.data;
  if (st.status !== 200 || !d || d.code !== 0) {
    throw new ApiError('查询失败', d?.code ?? (st.status !== 200 ? st.status : undefined), d?.message || (st.status !== 200 ? st.raw : ''));
  }
  return {
    account: auth.username || null,
    today: d.enable === false ? '不可用' : (d.checked_in ? '已签到' : '未签到'),
    streak: null,
    balance: balance == null ? null : fmtNum(balance),
    token: tokenCell(auth.expMs, TRAE_APP_CN),
  };
}

async function traeCheckinData() {
  const auth = traeLoadAuth();
  if (auth.expMs && auth.expMs < Date.now()) {
    throw new Error(`token 已过期, 请打开 ${TRAE_APP_CN} 刷新登录态后重试`);
  }
  // 先查状态: 客户端也是「活动可用 且 今日未签到」才发起认领, 避免把已领取误判为成功
  const st = await traeApi(auth.token, 'POST', TRAE_STATUS_PATH, { req_source: TRAE_REQ_SOURCE }, auth.deviceId);
  const s = st.data;
  if (st.status !== 200 || !s || s.code !== 0) {
    throw new ApiError('查询失败', s?.code ?? (st.status !== 200 ? st.status : undefined), s?.message || (st.status !== 200 ? st.raw : ''));
  }
  if (s.enable === false) {
    throw new ApiError('签到失败', s.code, '活动暂不可用');
  }
  if (s.checked_in === true) {
    const balance = await traeFetchBalance(auth.token, auth.deviceId).catch(() => null);
    return { kind: 'already', balance, hint: '明天再来吧' };
  }
  const r = await traeApi(auth.token, 'POST', TRAE_CHECKIN_PATH, { req_source: TRAE_REQ_SOURCE }, auth.deviceId);
  const balance = await traeFetchBalance(auth.token, auth.deviceId).catch(() => null);
  const d = r.data;
  if (r.status === 200 && d && d.code === 0) {
    return { kind: 'ok', credit: typeof s.credits === 'number' ? s.credits : null, balance };
  }
  const code = d?.code ?? (r.status !== 200 ? r.status : undefined);
  if (code === 9095) {
    return { kind: 'already', balance, hint: '明天再来吧' };
  }
  throw new ApiError('签到失败', code, TRAE_CODE_MESSAGES[code] || d?.message || (r.status !== 200 ? r.raw : ''));
}

function traeLine(d) {
  const bal = fmtNum(d.balance);
  if (d.kind === 'ok') {
    return `${TRAE_APP}:  签到成功${d.credit != null ? `，增加${fmtNum(d.credit)}积分` : ''}，当前余额: ${bal}`;
  }
  return `${TRAE_APP}:  今天已经领过，明天再来吧，当前余额: ${bal}`;
}

// --- Qoder ---
const QODER_APP = 'Qoder';
const QODER_APP_CN = 'Qoder CN';
const QODER_HOST = 'openapi.qoder.com.cn';
const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
const QODER_USAGE_PATH = '/sash/api/v2/me/usage';
const QODER_SEAT_ACTIVITY_PATH = '/sash/api/v1/ai-conversations/seat-activity';
const QODER_CLIENT_TYPE = '10';
const QODER_DEFAULT_VERSION = '0.4.3';
const QODER_USER_DATA = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.qodercn.app.stable');
const QODER_AUTH_FILE = path.join(QODER_USER_DATA, 'auth.v1.dat');
const QODER_LOCAL_STATE = path.join(QODER_USER_DATA, 'Local State');

function qoderGetAesKey() {
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    `$ls=[IO.File]::ReadAllText('${QODER_LOCAL_STATE.replace(/'/g, "''")}')|ConvertFrom-Json;`,
    '$e=[Convert]::FromBase64String($ls.os_crypt.encrypted_key);',
    '$k=[Security.Cryptography.ProtectedData]::Unprotect($e[5..($e.Length-1)],$null,\'CurrentUser\');',
    '[Convert]::ToBase64String($k)',
  ].join(' ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  const b64 = out.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!b64) throw new Error('DPAPI 提取密钥失败');
  return Buffer.from(b64, 'base64');
}

function qoderLoadAuth() {
  if (!fs.existsSync(QODER_AUTH_FILE)) throw new Error(`找不到登录态文件: ${QODER_AUTH_FILE}\n请先安装并登录 Qoder CN`);
  const b = fs.readFileSync(QODER_AUTH_FILE);
  if (b.subarray(0, 3).toString() !== 'v10') throw new Error('auth.v1.dat 格式不是 v10 信封, 可能应用升级改了格式');
  const key = qoderGetAesKey();
  const nonce = b.subarray(3, 15);
  const ct = b.subarray(15);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  let pt;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    pt = Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    throw new Error('解密登录态失败 (GCM 校验不过, 密钥或文件已变化)');
  }
  const auth = JSON.parse(pt);
  if (!auth.token) throw new Error('登录态中没有 token, 请先在 Qoder CN 中登录');
  return {
    token: auth.token,
    userId: auth.user?.id || '',
    username: auth.user?.name || '',
    expMs: Date.parse(auth.expiresAt || ''),
  };
}

let QODER_VERSION = null;

function qoderAppVersion() {
  if (!QODER_VERSION) QODER_VERSION = qoderDetectVersion() || QODER_DEFAULT_VERSION;
  return QODER_VERSION;
}

function qoderReadIni(p) {
  const b = fs.readFileSync(p);
  const text = b.length >= 2 && b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8');
  return text.replace(/^\ufeff/, '');
}

function qoderVersionFromInstall(root) {
  const versionsDir = path.join(root, '.qoder-versions');
  if (!fs.existsSync(versionsDir)) return null;
  const dirs = fs.readdirSync(versionsDir).filter(d => /^\d/.test(d)).sort();
  for (const d of dirs.reverse()) {
    const mf = path.join(versionsDir, d, 'resources', 'build-manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      if (m.productVersion) return m.productVersion;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

function qoderVersionFromLauncher(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const name of ['state.ini', 'install.ini']) {
    let text;
    try {
      text = qoderReadIni(path.join(dir, name));
    } catch {
      continue;
    }
    const exe = text.match(/appExecutable=[^\r\n]*qoder-versions[\\/]([^\\/\r\n]+)/);
    if (exe) return exe[1];
    const installDir = text.match(/installDir=([^\r\n]+)/);
    if (installDir) {
      const v = qoderVersionFromInstall(installDir[1].trim());
      if (v) return v;
    }
    const tv = text.match(/targetVersion=([\d.]+)/);
    if (tv) return tv[1];
  }
  return null;
}

// 版本探测不写死盘符: 启动器 ini → 注册表 qoder-cn 协议 → 环境变量安装根 → 默认版本
function qoderDetectVersion() {
  const launchers = [];
  if (process.env.LOCALAPPDATA) launchers.push(path.join(process.env.LOCALAPPDATA, 'Qoder CN', 'Qoder CN Launcher'));
  try {
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\qoder-cn\\shell\\open\\command'], { encoding: 'utf8' });
    const m = out.match(/"([^"]+\.exe)"/);
    if (m && !launchers.includes(path.dirname(m[1]))) launchers.push(path.dirname(m[1]));
  } catch { /* 未注册 qoder-cn 协议时忽略 */ }
  for (const dir of launchers) {
    const v = qoderVersionFromLauncher(dir);
    if (v) return v;
  }
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Qoder CN'));
  if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Qoder CN'));
  if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'Qoder CN'));
  for (const root of roots) {
    const v = qoderVersionFromInstall(root);
    if (v) return v;
  }
  return null;
}

function qoderApi(token, method, apiPath, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
      'User-Agent': 'Qoder',
      'Cosy-ClientType': QODER_CLIENT_TYPE,
      'Cosy-Version': qoderAppVersion(),
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: QODER_HOST, path: apiPath, method, headers, timeout: 20000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(d); } catch { /* 非 JSON 时保留 null */ }
        resolve({ status: res.statusCode, data, raw: d.slice(0, 500) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

function qoderIsCreditsCampaign(c) {
  return c.actionType === 'CLAIM_BENEFIT' && c.benefit && c.benefit.kind === 'CREDITS';
}

async function qoderFetchBalance(token) {
  const r = await qoderApi(token, 'GET', QODER_USAGE_PATH);
  const u = r.status === 200 && r.data && r.data.qoderUsage;
  if (!u) return null;
  const q = u.userQuota && typeof u.userQuota.remaining === 'number' ? u.userQuota.remaining : 0;
  const a = u.addOnQuota && typeof u.addOnQuota.remaining === 'number' ? u.addOnQuota.remaining : 0;
  return q + a;
}

async function qoderFetchStreak(token) {
  const r = await qoderApi(token, 'GET', QODER_SEAT_ACTIVITY_PATH);
  const n = r.status === 200 && r.data ? r.data.currentConsecutiveDays : null;
  return typeof n === 'number' ? n : null;
}

async function qoderStatusData() {
  const auth = qoderLoadAuth();
  const [list, balance, streak] = await Promise.all([
    qoderApi(auth.token, 'GET', QODER_CAMPAIGNS_PATH),
    qoderFetchBalance(auth.token).catch(() => null),
    qoderFetchStreak(auth.token).catch(() => null),
  ]);
  const data = list.data;
  if (list.status !== 200 || !data) {
    throw new ApiError('查询失败', list.status, list.raw);
  }
  const campaigns = data.campaigns || [];
  const claimable = campaigns.some(c => qoderIsCreditsCampaign(c) && c.claimStatus === 'CLAIMABLE');
  const claimed = campaigns.some(c => qoderIsCreditsCampaign(c) && c.claimStatus === 'CLAIMED');
  return {
    account: auth.username || null,
    today: !claimable && claimed ? '已签到' : '未签到',
    streak: streak != null ? `${streak} 天` : null,
    balance: balance == null ? null : fmtNum(balance),
    token: tokenCell(auth.expMs, QODER_APP_CN),
  };
}

async function qoderCheckinData() {
  const auth = qoderLoadAuth();
  if (auth.expMs && auth.expMs < Date.now()) {
    throw new Error(`token 已过期, 请打开 ${QODER_APP_CN} 刷新登录态后重试`);
  }
  const list = await qoderApi(auth.token, 'GET', QODER_CAMPAIGNS_PATH);
  const data = list.status === 200 ? list.data : null;
  if (!data) {
    throw new ApiError('未知错误', list.status, list.raw);
  }
  const campaigns = data.campaigns || [];
  const target = campaigns.find(c => qoderIsCreditsCampaign(c) && c.claimStatus === 'CLAIMABLE');
  const resp = target
    ? await qoderApi(auth.token, 'POST', `${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(target.campaignId)}/claim`)
    : null;
  const balance = await qoderFetchBalance(auth.token).catch(() => null);
  if (!target) {
    if (campaigns.some(c => qoderIsCreditsCampaign(c) && c.claimStatus === 'CLAIMED')) {
      return { kind: 'already', balance, hint: '明天 10:00 (UTC+8) 再来吧' };
    }
    throw new ApiError('未知错误');
  }
  const d = resp.data;
  if (!(resp.status === 200 && d && !d.errorCode)) {
    throw new ApiError('未知错误', (d && d.errorCode) ?? (resp.status !== 200 ? resp.status : undefined), (d && d.errorMessage) || (resp.status !== 200 ? resp.raw : ''));
  }
  if (d.replayed) {
    return { kind: 'already', balance, hint: '明天 10:00 (UTC+8) 再来吧' };
  }
  return { kind: 'ok', credit: d.benefit && typeof d.benefit.amount === 'number' ? d.benefit.amount : null, balance };
}

function qoderLine(d) {
  const bal = fmtNum(d.balance);
  if (d.kind === 'ok') {
    return `${QODER_APP}:  签到成功${d.credit != null ? `，增加${fmtNum(d.credit)}积分` : ''}，当前余额: ${bal}`;
  }
  return `${QODER_APP}:  今天已经领过，明天 10:00 (UTC+8) 再来吧，当前余额: ${bal}`;
}

// --- WorkBuddy ---
const WB_APP = 'WorkBuddy';
const WB_ENDPOINT_FILE = path.join(os.homedir(), '.workbuddy', 'wbipc', 'endpoint.json');
const WB_STATUS_PATH = '/v2/billing/meter/checkin-activity-status';
const WB_CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const WB_BALANCE_PATH = '/billing/meter/get-user-resource-summary';
const WB_ACCOUNTS_PATH = '/v2/accounts';

function wbLoadAuth() {
  if (!fs.existsSync(WB_ENDPOINT_FILE)) {
    throw new Error(`找不到 WorkBuddy 本地通道配置: ${WB_ENDPOINT_FILE}\n请确认 WorkBuddy 已安装并至少运行过一次`);
  }
  const cfg = JSON.parse(fs.readFileSync(WB_ENDPOINT_FILE, 'utf8'));
  if (!cfg.endpoint || !cfg.ticket) throw new Error('endpoint.json 缺少 endpoint/ticket 字段, 可能应用升级改了格式');
  return cfg;
}

function wbSha256Hex16(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

function wbTranscript(prefix, endpoint, clientNonce, serverNonce) {
  const parts = [prefix, '1', endpoint, clientNonce, serverNonce];
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8');
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length, 0);
    bufs.push(l, b);
  }
  return Buffer.concat(bufs);
}

function wbProof(ticket, role, endpoint, clientNonce, serverNonce) {
  const prefix = role === 'server' ? 'wbipc-s' : 'wbipc-c';
  return crypto
    .createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(wbTranscript(prefix, endpoint, clientNonce, serverNonce))
    .digest('base64url');
}

class WbipcClient {
  constructor(auth) {
    this.endpoint = auth.endpoint;
    this.ticket = auth.ticket;
  }

  async connect() {
    this.clientNonce = crypto.randomBytes(32).toString('base64url');
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.channels = new Set();

    const ack = new Promise((res, rej) => {
      this._ackRes = res;
      this._ackRej = rej;
    });

    this.sock = net.connect({ path: this.endpoint });
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => this._fail(e));
    this.sock.on('close', () => this._fail(new Error('connection closed')));

    this._send({
      type: 'session_hello',
      protocol_min: 1,
      protocol_max: 1,
      client_nonce: this.clientNonce,
      ticket_id: wbSha256Hex16(this.ticket),
      client: { kind: 'user-script', id: 'ide-checkin', version: '1.0.0' },
    });

    return await ack;
  }

  _fail(err) {
    if (!this._failed) {
      this._failed = true;
      for (const p of this.pending.values()) p.rej(err);
      this.pending.clear();
      if (this._ackRej) this._ackRej(err);
    }
  }

  _send(obj) {
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(JSON.stringify(obj) + '\n');
    }
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i < 0) break;
      if (i > 1048576) return this.sock.destroy();
      const line = this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 1);
      if (!line.length) continue;
      let msg;
      try {
        msg = JSON.parse(line.toString('utf8'));
      } catch {
        continue;
      }
      this._onFrame(msg);
    }
  }

  _onFrame(msg) {
    if (msg.type === 'session_challenge') {
      const ok =
        wbProof(this.ticket, 'server', this.endpoint, this.clientNonce, msg.server_nonce) === msg.server_proof;
      if (!ok) {
        this._ackRej && this._ackRej(new Error('server proof mismatch'));
        this.sock.destroy();
        return;
      }
      this.serverNonce = msg.server_nonce;
      this._send({
        type: 'session_prove',
        client_proof: wbProof(this.ticket, 'client', this.endpoint, this.clientNonce, msg.server_nonce),
      });
      return;
    }
    if (msg.type === 'session_hello_ack') {
      this._ackRes && this._ackRes(msg);
      return;
    }
    if (msg.type === 'session_hello_error') {
      this._ackRej && this._ackRej(new Error('handshake rejected: ' + JSON.stringify(msg)));
      return;
    }
    if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message || 'rpc error');
        e.code = msg.error.code;
        e.data = msg.error.data;
        p.rej(e);
      } else {
        p.res(msg.result);
      }
    }
  }

  rpc(method, params, mode) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const frame = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      if (mode) frame.mode = mode;
      this._send(frame);
    });
  }

  async getPipe(pipe) {
    const info = await this.rpc('broker/GetPipe', { pipe });
    this.channels.add(pipe);
    return info;
  }

  async callPipe(pipe, method, params) {
    if (!this.channels.has(pipe)) await this.getPipe(pipe);
    return await this.rpc('c:' + pipe + '/' + method, params === undefined ? {} : params, 'call');
  }

  close() {
    try {
      if (this.sock) this.sock.destroy();
    } catch { /* 忽略关闭异常 */ }
  }
}

async function withWbClient(fn) {
  const client = new WbipcClient(wbLoadAuth());
  try {
    await client.connect();
  } catch (e) {
    client.close();
    throw new Error(`无法连接 WorkBuddy 本地通道（wbipc）：${e.message}\n请确认 WorkBuddy 客户端正在运行、且已登录。`);
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function wbApi(client, method, apiPath) {
  const r = await client.callPipe('wb.request', 'http.fetch', { method, path: apiPath });
  let data = null;
  if (r && typeof r.body_b64 === 'string') {
    const text = Buffer.from(r.body_b64, 'base64').toString('utf8');
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: r && r.status, data };
}

async function wbFetchAccount(client) {
  const r = await wbApi(client, 'GET', WB_ACCOUNTS_PATH);
  const list = r.status === 200 && r.data && r.data.data && r.data.data.accounts;
  const acc = (list || []).find(a => a.lastLogin) || (list || [])[0];
  return acc ? { uin: acc.uin, nickname: acc.nickname || '' } : null;
}

async function wbFetchBalance(client) {
  const r = await wbApi(client, 'POST', WB_BALANCE_PATH);
  const d = r.status === 200 && r.data && r.data.code === 0 && r.data.data;
  if (!d) return null;
  const pkgs = Array.isArray(d.Packages) ? d.Packages : [];
  let sum = 0;
  for (const p of pkgs) {
    const n = Number(p && p.CycleRemainCapacity);
    if (Number.isFinite(n) && n > 0) sum += n;
  }
  return sum;
}

async function wbStatusData(client) {
  const [st, acc, balance] = await Promise.all([
    wbApi(client, 'POST', WB_STATUS_PATH),
    wbFetchAccount(client).catch(() => null),
    wbFetchBalance(client).catch(() => null),
  ]);
  const body = st.data;
  const d = st.status === 200 && body && body.code === 0 && body.data ? body.data : null;
  if (!d) {
    throw new ApiError('查询失败', body && body.code != null ? body.code : st.status, typeof body === 'string' ? body.slice(0, 500) : (body && body.msg) || '');
  }
  return {
    account: (acc && acc.nickname) || null,
    today: d.today_checked_in ? '已签到' : '未签到',
    streak: `${d.streak_days} 天`,
    balance: balance == null ? null : fmtNum(balance),
    token: null,
  };
}

async function wbCheckinData(client) {
  const r = await wbApi(client, 'POST', WB_CHECKIN_PATH);
  const body = r.data || {};
  const balance = await wbFetchBalance(client).catch(() => null);
  if (body.code === 0) {
    const credit = body.data && body.data.credit;
    return { kind: 'ok', credit: typeof credit === 'number' ? credit : null, balance };
  }
  if (body.code === 10001) {
    return { kind: 'already', balance, hint: '明天再来吧' };
  }
  throw new ApiError('未知错误', body.code != null ? body.code : (r.status !== 200 ? r.status : undefined), typeof body === 'string' ? body.slice(0, 500) : (body && body.msg) || '');
}

function wbLine(d) {
  const bal = fmtNum(d.balance);
  if (d.kind === 'ok') {
    return `${WB_APP}:  签到成功${d.credit != null ? `，增加${fmtNum(d.credit)}积分` : ''}，当前余额: ${bal}`;
  }
  return `${WB_APP}:  今天已经领过，明天再来吧，当前余额: ${bal}`;
}

// --- 子命令 ---
function usage() {
  console.log('用法:  node ide-checkin.js <命令>');
  console.log('');
  console.log('命令:');
  console.log('  checkin | all     一键签到（Trae、Qoder、WorkBuddy）');
  console.log('  status            查看三个 IDE 的签到状态');
  console.log('  trae | tr         仅签到 Trae');
  console.log('  qoder | qd        仅签到 Qoder');
  console.log('  workbuddy | wb    仅签到 WorkBuddy');
}

async function cmdTrae() {
  try {
    console.log(traeLine(await traeCheckinData()));
  } catch (e) {
    fail(TRAE_APP, e);
  }
}

async function cmdQoder() {
  try {
    console.log(qoderLine(await qoderCheckinData()));
  } catch (e) {
    fail(QODER_APP, e);
  }
}

async function cmdWorkBuddy() {
  try {
    console.log(wbLine(await withWbClient(wbCheckinData)));
  } catch (e) {
    fail(WB_APP, e);
  }
}

const STATUS_FIELDS = [
  ['账号', 'account'],
  ['今日', 'today'],
  ['连签', 'streak'],
  ['积分', 'balance'],
  ['token 有效期', 'token'],
];

async function cmdStatus() {
  const defs = [
    [TRAE_APP, () => traeStatusData()],
    [QODER_APP, () => qoderStatusData()],
    [WB_APP, () => withWbClient(wbStatusData)],
  ];
  const results = [];
  const failures = [];
  let severity = 0;
  for (const [app, run] of defs) {
    try {
      results.push(await run());
    } catch (e) {
      results.push(null);
      failures.push([app, e]);
      severity = Math.max(severity, e instanceof ApiError ? 1 : 2);
    }
  }
  const rows = STATUS_FIELDS.map(([label, key]) => [
    label,
    ...results.map(r => (r && r[key] != null && r[key] !== '' ? String(r[key]) : '---')),
  ]);
  console.log(renderTable(['', TRAE_APP, QODER_APP, WB_APP], rows));
  for (const [app, e] of failures) printFailure(app, e);
  process.exitCode = severity;
}

async function cmdCheckinAll() {
  const defs = [
    [TRAE_APP, () => traeCheckinData()],
    [QODER_APP, () => qoderCheckinData()],
    [WB_APP, () => withWbClient(wbCheckinData)],
  ];
  const rows = [];
  let severity = 0;
  for (const [app, run] of defs) {
    try {
      const d = await run();
      const bal = d.balance == null ? '---' : fmtNum(d.balance);
      rows.push(d.kind === 'ok'
        ? [app, '签到成功', d.credit == null ? '---' : fmtNum(d.credit), bal, '---']
        : [app, '今天已经领过', '---', bal, d.hint]);
    } catch (e) {
      severity = Math.max(severity, e instanceof ApiError ? 1 : 2);
      rows.push(e instanceof ApiError
        ? [app, `${e.what}！` + (e.code !== '' ? `错误码: ${e.code}` : ''), '---', '---', e.detail ? e.detail.replace(/\n/g, ' ') : '---']
        : [app, '脚本错误', '---', '---', e.message.replace(/\n/g, ' ')]);
    }
  }
  console.log(renderTable(['IDE', '结果', '增加积分', '当前余额', '提示'], rows));
  process.exitCode = severity;
}

// --- 入口 ---
const main = async () => {
  const cmd = (process.argv[2] || '').toLowerCase();
  if (cmd === 'checkin' || cmd === 'all') await cmdCheckinAll();
  else if (cmd === 'status') await cmdStatus();
  else if (cmd === 'trae' || cmd === 'tr') await cmdTrae();
  else if (cmd === 'qoder' || cmd === 'qd') await cmdQoder();
  else if (cmd === 'workbuddy' || cmd === 'wb') await cmdWorkBuddy();
  else usage();
};

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
