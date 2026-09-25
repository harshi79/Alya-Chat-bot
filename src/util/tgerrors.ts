/** Classify Telegram Bot API failures (grammY GrammyError / HttpError). */
import { GrammyError, HttpError } from 'grammy';

export function tgDescription(err: unknown): string {
  if (err instanceof GrammyError) return err.description ?? err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function tgCode(err: unknown): number | undefined {
  return err instanceof GrammyError ? err.error_code : undefined;
}

export function retryAfterSec(err: unknown): number | undefined {
  if (err instanceof GrammyError) {
    const ra = err.parameters?.retry_after;
    if (typeof ra === 'number') return ra;
    if (err.error_code === 429) return 3;
  }
  return undefined;
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 429;
}

export function isNotModified(err: unknown): boolean {
  return /message is not modified/i.test(tgDescription(err));
}

/** The method itself does not exist on this Bot API server (old self-hosted server). */
export function isUnknownMethod(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  return err.error_code === 404 || /method not found|not found/i.test(err.description ?? '');
}

/** A definite rejection of the payload (safe to try a different format — nothing was delivered). */
export function isDefinitiveRejection(err: unknown): boolean {
  return err instanceof GrammyError && (err.error_code === 400 || err.error_code === 404 || err.error_code === 406);
}

/** Delivery outcome unknown — never blindly resend. */
export function isUnknownOutcome(err: unknown): boolean {
  if (err instanceof HttpError) return true;
  return err instanceof GrammyError && (err.error_code >= 500 || err.error_code === 429);
}

export function isBlockedByUser(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 403;
}

export function isEffectInvalid(err: unknown): boolean {
  return /EFFECT_ID_INVALID|effect/i.test(tgDescription(err)) && tgCode(err) === 400;
}

export function isReplyNotFound(err: unknown): boolean {
  return /message to be replied not found|replied message not found|REPLY_MESSAGE_ID_INVALID/i.test(tgDescription(err));
}

export function isThreadNotFound(err: unknown): boolean {
  return /thread not found|TOPIC_(ID_)?INVALID|message thread not found/i.test(tgDescription(err));
}
