export const RESEND_FREE_DAILY_LIMIT = 100;
export const RESEND_FREE_MONTHLY_LIMIT = 3000;

export interface ResendQuotaState {
  allowed: boolean;
  dailySent: number;
  monthlySent: number;
  retryAt: string | null;
  reason: "daily_limit" | "monthly_limit" | null;
}

export function getResendQuotaState(now: Date, dailySent: number, monthlySent: number): ResendQuotaState {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextDay = new Date(dayStart + 24 * 60 * 60 * 1000).toISOString();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const daily = Math.max(0, Math.floor(dailySent));
  const monthly = Math.max(0, Math.floor(monthlySent));
  if (monthly >= RESEND_FREE_MONTHLY_LIMIT) {
    return { allowed: false, dailySent: daily, monthlySent: monthly, retryAt: nextMonth, reason: "monthly_limit" };
  }
  if (daily >= RESEND_FREE_DAILY_LIMIT) {
    return { allowed: false, dailySent: daily, monthlySent: monthly, retryAt: nextDay, reason: "daily_limit" };
  }
  return { allowed: true, dailySent: daily, monthlySent: monthly, retryAt: null, reason: null };
}
