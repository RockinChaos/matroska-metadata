import { EbmlTagId, Tools } from '@rockinchaos/ebml-iterator'

/** @type {number} Bound the bytes retained while acquiring a Cluster after a seek or error */
export const CLUSTER_SEARCH_BYTES = 64 * 1_024
/** @type {Set<number>} */
const PREFIX_TAGS = new Set([
  EbmlTagId.CRC32, EbmlTagId.Void, EbmlTagId.Position,
  EbmlTagId.PrevSize, EbmlTagId.SilentTracks
])

/**
 * @param {Uint8Array} data
 * @param {number} [start=0]
 * @returns {number}
 */
export function findCluster(data, start = 0) {
  for (let i = start; i + 4 < data.length; i++) {
    if (data[i] !== 0x1f || data[i + 1] !== 0x43 || data[i + 2] !== 0xb6 || data[i + 3] !== 0x75) continue
    try {
      const size = Tools.readVint(data, i + 4)
      if (!size) continue
      let offset = i + 4 + size.length
      const end = size.value === -1 ? Infinity : offset + size.value
      const limit = Math.min(data.length, end, i + CLUSTER_SEARCH_BYTES)
      while (offset < limit) {
        const tag = Tools.readVint(data, offset)
        if (!tag || tag.length > 4) break
        const length = Tools.readVint(data, offset + tag.length)
        if (!length || length.value < 0) break
        let id = 0
        for (let j = offset; j < offset + tag.length; j++) id = id * 256 + data[j]
        const next = offset + tag.length + length.length + length.value
        if (next > limit) break
        if (id === EbmlTagId.Timecode) {
          if (length.value <= 8) return i
          break
        }
        if (!PREFIX_TAGS.has(id)) break
        if (id === EbmlTagId.CRC32 && length.value !== 4) break
        if ((id === EbmlTagId.Position || id === EbmlTagId.PrevSize) && length.value > 8) break
        offset = next
      }
    } catch {
      // Invalid VINTs in arbitrary range data are not decoder failures
    }
  }
  return -1
}
