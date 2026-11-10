import { EbmlTagId } from '@rockinchaos/ebml-iterator'
import { createReadStream, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'
import EventEmitter from 'node:events'
import Metadata from '../src/index.js'
import Util from '../src/util.js'
import path from 'node:path'
import test from 'node:test'

/** @typedef {Awaited<ReturnType<Metadata['getTracks']>>[number]} SubtitleTrack */
/** @typedef {NonNullable<Awaited<ReturnType<Util['readUntilTag']>>>} DecodedTag */

class FileLike extends EventEmitter {
  /** @param {string} filename */
  constructor(filename) {
    super()
    this.filename = filename
    this.name = path.basename(filename)
  }

  /**
   * @param {{start?: number}} [options]
   * @returns {AsyncIterator<Uint8Array>}
   */
  [Symbol.asyncIterator](options = {}) {
    return /** @type {AsyncIterator<Uint8Array>} */ (
      createReadStream(this.filename, { start: options.start || 0 })[Symbol.asyncIterator]()
    )
  }
}

const mediaDirectory = path.resolve('media')
const mediaFiles = readdirSync(mediaDirectory)
  .filter(filename => /\.(mkv|webm)$/i.test(filename))
  .sort()

/**
 * @param {Partial<SubtitleTrack>} [overrides]
 * @returns {SubtitleTrack}
 */
function createSubtitleTrack(overrides = {}) {
  return {
    number: 1,
    language: 'eng',
    type: 'utf8',
    default: true,
    forced: false,
    _compressed: false,
    _defaultDuration: 1_000,
    ...overrides
  }
}

/**
 * @param {*} metadata
 * @param {unknown[][]} emitted
 */
function captureEmits(metadata, emitted) {
  metadata.emit = (...args) => {
    emitted.push(args)
    return true
  }
}

/**
 * @returns {AsyncGenerator<Uint8Array>}
 */
function createStream() {
  return (async function* () {})()
}

/**
 * @param {DecodedTag | null | undefined} result
 * @returns {(tag: string) => Promise<DecodedTag | null | undefined>}
 */
function readSeekHeadTag(result) {
  return async _tag => result
}

/**
 * @param {DecodedTag | null} result
 * @param {(stream: AsyncIterable<Uint8Array>, tagId: number, bufferTag: boolean) => void} [onRead]
 * @returns {(stream: AsyncIterable<Uint8Array>, tagId: number, bufferTag: boolean) => Promise<DecodedTag | null>}
 */
function readUntilTag(result, onRead) {
  return async (stream, tagId, bufferTag) => {
    onRead?.(stream, tagId, bufferTag)
    return result
  }
}

test('skips MP4 metadata and forwards playback chunks without parsing them', async () => {
  const mp4 = Buffer.from('0000001c6674797069736f6d0000000169736f6d6176633169736f36', 'hex')
  let requests = 0
  let closed = false
  const file = {
    async *[Symbol.asyncIterator]() {
      requests++
      try {
        await new Promise(resolve => setImmediate(resolve))
        yield mp4
        throw new Error('Unsupported files should not be read past the first chunk')
      } finally {
        closed = true
      }
    }
  }
  const metadata = new Metadata(file)
  const emitted = []
  captureEmits(metadata, emitted)

  // Embedded Cluster bytes in another container must not be decoded as subtitles.
  const cluster = Buffer.from('1f43b67588e78100a383820000', 'hex')
  const chunks = [mp4, cluster]
  for (const stable of [false, true]) {
    async function* stream() {
      yield* chunks
    }
    const forwarded = []
    for await (const chunk of metadata.parseStream(stream(), stable)) forwarded.push(chunk)
    assert.equal(forwarded.length, chunks.length)
    for (let i = 0; i < chunks.length; i++) assert.strictEqual(forwarded[i], chunks[i])
  }
  assert.deepEqual(
    await Promise.all([
      metadata.segment,
      metadata.seekHead,
      metadata.duration,
      metadata.tracks,
      metadata.getChapters(),
      metadata.getAttachments()
    ]),
    [undefined, null, undefined, [], [], []]
  )
  assert.equal(requests, 1)
  assert.equal(closed, true)
  assert.deepEqual(emitted, [])
})

test('handles empty, truncated, and unsupported headers in Blobs and split streams', async () => {
  for (const hex of ['', '00', '1a', '1a45', '1a45df', '1a00', '1a4500', '1a45df00']) {
    const input = Buffer.from(hex, 'hex')
    const file = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(0)
        for (const byte of input) {
          yield Uint8Array.of(byte)
          yield new Uint8Array(0)
        }
      }
    }
    for (const source of [file, new Blob([input])]) {
      const metadata = new Metadata(source)
      assert.deepEqual(
        await Promise.all([
          metadata.segment,
          metadata.seekHead,
          metadata.duration,
          metadata.tracks,
          metadata.getChapters(),
          metadata.getAttachments()
        ]),
        [undefined, null, undefined, [], [], []],
        hex
      )
    }
  }
})

test('preserves the EBML header and Segment offset across split chunks', async () => {
  const input = Buffer.from('1a45dfa3801853806780', 'hex')
  for (const chunkSize of [1, 2, 3, 4, input.length]) {
    const file = {
      async *[Symbol.asyncIterator]({ start = 0 } = {}) {
        yield new Uint8Array(0)
        for (let offset = start; offset < input.length; offset += chunkSize) {
          yield input.subarray(offset, offset + chunkSize)
        }
      }
    }
    for (const source of [file, new Blob([input])]) {
      const metadata = new Metadata(source)
      const [segment, seekHead, duration, tracks] = await Promise.all([
        metadata.segment,
        metadata.seekHead,
        metadata.duration,
        metadata.tracks
      ])
      assert.equal(segment.id, EbmlTagId.Segment)
      assert.equal(segment.absoluteStart, 5)
      assert.equal(metadata.segmentStart, 10)
      assert.deepEqual(seekHead, {})
      assert.equal(duration, undefined)
      assert.deepEqual(tracks, [])
    }
  }
})

test('continues to reject source errors and malformed EBML', async () => {
  const error = new Error('torrent read failed')
  const file = {
    async *[Symbol.asyncIterator]() {
      yield Uint8Array.of(0x1a)
      throw error
    }
  }
  for (const source of [file, new Blob([Buffer.from('1a45dfa38000', 'hex')])]) {
    const metadata = new Metadata(source)
    const results = await Promise.allSettled([metadata.segment, metadata.seekHead, metadata.duration, metadata.tracks])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      if (source === file) assert.strictEqual(result.reason, error)
      else assert.match(result.reason.message, /Unrepresentable length: Infinity/)
    }
  }
})

test('loads indexed tags from their seek-head offset', async () => {
  /** @type {DecodedTag} */
  const expected = { id: EbmlTagId.Info, absoluteStart: 0, tagHeaderLength: 0 }
  const infoStream = createStream()
  let requestedStart
  let readCount = 0
  // noinspection JSUnusedGlobalSymbols
  const metadata = {
    seekHead: Promise.resolve({ Info: { data: 42 } }),
    segmentStart: 100,
    tagCache: {},
    getFileStream: start => {
      requestedStart = start
      return infoStream
    },
    readUntilTag: readUntilTag(expected, (stream, tagId) => {
      readCount++
      assert.equal(stream, infoStream)
      assert.equal(tagId, EbmlTagId.Info)
    })
  }

  const result = await Util.prototype.readSeekHeadTag.call(metadata, 'Info')

  assert.equal(requestedStart, 142)
  assert.equal(result.absoluteStart, 142)
  assert.equal(await Util.prototype.readSeekHeadTag.call(metadata, 'Info'), expected)
  assert.equal(readCount, 1)
})

test('returns chapter timestamps in milliseconds and scales the final duration fallback', async () => {
  const chapter = (start, end) => ({
    id: EbmlTagId.ChapterAtom,
    Children: [
      { id: EbmlTagId.ChapterTimeStart, data: start },
      ...(end == null ? [] : [{ id: EbmlTagId.ChapterTimeEnd, data: end }])
    ]
  })
  // noinspection JSUnusedGlobalSymbols
  const chapters = {
    id: EbmlTagId.Chapters,
    absoluteStart: 0,
    tagHeaderLength: 0,
    Children: [
      {
        id: EbmlTagId.EditionEntry,
        Children: [chapter(5_000_000_000), chapter(8_000_000_000)]
      }
    ]
  }
  const metadata = Object.assign(Object.create(Metadata.prototype), {
    timecodeScale: 2,
    duration: Promise.resolve(6_000),
    readSeekHeadTag: readSeekHeadTag(chapters)
  })

  assert.deepEqual(await metadata.getChapters(), [
    { start: 5_000, end: 8_000, text: undefined, language: undefined },
    { start: 8_000, end: 12_000, text: undefined, language: undefined }
  ])
})

test('streams subtitle events through a WebTorrent-style iterator callback', async () => {
  const metadata = Object.create(Metadata.prototype)
  const emitted = []
  metadata.tracks = Promise.resolve([])
  metadata.subtitleTracks = new Map([[1, createSubtitleTrack()]])
  metadata.timecodeScale = 1
  metadata.currentClusterTimecode = null
  metadata.destroyed = false
  captureEmits(metadata, emitted)

  const cluster = Uint8Array.from([
    0x1f,
    0x43,
    0xb6,
    0x75,
    0x8e,
    0xe7,
    0x81,
    100,
    0xa3,
    0x89,
    0x81,
    0x00,
    0x05,
    0x80,
    ...Buffer.from('hello')
  ])
  const chunks = [cluster.slice(0, 3), cluster.slice(3)]
  async function* iterator() {
    yield* chunks
  }

  const file = new EventEmitter()
  file.on('iterator', ({ iterator }, cb) => cb(metadata.parseStream(iterator)))

  let parsedIterator
  file.emit('iterator', { iterator: iterator() }, value => {
    parsedIterator = value
  })

  const forwarded = []
  for await (const chunk of parsedIterator) forwarded.push(chunk)

  assert.deepEqual(emitted, [['subtitle', { text: 'hello', time: 105, duration: 1_000 }, 1]])
  assert.deepEqual(forwarded, chunks)
})

test('applies a non-default TimecodeScale while streaming subtitles', async () => {
  const metadata = Object.create(Metadata.prototype)
  const emitted = []
  metadata.tracks = Promise.resolve([])
  metadata.subtitleTracks = new Map([[1, createSubtitleTrack()]])
  metadata.timecodeScale = null
  metadata.currentClusterTimecode = null
  metadata.destroyed = false
  captureEmits(metadata, emitted)

  const timecodeScale = Uint8Array.of(0x2a, 0xd7, 0xb1, 0x84, 0x00, 0x1e, 0x84, 0x80)
  const cluster = Uint8Array.from([
    0x1f,
    0x43,
    0xb6,
    0x75,
    0x8e,
    0xe7,
    0x81,
    100,
    0xa3,
    0x89,
    0x81,
    0x00,
    0x05,
    0x80,
    ...Buffer.from('hello')
  ])
  async function* chunks() {
    yield Buffer.concat([timecodeScale, cluster])
  }

  for await (const _ of metadata.parseStream(chunks(), true)) {
    // Consume the stream to collect emitted subtitles
  }

  assert.equal(metadata.timecodeScale, 2)
  assert.equal(emitted[0][1].time, 210)
})

test('returns only AttachedFile entries', async () => {
  const attachment = {
    id: EbmlTagId.AttachedFile,
    Children: [
      { id: EbmlTagId.FileName, data: 'subtitle-font.ttf' },
      { id: EbmlTagId.FileMimeType, data: 'font/ttf' },
      { id: EbmlTagId.FileData, data: Uint8Array.of(1, 2, 3) }
    ]
  }
  // noinspection JSUnusedGlobalSymbols
  const attachments = {
    id: EbmlTagId.Attachments,
    absoluteStart: 0,
    tagHeaderLength: 0,
    Children: [{ id: EbmlTagId.CRC32 }, attachment]
  }
  const metadata = Object.assign(Object.create(Metadata.prototype), { readSeekHeadTag: readSeekHeadTag(attachments) })

  assert.deepEqual(await metadata.getAttachments(), [
    {
      filename: 'subtitle-font.ttf',
      mimetype: 'font/ttf',
      data: Uint8Array.of(1, 2, 3)
    }
  ])
})

test('does not emit subtitles after destruction', async () => {
  const metadata = Object.create(Metadata.prototype)
  const emitted = []
  metadata.tracks = Promise.resolve([])
  metadata.subtitleTracks = new Map([[1, createSubtitleTrack()]])
  captureEmits(metadata, emitted)
  metadata.destroy()

  await metadata.handleBlock({ track: 1, value: 0, payload: Buffer.from('ignored') }, 1, 0)

  assert.deepEqual(emitted, [])
})

test('prepends header-stripping settings to subtitle blocks', async () => {
  const metadata = Object.create(Metadata.prototype)
  const emitted = []
  metadata.destroyed = false
  metadata.tracks = Promise.resolve([])
  metadata.subtitleTracks = new Map([[1, createSubtitleTrack({ _headerStrip: Buffer.from('prefix: ') })]])
  captureEmits(metadata, emitted)

  await metadata.handleBlock({ track: 1, value: 0, payload: Buffer.from('subtitle') }, 1, 0)

  assert.equal(emitted[0][1].text, 'prefix: subtitle')
})

test('ignores compression that applies only to CodecPrivate', async () => {
  const tracks = {
    id: EbmlTagId.Tracks,
    absoluteStart: 0,
    tagHeaderLength: 0,
    Children: [
      {
        id: EbmlTagId.TrackEntry,
        Children: [
          { id: EbmlTagId.TrackType, data: 0x11 },
          { id: EbmlTagId.TrackNumber, data: 1 },
          { id: EbmlTagId.CodecID, data: 'S_TEXT/UTF8' },
          {
            id: EbmlTagId.ContentEncodings,
            Children: [
              {
                id: EbmlTagId.ContentEncoding,
                Children: [
                  { id: EbmlTagId.ContentEncodingScope, data: 2 },
                  {
                    id: EbmlTagId.ContentCompression,
                    Children: [{ id: EbmlTagId.ContentCompAlgo, data: 0 }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
  const metadata = Object.assign(Object.create(Metadata.prototype), {
    tracks: undefined,
    segmentStart: 0,
    subtitleTracks: new Map(),
    readSeekHeadTag: readSeekHeadTag(undefined),
    getFileStream: createStream,
    readUntilTag: readUntilTag(tracks)
  })

  assert.equal((await metadata.getTracks())[0]._compressed, false)
})

test('finds subtitle tracks in files without a SeekHead', async () => {
  const tracks = {
    id: EbmlTagId.Tracks,
    absoluteStart: 0,
    tagHeaderLength: 0,
    Children: [
      {
        id: EbmlTagId.TrackEntry,
        Children: [
          { id: EbmlTagId.TrackType, data: 0x11 },
          { id: EbmlTagId.TrackNumber, data: 1 },
          { id: EbmlTagId.CodecID, data: 'S_TEXT/UTF8' }
        ]
      }
    ]
  }
  let requestedStart
  // noinspection JSUnusedGlobalSymbols
  const metadata = Object.assign(Object.create(Metadata.prototype), {
    tracks: undefined,
    segmentStart: 20,
    subtitleTracks: new Map(),
    readSeekHeadTag: readSeekHeadTag(undefined),
    getFileStream: start => {
      requestedStart = start
      return createStream()
    },
    readUntilTag: readUntilTag(tracks, (_stream, tagId) => {
      assert.equal(requestedStart, 20)
      assert.equal(tagId, EbmlTagId.Tracks)
    })
  })

  assert.deepEqual(await metadata.getTracks(), [
    {
      number: 1,
      language: 'eng',
      type: 'utf8',
      default: true,
      forced: false,
      name: undefined,
      header: undefined,
      _defaultDuration: undefined,
      _compressed: false,
      _headerStrip: undefined
    }
  ])
})

test('recognizes legacy SSA codec IDs', async () => {
  const tracks = {
    id: EbmlTagId.Tracks,
    absoluteStart: 0,
    tagHeaderLength: 0,
    Children: [
      {
        id: EbmlTagId.TrackEntry,
        Children: [
          { id: EbmlTagId.TrackType, data: 0x11 },
          { id: EbmlTagId.TrackNumber, data: 1 },
          { id: EbmlTagId.CodecID, data: 'S_ASS' }
        ]
      }
    ]
  }
  // noinspection JSUnusedGlobalSymbols
  const metadata = Object.assign(Object.create(Metadata.prototype), {
    tracks: undefined,
    segmentStart: 0,
    subtitleTracks: new Map(),
    readSeekHeadTag: readSeekHeadTag(undefined),
    getFileStream: createStream,
    readUntilTag: readUntilTag(tracks)
  })

  assert.equal((await metadata.getTracks())[0].type, 'ass')
})

for (const filename of mediaFiles) {
  test(`supports metadata reads and iterator replacement for ${filename}`, async () => {
    const fullPath = path.join(mediaDirectory, filename)
    const file = new FileLike(fullPath)
    const metadata = new Metadata(file)

    const [segment, seekHead, duration, tracks, chapters, attachments] = await Promise.all([
      metadata.segment,
      metadata.seekHead,
      metadata.duration,
      metadata.getTracks(),
      metadata.getChapters(),
      metadata.getAttachments()
    ])

    assert.ok(segment)
    assert.ok(seekHead)
    assert.ok(duration === undefined || typeof duration === 'number')
    assert.ok(Array.isArray(tracks))
    assert.ok(Array.isArray(chapters))
    assert.ok(Array.isArray(attachments))

    file.on('iterator', ({ iterator }, cb) => cb(metadata.parseStream(iterator)))

    let parsedIterator
    file.emit('iterator', { iterator: file[Symbol.asyncIterator]() }, value => {
      parsedIterator = value
    })

    let byteLength = 0
    for await (const chunk of parsedIterator) byteLength += chunk.length
    assert.ok(byteLength > 0)
  })
}
