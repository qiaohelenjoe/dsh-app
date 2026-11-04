import type { DbPool } from '../../db/pool.js';

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  status: 'active' | 'suspended' | 'deleted';
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
  desktop_device_limit: number;
  mobile_device_limit: number;
}

export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

export interface CreateAccountInput {
  email: string;
  passwordHash: string;
  displayName: string | null;
}

export async function createAccount(pool: DbPool, input: CreateAccountInput): Promise<AccountRow> {
  try {
    const result = await pool.query<AccountRow>(
      `INSERT INTO accounts (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.email, input.passwordHash, input.displayName],
    );
    return result.rows[0] as AccountRow;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new EmailTakenError();
    throw error;
  }
}

export async function findAccountByEmail(pool: DbPool, email: string): Promise<AccountRow | null> {
  const result = await pool.query<AccountRow>('SELECT * FROM accounts WHERE email = $1 LIMIT 1', [email]);
  return result.rows[0] ?? null;
}

export async function findAccountById(pool: DbPool, accountId: string): Promise<AccountRow | null> {
  const result = await pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1 LIMIT 1', [accountId]);
  return result.rows[0] ?? null;
}

export async function updateAccountPassword(
  pool: DbPool,
  accountId: string,
  passwordHash: string,
): Promise<void> {
  await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [accountId, passwordHash]);
}

export async function markAccountLogin(pool: DbPool, accountId: string): Promise<void> {
  await pool.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [accountId]);
}
