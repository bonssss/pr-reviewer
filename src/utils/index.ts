// Shared utility helpers
export function sanitizeLog(text: string): string {
  // Strip potential auth secrets or private tokens from log messages
  return text.replace(/(ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{32,})/g, '***REDACTED***');
}
