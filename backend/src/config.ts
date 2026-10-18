import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const isTest = process.env.NODE_ENV === 'test';

// Amounts are stored as integer cents, so only currencies with 2 decimal
// places are allowed (not, for example, JPY with none).
const SUPPORTED_CURRENCIES = ['SGD', 'USD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

function storeCurrency(): Currency {
  const value = (process.env.STORE_CURRENCY ?? 'SGD').toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(value)) {
    throw new Error(`STORE_CURRENCY must be one of ${SUPPORTED_CURRENCIES.join(', ')}, got "${value}"`);
  }
  return value as Currency;
}

/** Throws a RangeError for an invalid tag such as "en_SG", and normalises case ("en-sg" → "en-SG"). */
const storeLocale = () => Intl.getCanonicalLocales(process.env.STORE_LOCALE ?? 'en-SG')[0];

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: isTest
    ? required('TEST_DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/store_test')
    : required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', isTest ? 'test-secret' : undefined),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  // The currency product prices are in, recorded on every order. The locale
  // only controls how amounts are displayed.
  store: { currency: storeCurrency(), locale: storeLocale() },
  isTest,
};
