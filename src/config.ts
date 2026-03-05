/**
 * Configuration: optional JSON file (subfin.config.json or SUBFIN_CONFIG) + env overlay.
 * All settings, including SUBFIN_SALT for DB encryption, can come from file or env.
 */
import { getConfig } from "./config/load.js";

export const config = getConfig();
export { getConfig } from "./config/load.js";
export type { Config, JellyfinConfig } from "./config/load.js";
