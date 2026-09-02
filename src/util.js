import { EbmlIteratorDecoder, Tools, EbmlTagId, EbmlElementType } from '@rockinchaos/ebml-iterator'
import EventEmitter from 'events'

/**
 * @typedef {{
 *   id: number,
 *   type?: number,
 *   data?: *,
 *   Children?: EbmlTag[]
 * }} EbmlTag
 */

/** @typedef {Blob | {[Symbol.asyncIterator]: (options?: {start?: number}) => AsyncIterator<Uint8Array>}} MetadataFile */
/** @typedef {EbmlTag & {absoluteStart: number, tagHeaderLength: number}} DecodedTag */
/** @typedef {Record<string, EbmlTag>} SeekHead */

export default class Util extends EventEmitter {
  /** @type {MetadataFile} */
  file
  /** @type {Promise<SeekHead | null>} */
  seekHead
  /** @type {Promise<DecodedTag | undefined>} */
  segment
  /** @type {Promise<number | undefined>} */
  duration
  /** @type {Promise<{ number: number, language: string, type: string, _compressed: boolean, default: boolean, forced: boolean, name?: string, header?: string }[]>} */
  tracks
  /** @type {number} */
  segmentStart = 0
  /** @type {Record<string, DecodedTag | undefined>} */
  tagCache = {}
  /** @type {boolean} */
  implementsSlice = false
  /** @type {boolean} */
  destroyed = false

  /**
   * @param {EbmlTag | null | undefined} chunk
   * @param {number} tag
   * @returns {EbmlTag | undefined}
   */
  getChild(chunk, tag) {
    return chunk?.Children?.find(({ id }) => id === tag)
  }

  /**
   * @param {EbmlTag | null | undefined} chunk
   * @param {number} tag
   * @returns {*}
   */
  getData(chunk, tag) {
    return this.getChild(chunk, tag)?.data
  }

  /**
   * @param {EbmlTag} tag
   * @returns {EbmlTag}
   */
  processTags(tag) {
    if (tag.data && (tag.type === EbmlElementType.String || tag.type === EbmlElementType.UTF8 || tag.type == null)) {
      tag.data = tag.data.toString()
    }
    if (tag.Children) {
      for (const child of tag.Children) {
        this.processTags(child)
      }
    }
    return tag
  }

  /**
   * @param {AsyncIterable<Uint8Array>} stream
   * @param {number} tagId
   * @param {boolean} [bufferTag=true]
   * @returns {Promise<DecodedTag | null>}
   */
  async readUntilTag(stream, tagId, bufferTag = true) {
    if (!tagId) throw new Error('tagId is required')

    const decoder = new EbmlIteratorDecoder({ stream, bufferTagIds: bufferTag ? [tagId] : [] })
    for await (const tag of decoder) {
      if (tag.id === tagId) return /** @type {DecodedTag} */ (this.processTags(/** @type {EbmlTag} */ (tag)))
    }
    return null
  }

  /**
   * @param {AsyncIterable<Uint8Array>} seekHeadStream
   * @param {number} segmentStart
   * @param {boolean} [recurse=true]
   * @returns {Promise<SeekHead | null>}
   */
  async readSeekHead(seekHeadStream, segmentStart, recurse = true) {
    const seekHead = await this.readUntilTag(seekHeadStream, EbmlTagId.SeekHead)
    if (this.destroyed) return null
    if (!seekHead) return {}

    /** @type {SeekHead} */
    const transformedHead = {}
    for (const child of seekHead.Children || []) {
      if (child.id !== EbmlTagId.Seek) continue // CRC32 elements will appear, currently we don't check them
      const seekId = this.getChild(child, EbmlTagId.SeekID)
      const seekPosition = this.getChild(child, EbmlTagId.SeekPosition)
      if (!seekId || !seekPosition) continue

      const tagName = EbmlTagId[Tools.readUnsigned(seekId.data)]
      if (tagName) transformedHead[tagName] = seekPosition
    }

    // Determines if there is a second SeekHead referenced by the first SeekHead.
    // See: https://www.matroska.org/technical/ordering.html#seekhead
    // Note: If true, the first *must* contain a reference to the second, but other tags can be in the first.
    if (transformedHead.SeekHead && recurse) {
      const seekHeadStream = this.getFileStream(segmentStart + transformedHead.SeekHead.data)
      const secondSeekHead = await this.readSeekHead(seekHeadStream, segmentStart, false)
      return { ...secondSeekHead, ...transformedHead }
    } else {
      return transformedHead
    }
  }

  /** @param {number | undefined} [start] */
  getFileStream(start) {
    // some file-likes might not implement slice: webtorrent
    // if they do not implement async iterator, error
    if (this.implementsSlice) {
      const file = /** @type {Blob} */ (this.file)
      return /** @type {AsyncIterable<Uint8Array>} */ (file.slice(start).stream())[Symbol.asyncIterator]()
    } else {
      const file = /** @type {{[Symbol.asyncIterator]: (options?: {start?: number}) => AsyncIterator<Uint8Array>}} */ (this.file)
      return file[Symbol.asyncIterator]({ start })
    }
  }

  /** @returns {Promise<DecodedTag | undefined>} */
  async getSegment() {
    if (this.segment) return await this.segment

    const segment = await this.readUntilTag(this.getFileStream(), EbmlTagId.Segment, false)
    if (!segment) return
    this.segmentStart = segment.absoluteStart + segment.tagHeaderLength
    return segment
  }

  /** @returns {Promise<SeekHead | null>} */
  async getSeekHead() {
    if (this.seekHead) return await this.seekHead

    await this.segment
    const seekHeadStream = this.getFileStream(this.segmentStart)
    return await this.readSeekHead(seekHeadStream, this.segmentStart)
  }

  /**
   * @param {string} tag
   * @returns {Promise<DecodedTag | null | undefined>}
   */
  async readSeekHeadTag(tag) {
    const seekHead = await this.seekHead
    const storedTag = tag.toLowerCase()
    if (!this.tagCache[storedTag] && seekHead?.[tag]) {
      const start = this.segmentStart + seekHead[tag].data
      const stream = this.getFileStream(start)
      const child = await this.readUntilTag(stream, EbmlTagId[tag])
      if (!child) return null
      child.absoluteStart = start
      this.tagCache[storedTag] = child

      return this.tagCache[storedTag]
    }
    return this.tagCache[storedTag]
  }
}