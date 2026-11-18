import { Request } from 'express';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export interface GitHubPullRequestPayload {
  action: 'opened' | 'closed' | 'reopened' | 'synchronize' | 'edited' | string;
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    state: 'open' | 'closed';
    html_url: string;
    diff_url: string;
    user: {
      login: string;
      id: number;
    };
    base: {
      ref: string;
      sha: string;
    };
    head: {
      ref: string;
      sha: string;
    };
  };
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      login: string;
      id: number;
      type: string;
    };
    private: boolean;
    default_branch: string;
  };
  installation?: {
    id: number;
    node_id: string;
  };
  sender: {
    login: string;
    id: number;
  };
}

export interface GitHubInstallationPayload {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted' | string;
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
      type: string;
    };
  };
  repositories?: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
  }>;
}
