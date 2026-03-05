/**
 * OpenSubsonic response envelope and helpers.
 *
 * Note: We intentionally report a REST version below 1.14.0 so that
 * older Subsonic clients like DSub do not enable token (t/s) auth,
 * which we don't currently support.
 */

export const VERSION = "1.13.0";

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
