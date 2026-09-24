import { EbmlIteratorDecoder, EbmlTagId, EbmlTagPosition } from '@rockinchaos/ebml-iterator'
import { CLUSTER_SEARCH_BYTES, findCluster } from './cluster.js'
import { arr2text, concat } from 'uint8-util'
import 'fast-readable-async-iterator'
import { inflateSync } from 'zlib'
import Util from './util.js'

/**
 * @typedef {{
 *   number: number,
 *   language: string,
 *   type: string,
 *   _compressed: boolean,
 *   _headerStrip?: Uint8Array,
 *   _defaultDuration?: number,
 *   default: boolean,
 *   forced: boolean,
 *   name?: string,
 *   header?: string
 * }} SubtitleTrack
 */

/** @typedef {{track: number, value: number, payload: Uint8Array}} SubtitleBlock */
/** @typedef {{[key: string]: string | number | undefined, text: string, time: number, duration?: number}} Subtitle */

/** @type {number} */
const MAX_BUFFERED_BYTES = 64 * 1_024 * 1_024
/** @type {Set<string>} */
const SSA_TYPES = new Set(['ssa', 'ass'])
/** @type {string[]} */
const SSA_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text']

/**
 * @param {SubtitleTrack} track
 * @param {Uint8Array} payload
 * @returns {string}
 */
function subtitleText(track, payload) {
  /** @type {Uint8Array | string} */
  let data = /** @type {Uint8Array | string} */ (track._compressed ? inflateSync(payload) : payload)
  if (track._headerStrip) {
    if (typeof data === 'string') return arr2text(track._headerStrip) + data
    data = concat([track._headerStrip, /** @type {ArrayLike<number>} */ (data)])
  }
  return typeof data === 'string' ? data : arr2text(/** @type {Uint8Array} */ (data))
}

/**
 * @param {Subtitle} subtitle
 * @param {SubtitleTrack} track
 * @returns {void}
 */
function parseSSAFields(subtitle, track) {
  if (!SSA_TYPES.has(track.type)) return

  // extract SSA/ASS keys
  const values = subtitle.text.split(',')
  for (let i = 0; i < SSA_KEYS.length - 1; i++) {
    subtitle[SSA_KEYS[i]] = values[i]
  }
  subtitle.text = values.slice(SSA_KEYS.length - 1).join(',')
}

export default class Metadata extends Util {
  /** @type {Map<number, SubtitleTrack>} */
  subtitleTracks = new Map()
  /** @type {boolean} */
  implementsSlice = false
  /** @type {number | null} */
  timecodeScale = null
  /** @type {number | null} */
  currentClusterTimecode = null
  /** @type {boolean} */
  destroyed = false
  /** @type {Set<number> | undefined} */
  durationWarnings

  /**
   * @param {import('./util.js').MetadataFile} file
   * @param {{maxBufferedBytes?: number}} [options]
   */
  constructor(file, options = {}) {
    super()
    this.maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < 1) {
      throw new RangeError('maxBufferedBytes must be a positive safe integer')
    }
    this.file = file
    this.implementsSlice = 'slice' in file && typeof file.slice === 'function'
    this.segment = this.getSegment()
    this.seekHead = this.getSeekHead()
    this.duration = this.getDuration()
    this.tracks = this.getTracks()
  }

  /** @returns {Promise<{filename: string, mimetype: string, data: Uint8Array}[]>} */
  async getAttachments() {
    if (this.destroyed) return []
    return (
      (await this.readSeekHeadTag('Attachments'))?.Children?.filter(chunk => chunk.id === EbmlTagId.AttachedFile).map(
        (/** @type {import('@rockinchaos/ebml-iterator').EbmlMasterTag} */ chunk) => ({
          filename: this.getData(chunk, EbmlTagId.FileName),
          mimetype: this.getData(chunk, EbmlTagId.FileMimeType),
          data: this.getData(chunk, EbmlTagId.FileData)
        })
      ) || []
    )
  }

  /** @returns {Promise<SubtitleTrack[]>} */
  async getTracks() {
    if (this.destroyed) return []
    if (this.tracks) return await this.tracks

    const Tracks =
      (await this.readSeekHeadTag('Tracks')) || (await this.readUntilTag(this.getFileStream(this.segmentStart), EbmlTagId.Tracks))
    if (this.destroyed || !Tracks?.Children?.length) return []

    for (const entry of Tracks.Children.filter(c => c.id === EbmlTagId.TrackEntry)) {
      // Skip non subtitle tracks
      if (this.getData(entry, EbmlTagId.TrackType) !== 0x11) continue

      const codecID = this.getData(entry, EbmlTagId.CodecID) || ''
      let type
      if (codecID === 'S_ASS') {
        type = 'ass'
      } else if (codecID === 'S_SSA') {
        type = 'ssa'
      } else if (codecID.startsWith('S_TEXT/')) {
        type = codecID.substring(7).toLowerCase()
      }

      if (type) {
        const header = this.getData(entry, EbmlTagId.CodecPrivate)
        const defaultDuration = this.getData(entry, EbmlTagId.DefaultDuration)
        const encoding = entry.Children?.find(c => c.id === EbmlTagId.ContentEncodings)?.Children?.find(
          c => c.id === EbmlTagId.ContentEncoding
        )
        const compression = this.getChild(encoding, EbmlTagId.ContentCompression)
        const compressionAlgorithm = this.getData(compression, EbmlTagId.ContentCompAlgo) ?? 0
        const compressionScope = this.getData(encoding, EbmlTagId.ContentEncodingScope) ?? 1
        const compressionAppliesToBlocks = Boolean(compressionScope & 1)
        const track = {
          number: this.getData(entry, EbmlTagId.TrackNumber),
          language: this.getData(entry, EbmlTagId.Language) ?? 'eng',
          type,
          default: Boolean(this.getData(entry, EbmlTagId.FlagDefault) ?? 1),
          forced: Boolean(this.getData(entry, EbmlTagId.FlagForced) ?? 0),
          name: this.getData(entry, EbmlTagId.Name),
          header: header ? arr2text(header) : undefined,
          _defaultDuration: Number.isFinite(defaultDuration) && defaultDuration > 0 ? defaultDuration / 1_000_000 : undefined,
          // Matroska defaults ContentCompAlgo to zlib (0). Algorithm 3 is
          // header stripping, which prepends ContentCompSettings instead.
          _compressed: Boolean(compressionAppliesToBlocks && compression && compressionAlgorithm === 0),
          _headerStrip:
            compressionAppliesToBlocks && compressionAlgorithm === 3
              ? this.getData(compression, EbmlTagId.ContentCompSettings)
              : undefined
        }

        this.subtitleTracks.set(track.number, track)
      }
    }

    return [...this.subtitleTracks.values()]
  }

  /** @returns {Promise<{start: number, end: number, text: string | undefined, language: string | undefined}[]>} */
  async getChapters() {
    if (this.destroyed) return []
    const Chapters = await this.readSeekHeadTag('Chapters')
    if (this.destroyed) return []

    let timecodeScale = this.timecodeScale
    if (!timecodeScale) {
      timecodeScale = (await this.readUntilTag(this.getFileStream(), EbmlTagId.TimecodeScale))?.data / 1_000_000 || 1
      this.timecodeScale = timecodeScale
    }

    if (this.destroyed || !Chapters?.Children?.length) return []

    const editions = Chapters.Children.filter(c => c.id === EbmlTagId.EditionEntry)

    // https://www.matroska.org/technical/chapters.html#default-edition
    // finds first default edition, or first entry
    const defaultEdition =
      editions.find(c => {
        return c.Children.some(cc => {
          return cc.id === EbmlTagId.EditionFlagDefault && Boolean(cc.data)
        })
      }) || editions[0]

    // exclude hidden atoms
    if (!defaultEdition?.Children?.length) return []

    const atoms = defaultEdition.Children.filter(
      c => c.id === EbmlTagId.ChapterAtom && !this.getData(c, EbmlTagId.ChapterFlagHidden)
    )

    const chapters = []
    for (let i = atoms.length - 1; i >= 0; --i) {
      const start = this.getData(atoms[i], EbmlTagId.ChapterTimeStart) / 1_000_000
      const end =
        this.getData(atoms[i], EbmlTagId.ChapterTimeEnd) / 1_000_000 ||
        chapters[i + 1]?.start ||
        ((await this.duration) || 0) * timecodeScale
      const display = this.getChild(atoms[i], EbmlTagId.ChapterDisplay)
      chapters[i] = {
        start,
        end,
        text: this.getData(display, EbmlTagId.ChapString),
        language: this.getData(display, EbmlTagId.ChapLanguage)
      }
    }

    return chapters
  }

  /** @returns {Promise<number | undefined>} */
  async getDuration() {
    if (this.duration) return this.duration
    const Info =
      (await this.readSeekHeadTag('Info')) || (await this.readUntilTag(this.getFileStream(this.segmentStart), EbmlTagId.Info))

    if (this.destroyed || !Info?.Children?.length) return undefined
    const timecodeScale = this.getData(Info, EbmlTagId.TimecodeScale)
    if (timecodeScale) this.timecodeScale = timecodeScale / 1_000_000
    const Duration = this.getChild(Info, EbmlTagId.Duration)
    return Duration?.data
  }

  /**
   * @param {import('@rockinchaos/ebml-iterator').EbmlMasterTag} chunk
   * @param {number} timecodeScale
   * @param {number | null} currentClusterTimecode
   */
  async handleBlockGroup(chunk, timecodeScale, currentClusterTimecode) {
    if (this.destroyed) return
    await this.tracks
    if (this.destroyed) return

    const block = /** @type {import('@rockinchaos/ebml-iterator').Block | undefined} */ (this.getChild(chunk, EbmlTagId.Block))
    if (block && this.subtitleTracks.has(block.track)) {
      const blockDuration = this.getData(chunk, EbmlTagId.BlockDuration)
      const track = this.subtitleTracks.get(block.track)

      if (!track) return
      const duration = this.subtitleDuration(track, blockDuration, timecodeScale)
      if (duration == null) return

      /** @type {Subtitle} */
      const subtitle = {
        text: subtitleText(track, block.payload),
        time: (block.value + (currentClusterTimecode || 0)) * timecodeScale,
        duration
      }

      parseSSAFields(subtitle, track)
      this.emit('subtitle', subtitle, block.track)
    }
  }

  /**
   * @param {AsyncIterable<Uint8Array>} stream
   * @param {boolean} [stable=false]
   */
  async *parseStream(stream, stable = false) {
    const createDecoder = () =>
      new EbmlIteratorDecoder({
        bufferTagIds: [EbmlTagId.TimecodeScale, EbmlTagId.BlockGroup, EbmlTagId.SimpleBlock, EbmlTagId.Timecode]
      })
    let decoder = createDecoder()

    let timecodeScale = this.timecodeScale || 1
    // Each playback range owns its timestamp; other iterators may run concurrently
    let currentClusterTimecode = null

    const tagMap = {
      [EbmlTagId.Cluster]: tag => {
        if (tag.position === EbmlTagPosition.Start) currentClusterTimecode = null
      },
      // Segment Information
      [EbmlTagId.TimecodeScale]: tag => {
        this.timecodeScale = timecodeScale = tag.data / 1_000_000
      },
      // Assumption: This is a Cluster `Timecode`
      [EbmlTagId.Timecode]: tag => {
        this.currentClusterTimecode = currentClusterTimecode = tag.data
      },
      [EbmlTagId.BlockGroup]: data => this.handleBlockGroup(data, timecodeScale, currentClusterTimecode),
      [EbmlTagId.SimpleBlock]: block => this.handleBlock(block, timecodeScale, currentClusterTimecode)
    }

    const handleTag = tag => {
      const handler = tagMap[tag.id]
      if (!handler) return
      void Promise.resolve(handler(tag)).catch(error => {
        if (!this.destroyed) this.emit('warning', error, tag)
      })
    }

    let buffer = new Uint8Array(0)
    for await (const chunk of stream) {
      let input = stable ? chunk : concat([buffer, chunk])
      let searchStart = 0
      while (true) {
        if (!stable) {
          const start = findCluster(input, searchStart)
          if (start < 0) {
            // Uint8Array.from also copies Buffer views before forwarding the chunk
            buffer = Uint8Array.from(input.subarray(-CLUSTER_SEARCH_BYTES))
            break
          }
          decoder = createDecoder()
          currentClusterTimecode = null
          input = input.subarray(start)
          buffer = new Uint8Array(0)
          stable = true
        }
        try {
          for (const tag of decoder.parseTags(input)) handleTag(tag)
          const pending = decoder.readTagHeader(decoder.buffer)
          if (pending && pending.size > (this.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) {
            throw new Error(`EBML element ${pending.id.toString(16)} exceeds maxBufferedBytes (${pending.size} bytes)`)
          }
          break
        } catch (error) {
          if (!this.destroyed) this.emit('warning', error)
          // The decoder retains the failing element and any following bytes
          // Retry later Clusters in those bytes, including in the same chunk
          input = Uint8Array.from(decoder.buffer)
          stable = false
          currentClusterTimecode = null
          searchStart = 1
        }
      }
      yield chunk
      if (this.destroyed) return null
    }
  }

  /**
   * @param {SubtitleBlock} block
   * @param {number} timecodeScale
   * @param {number | null} currentClusterTimecode
   */
  async handleBlock(block, timecodeScale, currentClusterTimecode) {
    if (this.destroyed) return
    await this.tracks
    if (this.destroyed || !this.subtitleTracks.has(block.track)) return

    const track = this.subtitleTracks.get(block.track)
    if (!track) return
    const duration = this.subtitleDuration(track, undefined, timecodeScale)
    if (duration == null) return

    /** @type {Subtitle} */
    const subtitle = {
      text: subtitleText(track, block.payload),
      time: (block.value + (currentClusterTimecode || 0)) * timecodeScale,
      duration
    }

    parseSSAFields(subtitle, track)
    this.emit('subtitle', subtitle, block.track)
  }

  /**
   * @param {SubtitleTrack} track
   * @param {number | undefined} blockDuration
   * @param {number} timecodeScale
   * @returns {number | undefined}
   */
  subtitleDuration(track, blockDuration, timecodeScale) {
    const duration = blockDuration == null ? track._defaultDuration : blockDuration * timecodeScale
    if (Number.isFinite(duration) && duration >= 0) return duration
    this.durationWarnings ??= new Set()
    if (!this.durationWarnings.has(track.number)) {
      this.durationWarnings.add(track.number)
      this.emit('warning', new Error(`Skipping subtitle without a finite duration on track ${track.number}`))
    }
  }

  // noinspection JSUnusedGlobalSymbols
  /** @returns {Promise<void | null>} */
  async parseFile() {
    for await (const _ of this.parseStream(this.getFileStream(), true)) {
      if (this.destroyed) return null
    }
  }

  // noinspection JSUnusedGlobalSymbols
  /** @returns {void} */
  destroy() {
    this.destroyed = true
  }
}
