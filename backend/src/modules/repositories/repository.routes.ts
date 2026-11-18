import { Router } from 'express';
import { RepositoryController } from './repository.controller.js';
import {
  authenticateToken,
  requireInstallationAccess,
  requireRepositoryAccess,
} from '../auth/auth.middleware.js';
import { asyncHandler } from '../../utils/errors.js';

export const repositoryRouter = Router();

// Every repository endpoint is tenant scoped: no session, no data.
repositoryRouter.use(authenticateToken);

repositoryRouter.get(
  '/',
  asyncHandler(async (req, res) => RepositoryController.getRepositories(req, res))
);

repositoryRouter.post(
  '/sync/:installationId',
  requireInstallationAccess,
  asyncHandler(async (req, res) => RepositoryController.syncRepositories(req, res))
);

repositoryRouter.get(
  '/:id',
  requireRepositoryAccess,
  asyncHandler(async (req, res) => RepositoryController.getRepository(req, res))
);

repositoryRouter.patch(
  '/:id',
  requireRepositoryAccess,
  asyncHandler(async (req, res) => RepositoryController.updateRepository(req, res))
);
