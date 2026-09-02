import { inflate } from 'pako'

// noinspection JSUnusedGlobalSymbols
/**
 * @param {Uint8Array} buffer
 * @returns {string}
 */
export const inflateSync = buffer => inflate(buffer, { toText: true })