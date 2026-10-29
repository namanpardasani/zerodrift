import pino, { type DestinationStream, type Logger } from 'pino';

/**
 * Paths whose values are replaced with "[REDACTED]" wherever they appear in a log object, even if a
 * caller passes them by accident. Logs go to files/aggregators many people can read: they must never
 * contain credentials or webhook secrets.
 */
export const REDACT_PATHS = [
  'authorization',
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'signature',
  '*.authorization',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.signature',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-admin-token"]',
  'headers["zerodrift-signature"]',
];

export function createLogger(service: string, level = 'info', destination?: DestinationStream): Logger {
  return pino({ level, base: { service }, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}
