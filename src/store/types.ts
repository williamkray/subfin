/**
 * Shared types for the store layer.
 * UserKey is the namespace boundary for multi-tenant isolation.
 */

/** Identifies a user on a specific Jellyfin backend.
 *  ALWAYS use this type — never pass subsonicUsername alone to store functions.
 *  The jellyfinUrl field is the namespace boundary between tenants. */
export interface UserKey {
  readonly subsonicUsername: string;
  readonly jellyfinUrl: string;
}

/** Runtime assertion: throws if jellyfinUrl is empty.
 *  Call at the top of every store function that accepts UserKey. */
export function assertUserKey(key: UserKey): void {
  if (!key.jellyfinUrl) {
    throw new Error(
      `BUG: UserKey missing jellyfinUrl for username "${key.subsonicUsername}". ` +
        `Every store call must include the Jellyfin server URL.`
    );
  }
}
