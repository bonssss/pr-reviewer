import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export class WebhookVerifier {
  /**
   * Verify GitHub webhook HMAC-SHA256 signature
   *
   * @param rawBody The unparsed raw buffer of the incoming request body
   * @param signature The X-Hub-Signature-256 header value ('sha256=...')
   * @param secret Optional webhook secret (defaults to GITHUB_WEBHOOK_SECRET)
   */
  public static verifySignature(
    rawBody: Buffer | string | undefined,
    signature: string | undefined,
    secret = env.GITHUB_WEBHOOK_SECRET
  ): boolean {
    if (!signature) {
      logger.warn('Webhook verification failed: missing X-Hub-Signature-256 header');
      return false;
    }

    if (!secret || secret.trim().length === 0) {
      logger.error('Webhook verification failed: GITHUB_WEBHOOK_SECRET is not configured');
      return false;
    }

    if (!rawBody) {
      logger.warn('Webhook verification failed: empty or unparsed raw request body');
      return false;
    }

    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

    const expectedHmac = crypto.createHmac('sha256', secret);
    expectedHmac.update(bodyBuffer);
    const expectedSignature = `sha256=${expectedHmac.digest('hex')}`;

    try {
      const sigBuffer = Buffer.from(signature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (error) {
      logger.error({ error }, 'Error comparing webhook HMAC signatures');
      return false;
    }
  }

  /**
   * Helper to compute an HMAC-SHA256 signature for testing or webhook simulation
   */
  public static computeSignature(payload: string | Buffer, secret = env.GITHUB_WEBHOOK_SECRET): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }
}
