export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAIL_STORAGE: KVNamespace;
  RESEND_API_KEY?: string;
  CONTROL_PLANE_URL?: string;
  CONTROL_PLANE_SERVICE?: Fetcher;
  INSTALLATION_ID?: string;
  RESEND_RELAY_TOKEN?: string;
  RESEND_WEBHOOK_SECRET?: string;
  MAINTENANCE_TOKEN?: string;
  BOOTSTRAP_TOKEN?: string;
  TOTP_ENCRYPTION_KEY?: string;
  APP_NAME: string;
  ENVIRONMENT: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  isSuperadmin: boolean;
  mfaVerified: boolean;
}

export interface AppVariables {
  user: AuthenticatedUser;
  hostCompanyId: string | null;
}
