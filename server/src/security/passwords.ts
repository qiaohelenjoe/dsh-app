import { readFileSync } from 'node:fs';
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/** 规格 §11：密码 ≥10 位。 */
export const MIN_PASSWORD_LENGTH = 10;

// 规格 §11：argon2id，m=64MiB，t=3，p=4
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

const weakListCache = new Map<string, Set<string>>();

function loadWeakPasswords(listPath: string): Set<string> {
  const cached = weakListCache.get(listPath);
  if (cached) return cached;

  let list = new Set<string>();
  try {
    const raw = readFileSync(listPath, 'utf8');
    list = new Set(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0),
    );
  } catch (error) {
    console.warn(`[security] 无法读取弱口令列表 ${listPath}：${(error as Error).message}`);
  }
  weakListCache.set(listPath, list);
  return list;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** 密码是否过弱：长度不足，或命中前 10 万弱口令列表（大小写不敏感）。 */
export function isWeakPassword(password: string, weakPasswordListPath: string): boolean {
  if (password.length < MIN_PASSWORD_LENGTH) return true;
  return loadWeakPasswords(weakPasswordListPath).has(password.trim().toLowerCase());
}
