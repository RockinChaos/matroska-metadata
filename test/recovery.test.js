import assert from 'node:assert/strict'
import test from 'node:test'
import { EbmlTagId } from '@rockinchaos/ebml-iterator'
import Metadata from '../src/index.js'

const good = Buffer.from('1f43b67594e78164a08fa1898100058068656c6c6f9b8203e8', 'hex')
const simple = Buffer.from('1f43b6758ee78164a3898100058068656c6c6f', 'hex')
const malformed = Buffer.from('1f43b67588e78100a383820000', 'hex')

function metadata(track = {}) {
  const parser = Object.assign(Object.create(Metadata.prototype), {
    destroyed: false,
    tracks: Promise.resolve([]),
    subtitleTracks: new Map([[1, { number: 1, type: 'utf8', _compressed: false, ...track }]]),
    timecodeScale: 1,
    currentClusterTimecode: 999_999,
    events: []
  })
  parser.emit = (...args) => {
    parser.events.push(args)
    return true
  }
  return parser
}

async function consume(parser, chunks, stable = false) {
  async function* source() {
    yield* chunks
  }
  const output = []
  for await (const chunk of parser.parseStream(source(), stable)) output.push(chunk)
  await Promise.resolve()
  assert.equal(output.length, chunks.length)
  for (let i = 0; i < chunks.length; i++) assert.strictEqual(output[i], chunks[i])
  return parser.events.filter(e => e[0] === 'subtitle').map(e => e[1])
}

function warnings(parser) {
  return parser.events.filter(e => e[0] === 'warning')
}

test('ignores a false Cluster at a chunk boundary without swallowing later subtitles', async () => {
  const parser = metadata()
  const fake = Buffer.concat([Buffer.alloc(20, 0x55), Buffer.from('1f43b675ffec', 'hex')])
  const following = Buffer.concat([Buffer.from('0100000040000000', 'hex'), good])
  assert.equal((await consume(parser, [fake, following, good])).length, 2)
  assert.equal(warnings(parser).length, 0)
})

test('finds finite and unknown-size Clusters with split timestamps and CRC/other prefixes', async () => {
  const prefixes = [
    Buffer.alloc(0),
    Buffer.from('bf8400000000', 'hex'),
    Buffer.from('ec82aabb', 'hex'),
    Buffer.from('a78100ab8100', 'hex')
  ]
  for (const prefix of prefixes) {
    const wideSize = Buffer.from('0100000000000000', 'hex')
    wideSize[7] = 20 + prefix.length
    for (const size of [
      Buffer.from([0x94 + prefix.length]),
      Buffer.from([0xff]),
      wideSize,
      Buffer.from('01ffffffffffffff', 'hex')
    ]) {
      const cluster = Buffer.concat([good.subarray(0, 4), size, prefix, good.subarray(5)])
      for (let split = 1; split < cluster.length; split++) {
        const parser = metadata()
        const events = await consume(parser, [cluster.subarray(0, split), cluster.subarray(split)])
        assert.equal(events.length, 1, `prefix=${prefix.toString('hex')} size=${size.toString('hex')} split=${split}`)
        assert.equal(events[0].time, 105)
        assert.equal(warnings(parser).length, 0)
      }
      assert.equal(
        (
          await consume(
            metadata(),
            Array.from(cluster, byte => Uint8Array.of(byte))
          )
        ).length,
        1
      )
    }
  }
})

test('rejects invalid sync candidates and keeps searching within the same chunk', async () => {
  for (const hex of [
    '1f43b67500',
    '1f43b6750120010000000000',
    '1f43b67581e78100',
    '1f43b675ffe7ff',
    '1f43b675ffbf83000000e78100'
  ]) {
    const parser = metadata()
    assert.equal((await consume(parser, [Buffer.concat([Buffer.from(hex, 'hex'), good])])).length, 1)
  }
})

test('warns on malformed blocks and recovers in the same chunk or a later chunk', async () => {
  for (const chunks of [
    [Buffer.concat([malformed, good])],
    [malformed, good],
    [malformed, good.subarray(0, 2), good.subarray(2)]
  ]) {
    const parser = metadata()
    const events = await consume(parser, chunks)
    assert.equal(events.length, 1)
    assert.equal(events[0].time, 105)
    assert.equal(warnings(parser).length, 1)
    assert.match(warnings(parser)[0][1].message, /Incomplete Matroska block header/)
  }
})

test('recovers from a malformed element split across chunks, including stable file parsing', async () => {
  const parser = metadata()
  const events = await consume(parser, [malformed.subarray(0, 11), Buffer.concat([malformed.subarray(11), good])], true)
  assert.equal(events.length, 1)
  assert.equal(warnings(parser).length, 1)
})

test('recovers after established parsing, including repeated failures in one chunk', async () => {
  const parser = metadata()
  const events = await consume(parser, [good, Buffer.concat([malformed, malformed, good])])
  assert.equal(events.length, 2)
  assert.equal(warnings(parser).length, 2)
})

test('rejects oversized pending payloads immediately and resumes at the next Cluster', async () => {
  const parser = metadata()
  const oversized = Buffer.from('1f43b675ffe78100ec0100000040000000', 'hex')
  assert.equal((await consume(parser, [Buffer.concat([oversized, good])])).length, 1)
  assert.match(warnings(parser)[0][1].message, /exceeds maxBufferedBytes/)
})

test('bounds pending payloads with the configured limit', async () => {
  const parser = metadata()
  parser.maxBufferedBytes = 100
  const oversized = Buffer.from('1f43b675ffe78100ec40c8', 'hex')
  assert.equal((await consume(parser, [oversized, good])).length, 1)
  assert.match(warnings(parser)[0][1].message, /200 bytes/)
})

test('validates buffer limits before starting file reads', () => {
  for (const maxBufferedBytes of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => new Metadata(null, { maxBufferedBytes }), /positive safe integer/)
  }
})

test('does not scan inside a valid block payload', async () => {
  const parser = metadata()
  // Track 2 is a non-subtitle track. Its media payload contains a whole Cluster.
  const payload = Buffer.concat([Buffer.from([0x82, 0, 0, 0x80]), good])
  const block = Buffer.concat([Buffer.from([0xa3, 0x80 + payload.length]), payload])
  const cluster = Buffer.concat([Buffer.from('1f43b675ffe78100', 'hex'), block, good])
  assert.equal((await consume(parser, [cluster])).length, 1)
  assert.equal(warnings(parser).length, 0)
})

test('source errors still propagate instead of being misreported as decoder warnings', async () => {
  const parser = metadata()
  const error = new Error('torrent read failed')
  async function* source() {
    yield good
    throw error
  }
  await assert.rejects(
    async () => {
      for await (const _ of parser.parseStream(source())) {
        // Exhaust the source to surface its error
      }
    },
    e => e === error
  )
  assert.equal(warnings(parser).length, 0)
})

test('does not share timestamps between concurrent playback ranges', async () => {
  const parser = metadata()
  const later = Buffer.from(good)
  later[7] = 200
  async function* firstSource() {
    yield good.subarray(0, 8)
    yield good.subarray(8)
  }
  const first = parser.parseStream(firstSource())
  await first.next()
  await consume(parser, [later])
  await first.next()
  await first.next()
  assert.deepEqual(
    parser.events.filter(e => e[0] === 'subtitle').map(e => e[1].time),
    [205, 105]
  )
})

test('uses DefaultDuration in milliseconds without applying TimestampScale twice', async () => {
  const parser = metadata({ _defaultDuration: 1500 })
  parser.timecodeScale = 2
  const [subtitle] = await consume(parser, [simple])
  assert.equal(subtitle.duration, 1500)
  assert.equal(subtitle.time, 210)
})

test('reports a failed compressed subtitle without suppressing later subtitle events', async () => {
  const parser = metadata({ _compressed: true })
  assert.equal((await consume(parser, [good])).length, 0)
  assert.equal(warnings(parser).length, 1)
  parser.subtitleTracks.get(1)._compressed = false
  assert.equal((await consume(parser, [good])).length, 1)
})

test('skips missing durations with one warning per track and still emits later timed subtitles', async () => {
  const parser = metadata()
  const events = await consume(parser, [simple, simple, good])
  assert.equal(events.length, 1)
  assert.equal(events[0].duration, 1_000)
  assert.equal(warnings(parser).length, 1)
  assert.match(warnings(parser)[0][1].message, /without a finite duration on track 1/)
})

test('uses explicit BlockDuration before DefaultDuration and skips invalid durations', async () => {
  const parser = metadata({ _defaultDuration: 1500 })
  const group = duration => ({
    Children: [
      { id: EbmlTagId.Block, track: 1, value: 5, payload: Buffer.from('hello') },
      ...(duration == null ? [] : [{ id: EbmlTagId.BlockDuration, data: duration }])
    ]
  })
  await parser.handleBlockGroup(group(100), 2, 100)
  await parser.handleBlockGroup(group(undefined), 2, 100)
  await parser.handleBlockGroup(group(NaN), 2, 100)
  assert.deepEqual(
    parser.events.filter(e => e[0] === 'subtitle').map(e => e[1].duration),
    [200, 1_500]
  )
  assert.equal(warnings(parser).length, 1)
})

test('extracts track DefaultDuration from nanoseconds', async () => {
  const parser = metadata()
  parser.tracks = undefined
  parser.readSeekHeadTag = async () => ({
    Children: [
      {
        id: EbmlTagId.TrackEntry,
        Children: [
          { id: EbmlTagId.TrackType, data: 0x11 },
          { id: EbmlTagId.TrackNumber, data: 1 },
          { id: EbmlTagId.CodecID, data: 'S_TEXT/UTF8' },
          { id: EbmlTagId.DefaultDuration, data: 1_500_000_000 }
        ]
      }
    ]
  })
  assert.equal((await parser.getTracks())[0]._defaultDuration, 1_500)
})
