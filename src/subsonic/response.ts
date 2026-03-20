/**
 * OpenSubsonic response envelope and helpers.
 *
 * We report the latest recommended Subsonic REST version so that
 * modern clients enable full OpenSubsonic features (including token
 * (t/s) authentication) while still remaining compatible with older
 * Subsonic-only clients.
 */

export const VERSION = "1.16.1";         // Subsonic API version
export const SERVER_VERSION = "0.2.1";   // Subfin software version

export interface SubsonicError {
  code: number;
  message: string;
}

export function ok<T>(payload: T, format: "json" | "xml" = "json"): T {
  return payload;
}

export function subsonicEnvelope<T>(payload: T): Record<string, unknown> {
  return {
    "subsonic-response": {
      status: "ok",
      version: VERSION,
      type: "subfin",
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      ...payload,
    },
  };
}

export function subsonicError(code: number, message: string): Record<string, unknown> {
  return {
    "subsonic-response": {
      status: "failed",
      version: VERSION,
      error: { code, message },
    },
  };
}

export const ErrorCode = {
  Generic: 0,
  RequiredParameterMissing: 10,
  ClientUpgrade: 20,
  ServerDown: 30,
  WrongCredentials: 40,
  TokenAuthNotSupported: 41,
  NotLicensed: 50,
  TrialExpired: 60,
  NotFound: 70,
} as const;
