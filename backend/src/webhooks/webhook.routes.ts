import { Router } from 'express';
import { WebhookHandler } from './webhook.handler.js';
import { RequestWithRawBody } from './webhook.types.js';

export const webhookRouter = Router();

webhookRouter.post('/github', (req, res) => {
  void WebhookHandler.handleWebhook(req as RequestWithRawBody, res);
});
