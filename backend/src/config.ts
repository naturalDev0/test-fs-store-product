import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: isTest
    ? required('TEST_DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/store_test')
    : required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', isTest ? 'test-secret' : undefined),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  isTest,
};
