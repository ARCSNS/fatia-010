import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não configurada.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon exige SSL; a connection string do Neon já informa sslmode=require.
  ssl: process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: true }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool PostgreSQL:', err.message);
});
