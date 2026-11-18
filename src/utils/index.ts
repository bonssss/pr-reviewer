export * from './diff.parser.js';

export function sanitizeLog(text: string): string {
  return text.replace(/(ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{32,})/g, '***REDACTED***');
}
