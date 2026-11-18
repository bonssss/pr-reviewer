import { Router } from 'express';
import { RepositoryController } from './repository.controller.js';
import { optionalAuthenticateToken, authenticateToken } from '../auth/auth.middleware.js';

export const repositoryRouter = Router();

// Allow reading repositories with optional auth (for public repo dashboard view), but require auth for updates
repositoryRouter.get('/', optionalAuthenticateToken, RepositoryController.getRepositories);
repositoryRouter.get('/:id', optionalAuthenticateToken, RepositoryController.getRepository);
repositoryRouter.patch('/:id', authenticateToken, RepositoryController.updateRepository);
repositoryRouter.post('/sync/:installationId', authenticateToken, RepositoryController.syncRepositories);
