import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../log.js';

export interface CachedRefreshTokenPayload {
  refreshToken: string;
  clientId: string;
  tokenUrl: string;
  savedAt: number;
}

export interface TokenCacheOptions {
  clientId: string;
  tokenUrl: string;
  dir?: string;
  log?: Logger;
}

const APP_DIR_NAME = 'mcp-oauth2-proxy';
const KEY_FILENAME = 'key.bin';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export class TokenCache {
  private readonly file: string;
  private readonly dir: string;
  private readonly log?: Logger;

  constructor(opts: TokenCacheOptions) {
    this.dir = opts.dir ?? defaultConfigDir();
    this.log = opts.log;
    const id = createHash('sha256')
      .update(`${opts.clientId}|${opts.tokenUrl}`)
      .digest('hex')
      .slice(0, 16);
    this.file = join(this.dir, `${id}.json.enc`);
  }

  load(): CachedRefreshTokenPayload | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const buf = readFileSync(this.file);
      if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('cache file too short');
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const ct = buf.subarray(IV_LEN + TAG_LEN);
      const key = this.loadOrCreateKey();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      const parsed = JSON.parse(pt.toString('utf8')) as CachedRefreshTokenPayload;
      if (
        typeof parsed.refreshToken !== 'string' ||
        typeof parsed.clientId !== 'string' ||
        typeof parsed.tokenUrl !== 'string'
      ) {
        throw new Error('cache schema mismatch');
      }
      return parsed;
    } catch (err) {
      this.log?.warn({ err, file: this.file }, 'tokenCache: load failed, ignoring cache');
      return undefined;
    }
  }

  save(refreshToken: string, clientId: string, tokenUrl: string): void {
    try {
      ensureDir(this.dir);
      const key = this.loadOrCreateKey();
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const payload: CachedRefreshTokenPayload = {
        refreshToken,
        clientId,
        tokenUrl,
        savedAt: Date.now(),
      };
      const pt = Buffer.from(JSON.stringify(payload), 'utf8');
      const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
      const tag = cipher.getAuthTag();
      const out = Buffer.concat([iv, tag, ct]);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, out, { mode: 0o600 });
      renameSync(tmp, this.file);
      try {
        chmodSync(this.file, 0o600);
      } catch {
        // best-effort on Windows
      }
    } catch (err) {
      this.log?.warn({ err, file: this.file }, 'tokenCache: save failed');
    }
  }

  private loadOrCreateKey(): Buffer {
    ensureDir(this.dir);
    const keyFile = join(this.dir, KEY_FILENAME);
    if (existsSync(keyFile)) {
      const buf = readFileSync(keyFile);
      if (buf.length === KEY_LEN) return buf;
      this.log?.warn({ keyFile }, 'tokenCache: existing key has wrong length, regenerating');
    }
    const key = randomBytes(KEY_LEN);
    writeFileSync(keyFile, key, { mode: 0o600 });
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      // best-effort
    }
    return key;
  }
}

export function defaultConfigDir(): string {
  const env = process.env;
  if (env.OAUTH2_TOKEN_CACHE_DIR) return env.OAUTH2_TOKEN_CACHE_DIR;
  const plat = platform();
  if (plat === 'win32') {
    const base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, APP_DIR_NAME);
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, APP_DIR_NAME);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
